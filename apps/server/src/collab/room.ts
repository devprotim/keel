import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { DocStore } from '../store/store.ts';
import { applyMessage, encodeAwareness, encodeSyncStep1, encodeUpdate } from './protocol.ts';

/**
 * The minimum a transport must provide.
 *
 * Deliberately not the `ws` WebSocket type. The room owns non-trivial logic
 * (fan-out, presence cleanup, persistence timing) that deserves unit tests, and
 * tests should not have to stand up a real socket server to get at it.
 */
export interface Socket {
  send(data: Uint8Array): void;
  close(): void;
  readonly open: boolean;
}

export interface RoomOptions {
  persistDebounceMs: number;
  compactAfterUpdates: number;
  /** Injected for tests. Defaults to real timers. */
  now?: () => number;
}

/**
 * One collaborative document and everyone currently editing it.
 *
 * A room is authoritative only in the sense that it is the meeting point; the
 * CRDT means it never has to arbitrate. Its real jobs are relaying updates,
 * tracking presence, and making sure the document survives everyone leaving.
 */
export class Room {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  /** Each socket, mapped to the awareness client ids it introduced. */
  readonly #connections = new Map<Socket, Set<number>>();
  readonly #store: DocStore;
  readonly #options: Required<RoomOptions>;

  /** Updates accepted but not yet written to storage. */
  #pendingUpdates: Uint8Array[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #updatesSinceCompact = 0;
  #destroyed = false;
  /** Serialises flushes so two overlapping writes cannot interleave. */
  #flushChain: Promise<void> = Promise.resolve();

  private constructor(id: string, store: DocStore, options: RoomOptions) {
    this.id = id;
    this.#store = store;
    this.#options = { now: () => Date.now(), ...options };
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // The server holds no presence of its own. Without this, every room would
    // show a phantom collaborator that never moves.
    this.awareness.setLocalState(null);

    this.doc.on('update', this.#onDocUpdate);
    this.awareness.on('update', this.#onAwarenessUpdate);
  }

  /** Rebuild a room from storage: snapshot first, then the update log on top. */
  static async open(id: string, store: DocStore, options: RoomOptions): Promise<Room> {
    const room = new Room(id, store, options);
    const { snapshot, updates } = await store.load(id);

    // Loading must not be mistaken for a live edit, so it runs under a distinct
    // origin. Otherwise the first client to connect would be sent the entire
    // history back as if a peer had just typed it.
    Y.transact(
      room.doc,
      () => {
        if (snapshot) Y.applyUpdate(room.doc, snapshot, LOAD_ORIGIN);
        for (const update of updates) Y.applyUpdate(room.doc, update, LOAD_ORIGIN);
      },
      LOAD_ORIGIN,
    );

    room.#updatesSinceCompact = updates.length;
    return room;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get isEmpty(): boolean {
    return this.#connections.size === 0;
  }

  /**
   * Register a socket and start the sync handshake.
   *
   * The server speaks first, sending its state vector, because the client cannot
   * know whether this room already exists.
   */
  addConnection(socket: Socket): void {
    if (this.#destroyed) throw new Error(`room ${this.id} is destroyed`);
    this.#connections.set(socket, new Set());

    socket.send(encodeSyncStep1(this.doc));

    // Hand the newcomer everyone else's cursors immediately, so the room does not
    // look empty until the next time somebody moves their mouse.
    const peers = [...this.awareness.getStates().keys()];
    if (peers.length > 0) socket.send(encodeAwareness(this.awareness, peers));
  }

  /** Apply one inbound frame. Unknown or malformed frames are dropped, not fatal. */
  handleMessage(socket: Socket, data: Uint8Array): void {
    if (this.#destroyed) return;

    try {
      const result = applyMessage(data, this.doc, this.awareness, socket);
      if (result.channel === 'sync' && result.reply) socket.send(result.reply);
    } catch {
      // A single bad frame from one client must not take down the room for
      // everyone else. The CRDT will resynchronise on the next update.
    }
  }

  /**
   * Drop a socket and retract the presence it owned.
   *
   * Skipping the awareness cleanup is the classic bug here: the disconnected
   * user's cursor stays frozen on everyone else's canvas indefinitely.
   */
  removeConnection(socket: Socket): void {
    const owned = this.#connections.get(socket);
    if (!owned) return;

    this.#connections.delete(socket);
    if (owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...owned], LOCAL_ORIGIN);
    }
  }

  /** Relay a document update to every peer except the one that sent it. */
  readonly #onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== LOAD_ORIGIN) {
      this.#pendingUpdates.push(update);
      this.#scheduleFlush();
    }

    const message = encodeUpdate(update);
    for (const socket of this.#connections.keys()) {
      if (socket === origin) continue;
      this.#trySend(socket, message);
    }
  };

  /**
   * Relay presence changes, and remember which socket owns which client id.
   *
   * Awareness is intentionally not persisted. It describes who is looking at the
   * document right now, which is meaningless the moment the room is empty.
   */
  readonly #onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (changed.length === 0) return;

    if (isSocket(origin)) {
      const owned = this.#connections.get(origin);
      if (owned) {
        for (const clientId of changes.added) owned.add(clientId);
        for (const clientId of changes.removed) owned.delete(clientId);
      }
    }

    const message = encodeAwareness(this.awareness, changed);
    for (const socket of this.#connections.keys()) {
      if (socket === origin) continue;
      this.#trySend(socket, message);
    }
  };

