/**
 * Persistence for collaborative documents.
 *
 * Yjs documents are stored as an append-only log of binary updates on top of an
 * optional snapshot. Appending is cheap and never conflicts, which suits a room
 * receiving updates from several peers at once. The log is periodically folded
 * back into a snapshot so that loading a long-lived room stays fast.
 */
export interface DocStore {
  /** Everything needed to rebuild a document: a base snapshot plus later updates. */
  load(roomId: string): Promise<LoadedDoc>;
  /** Append one update. Called on the hot path, so it must stay cheap. */
  appendUpdate(roomId: string, update: Uint8Array): Promise<void>;
  /** Replace snapshot and discard the updates it already contains. */
  compact(roomId: string, snapshot: Uint8Array): Promise<void>;
  /** Room ids known to the store, newest first. */
  list(): Promise<RoomSummary[]>;
  /** True if the room has ever been persisted. */
  exists(roomId: string): Promise<boolean>;
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
  readonly #snapshots = new Map<string, Uint8Array>();
  readonly #updates = new Map<string, Uint8Array[]>();
  readonly #updatedAt = new Map<string, Date>();

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

  async list(): Promise<RoomSummary[]> {
    return [...this.#updatedAt.entries()]
      .map(([roomId, updatedAt]) => ({ roomId, updatedAt }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async exists(roomId: string): Promise<boolean> {
    return this.#snapshots.has(roomId) || (this.#updates.get(roomId)?.length ?? 0) > 0;
  }

  async close(): Promise<void> {
    this.#snapshots.clear();
    this.#updates.clear();
    this.#updatedAt.clear();
  }
}
