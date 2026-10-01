/**
 * Persistence for collaborative documents.
 *
 * Yjs documents are stored as an append-only log of binary updates on top of an
 * optional snapshot. Appending is cheap and never conflicts, which suits a room
 * receiving updates from several peers at once. The log is periodically folded
 * back into a snapshot so that loading a long-lived room stays fast.
 */
export interface DocStore {
  /** Reported by /health, so a deploy running on the wrong store is visible. */
  readonly kind: 'memory' | 'postgres';
  /** Everything needed to rebuild a document: a base snapshot plus later updates. */
  load(roomId: string): Promise<LoadedDoc>;
  /** Append one update. Called on the hot path, so it must stay cheap. */
  appendUpdate(roomId: string, update: Uint8Array): Promise<void>;
  /** Replace snapshot and discard the updates it already contains. */
  compact(roomId: string, snapshot: Uint8Array): Promise<void>;
  /**
   * Register an empty room, so it exists before anything is written to it.
   * A no-op for a room that already exists.
   */
  create(roomId: string): Promise<void>;
  /** Room ids known to the store, newest first. */
  list(): Promise<RoomSummary[]>;
  /** True if the room was created or has ever been persisted. */
  exists(roomId: string): Promise<boolean>;
  /**
   * Delete the room and everything hanging off it, leaving a tombstone. The
   * tombstone matters: a browser that was offline still holds the whole
   * diagram, and without one its next sync would quietly recreate the room.
   */
  delete(roomId: string): Promise<void>;
  isDeleted(roomId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface LoadedDoc {
  snapshot: Uint8Array | null;
  updates: Uint8Array[];
}

export interface RoomSummary {
  roomId: string;
  updatedAt: Date;
}

/**
 * In-memory store. Used for tests and for running the app with no database.
 *
 * Deliberately implements the same contract as the durable store, including
 * compaction, so tests exercise the real code path rather than a simplified one.
 */
export class MemoryDocStore implements DocStore {
  readonly kind = 'memory';
  readonly #snapshots = new Map<string, Uint8Array>();
  readonly #updates = new Map<string, Uint8Array[]>();
  readonly #updatedAt = new Map<string, Date>();
  readonly #deleted = new Set<string>();

  async load(roomId: string): Promise<LoadedDoc> {
    return {
      snapshot: this.#snapshots.get(roomId) ?? null,
      updates: [...(this.#updates.get(roomId) ?? [])],
    };
  }

  async appendUpdate(roomId: string, update: Uint8Array): Promise<void> {
    const log = this.#updates.get(roomId);
    if (log) log.push(update);
    else this.#updates.set(roomId, [update]);
    this.#updatedAt.set(roomId, new Date());
  }

  async compact(roomId: string, snapshot: Uint8Array): Promise<void> {
    this.#snapshots.set(roomId, snapshot);
    this.#updates.set(roomId, []);
    this.#updatedAt.set(roomId, new Date());
  }

  async create(roomId: string): Promise<void> {
    if (!this.#updatedAt.has(roomId)) this.#updatedAt.set(roomId, new Date());
  }

  async list(): Promise<RoomSummary[]> {
    return [...this.#updatedAt.entries()]
      .map(([roomId, updatedAt]) => ({ roomId, updatedAt }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  // Every write records updatedAt, and so does create, so it is the set of
  // rooms that exist, the same as the `rooms` table in Postgres.
  async exists(roomId: string): Promise<boolean> {
    return this.#updatedAt.has(roomId);
  }

  async delete(roomId: string): Promise<void> {
    this.#snapshots.delete(roomId);
    this.#updates.delete(roomId);
    this.#updatedAt.delete(roomId);
    this.#deleted.add(roomId);
  }

  async isDeleted(roomId: string): Promise<boolean> {
    return this.#deleted.has(roomId);
  }

  async close(): Promise<void> {
    this.#deleted.clear();
    this.#snapshots.clear();
    this.#updates.clear();
    this.#updatedAt.clear();
  }
}
