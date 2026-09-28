import * as Y from 'yjs';
import { migrate } from './migrations.ts';
import type { SqlDatabase } from './sql.ts';
import type { DocStore, LoadedDoc, RoomSummary } from './store.ts';

/**
 * Durable storage: the same snapshot-plus-log shape as MemoryDocStore, in
 * Postgres. Both are run through one contract suite (store.contract.ts).
 */
export class PostgresDocStore implements DocStore {
  readonly kind = 'postgres';
  readonly #db: SqlDatabase;

  private constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** Bring the schema up to date, then hand back a store. The store owns `db`. */
  static async open(db: SqlDatabase): Promise<PostgresDocStore> {
    await migrate(db);
    return new PostgresDocStore(db);
  }

  async load(roomId: string): Promise<LoadedDoc> {
    return this.#db.transaction(async (tx) => {
      // Snapshot and log must come from the same moment. Read separately under
      // READ COMMITTED, a compaction landing between the two reads would hand
      // back the old snapshot with an already-emptied log, and the room would
      // open missing everything since the previous compaction.
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const room = await tx.query<{ snapshot: Uint8Array | null }>('SELECT snapshot FROM rooms WHERE room_id = $1', [
        roomId,
      ]);
      const log = await tx.query<{ data: Uint8Array }>(
        'SELECT data FROM room_updates WHERE room_id = $1 ORDER BY seq',
        [roomId],
      );
      return {
        snapshot: room.rows[0]?.snapshot ? bytes(room.rows[0].snapshot) : null,
        updates: log.rows.map((row) => bytes(row.data)),
      };
    });
  }

  /**
   * One statement, one round trip: create-or-touch the room row, then append.
   * The upsert takes the room's row lock, which is what orders an append
   * against a concurrent compaction.
   */
  async appendUpdate(roomId: string, update: Uint8Array): Promise<void> {
    await this.#db.query(
      `WITH room AS (
         INSERT INTO rooms (room_id) VALUES ($1)
         ON CONFLICT (room_id) DO UPDATE SET updated_at = now()
         RETURNING room_id
       )
       INSERT INTO room_updates (room_id, data) SELECT room_id, $2 FROM room`,
      [roomId, param(update)],
    );
  }

  /**
   * Replace the snapshot and drop the log it supersedes, atomically.
   *
   * The caller's snapshot is folded together with whatever is already stored
   * rather than trusted to contain it. Room only compacts after its own append
   * has landed, so in normal operation that is a no-op, but it means an update
   * appended by anyone else between the caller encoding its snapshot and this
   * transaction taking the lock is kept rather than deleted. Yjs updates are
   * idempotent, so applying one the snapshot already contains is harmless.
   *
   * If anything here fails the transaction rolls back and the log is untouched:
   * a failed compaction costs a slower load, never data.
   */
  async compact(roomId: string, snapshot: Uint8Array): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.query('INSERT INTO rooms (room_id) VALUES ($1) ON CONFLICT (room_id) DO NOTHING', [roomId]);
      const room = await tx.query<{ snapshot: Uint8Array | null }>(
        'SELECT snapshot FROM rooms WHERE room_id = $1 FOR UPDATE',
        [roomId],
      );
      const log = await tx.query<{ seq: string | number; data: Uint8Array }>(
        'SELECT seq, data FROM room_updates WHERE room_id = $1 ORDER BY seq',
        [roomId],
      );

      const doc = new Y.Doc();
      try {
        const previous = room.rows[0]?.snapshot;
        if (previous) Y.applyUpdate(doc, bytes(previous));
        for (const row of log.rows) Y.applyUpdate(doc, bytes(row.data));
        Y.applyUpdate(doc, snapshot);
        const folded = Y.encodeStateAsUpdate(doc);

        await tx.query('UPDATE rooms SET snapshot = $2, updated_at = now() WHERE room_id = $1', [
          roomId,
          param(folded),
        ]);
      } finally {
        doc.destroy();
      }

      const lastSeq = log.rows.at(-1)?.seq;
      if (lastSeq !== undefined) {
        await tx.query('DELETE FROM room_updates WHERE room_id = $1 AND seq <= $2', [roomId, lastSeq]);
      }
    });
  }

  async list(): Promise<RoomSummary[]> {
    const { rows } = await this.#db.query<{ room_id: string; updated_at: Date | string }>(
      'SELECT room_id, updated_at FROM rooms ORDER BY updated_at DESC',
    );
    return rows.map((row) => ({ roomId: row.room_id, updatedAt: new Date(row.updated_at) }));
  }

  async exists(roomId: string): Promise<boolean> {
    const { rows } = await this.#db.query<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM rooms WHERE room_id = $1) AS found',
      [roomId],
    );
    return rows[0]?.found === true;
  }

  async close(): Promise<void> {
    await this.#db.end();
  }
}

/** node-postgres only recognises Buffer as bytea, not a bare Uint8Array. */
function param(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Drivers hand bytea back as Buffer or Uint8Array; callers expect plain bytes. */
function bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