  #trySend(socket: Socket, data: Uint8Array): void {
    if (!socket.open) return;
    try {
      socket.send(data);
    } catch {
      // A socket that fails mid-write is already gone. The transport's close
      // handler will remove it; forcing it here would mutate the map we are
      // iterating over.
    }
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null || this.#destroyed) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      // A background flush that rejects would otherwise surface as an unhandled
      // rejection and take the process down. The failed batch is already back in
      // #pendingUpdates, so re-arming the timer retries it rather than dropping
      // the work on the floor.
      this.flush().catch(() => {
        if (this.#pendingUpdates.length > 0) this.#scheduleFlush();
      });
    }, this.#options.persistDebounceMs);
  }

  /**
   * Write pending updates to storage, compacting when the log has grown long.
   *
   * Batched rather than written per-update: dragging one box across the canvas
   * emits an update per animation frame, and each of those is a database round
   * trip if written naively. Merging them costs one call instead of sixty.
   */
  async flush(): Promise<void> {
    const run = this.#flushChain.then(() => this.#writePending());

    // The stored chain must never be left in a rejected state. Storing `run`
    // directly would poison it: every later flush would chain off a rejected
    // promise, skip its body, and fail instantly without ever retrying, so one
    // transient database blip would permanently stop persistence for the room.
    // Swallowing here also means a background flush is never an unhandled
    // rejection, while the caller still receives the real error via `run`.
    this.#flushChain = run.catch(() => undefined);
    return run;
  }

  async #writePending(): Promise<void> {
    const batch = this.#pendingUpdates;
    if (batch.length === 0) return;
    this.#pendingUpdates = [];

    try {
      await this.#store.appendUpdate(this.id, Y.mergeUpdates(batch));
      this.#updatesSinceCompact += 1;

      if (this.#updatesSinceCompact >= this.#options.compactAfterUpdates) {
        await this.#store.compact(this.id, Y.encodeStateAsUpdate(this.doc));
        this.#updatesSinceCompact = 0;
      }
    } catch (error) {
      // Put the batch back so the next flush retries it rather than silently
      // losing work. Prepending preserves order against anything that arrived
      // while the write was in flight.
      this.#pendingUpdates = [...batch, ...this.#pendingUpdates];
      throw error;
    }
  }

  /** Flush, disconnect everyone, and release the document. */
  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;

    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }

    // Flush before tearing down listeners; the document is still intact here.
    await this.flush().catch(() => undefined);

    this.doc.off('update', this.#onDocUpdate);
    this.awareness.off('update', this.#onAwarenessUpdate);

    for (const socket of this.#connections.keys()) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
    this.#connections.clear();

    this.awareness.destroy();
    this.doc.destroy();
  }
}

/** Marks transactions that replay stored history rather than live edits. */
const LOAD_ORIGIN = Symbol('keel:load');
/** Marks server-initiated changes, so they are not attributed to any socket. */
const LOCAL_ORIGIN = Symbol('keel:local');

function isSocket(value: unknown): value is Socket {
  return typeof value === 'object' && value !== null && 'send' in value && 'open' in value;
}
