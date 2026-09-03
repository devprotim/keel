import type { DocStore } from '../store/store.ts';
import { Room, type Socket } from './room.ts';

export interface RoomManagerOptions {
  persistDebounceMs: number;
  compactAfterUpdates: number;
  /** Grace period before an empty room is evicted from memory. */
  idleMs: number;
}

/**
 * Owns the set of rooms currently resident in memory.
 *
 * Two things make this more than a Map. First, opening a room is asynchronous, so
 * two clients arriving at the same instant must not each build their own document.
 * Second, an empty room is not closed immediately: a page refresh is
 * indistinguishable from a departure, and reloading the whole document from
 * storage a half-second later is pure waste.
 */
/** Bound on re-opening a room that is evicted mid-join. */
const MAX_JOIN_ATTEMPTS = 3;

export class RoomManager {
  readonly #store: DocStore;
  readonly #options: RoomManagerOptions;

  /**
   * Keyed by room id, holding the in-flight open promise rather than the Room.
   *
   * Storing the promise is what makes concurrent opens safe: the second caller
   * awaits the same work instead of starting a duplicate.
   */
  readonly #rooms = new Map<string, Promise<Room>>();
  readonly #evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(store: DocStore, options: RoomManagerOptions) {
    this.#store = store;
    this.#options = options;
  }

  get residentCount(): number {
    return this.#rooms.size;
  }

  async get(roomId: string): Promise<Room> {
    if (this.#closed) throw new Error('room manager is closed');

    // A client arriving during the grace period reclaims the live room.
    this.#cancelEviction(roomId);

    const existing = this.#rooms.get(roomId);
    if (existing) return existing;

    const opening = Room.open(roomId, this.#store, {
      persistDebounceMs: this.#options.persistDebounceMs,
      compactAfterUpdates: this.#options.compactAfterUpdates,
    }).catch((error: unknown) => {
      // A failed open must not be cached, or every later attempt inherits the
      // failure for the lifetime of the process.
      this.#rooms.delete(roomId);
      throw error;
    });

    this.#rooms.set(roomId, opening);
    return opening;
  }

  /** Attach a socket to a room, wiring up eviction on the last departure. */
  async join(roomId: string, socket: Socket, attempt = 0): Promise<Room> {
    const room = await this.get(roomId);

    // The room can be evicted while we are awaiting the open above, which would
    // leave this socket attached to a document nobody else will ever receive.
    // Retrying re-opens it. The bound exists so a pathological eviction loop
    // fails loudly instead of recursing until the stack gives out.
    if (!this.#rooms.has(roomId)) {
      if (attempt >= MAX_JOIN_ATTEMPTS) {
        throw new Error(`room ${roomId} was evicted repeatedly while joining`);
      }
      return this.join(roomId, socket, attempt + 1);
    }

    room.addConnection(socket);
    return room;
  }

  /** Detach a socket, scheduling eviction if it was the last one. */
  async leave(roomId: string, socket: Socket): Promise<void> {
    const pending = this.#rooms.get(roomId);
    if (!pending) return;

    const room = await pending;
    room.removeConnection(socket);

    if (room.isEmpty) this.#scheduleEviction(roomId);
  }

  #scheduleEviction(roomId: string): void {
    this.#cancelEviction(roomId);

    const timer = setTimeout(() => {
      this.#evictionTimers.delete(roomId);
      void this.#evict(roomId);
    }, this.#options.idleMs);

    // An eviction timer must never be the reason the process stays alive.
    timer.unref?.();
    this.#evictionTimers.set(roomId, timer);
  }

  #cancelEviction(roomId: string): void {
    const timer = this.#evictionTimers.get(roomId);
    if (!timer) return;
    clearTimeout(timer);
    this.#evictionTimers.delete(roomId);
  }

  async #evict(roomId: string): Promise<void> {
    const pending = this.#rooms.get(roomId);
    if (!pending) return;

    const room = await pending.catch(() => null);
    // Someone reconnected between the timer firing and this line. Leave it alone.
    if (!room || !room.isEmpty) return;

    this.#rooms.delete(roomId);
    await room.destroy();
  }

  /** Flush and tear down every room. Called on shutdown. */
  async closeAll(): Promise<void> {
    this.#closed = true;

    for (const timer of this.#evictionTimers.values()) clearTimeout(timer);
    this.#evictionTimers.clear();

    const rooms = [...this.#rooms.values()];
    this.#rooms.clear();

    // settled rather than all: one room failing to flush must not abandon the
    // rest mid-shutdown.
    await Promise.allSettled(
      rooms.map(async (pending) => {
        const room = await pending.catch(() => null);
        await room?.destroy();
      }),
    );
  }
}
