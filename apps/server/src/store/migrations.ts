import type { SqlDatabase } from './sql.ts';

/**
 * Schema changes, applied in order and never edited once shipped.
 *
 * Each migration is a list of single statements rather than one script,
 * because parameterised drivers (PGlite, and node-postgres with the extended
 * protocol) reject multi-statement strings.
 */
export interface Migration {
  id: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'room documents',
    statements: [
      // One row per room. The row is also the lock that serialises an append
      // against a compaction of the same room.
      `CREATE TABLE rooms (
        room_id    text PRIMARY KEY,
        snapshot   bytea,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      // The append-only log on top of the snapshot. seq is global rather than
      // per room, which is all ordering needs and avoids a counter per room.
      `CREATE TABLE room_updates (
        seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        room_id    text NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
        data       bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX room_updates_room_seq ON room_updates (room_id, seq)`,
      `CREATE INDEX rooms_updated_at ON rooms (updated_at DESC)`,
    ],
  },
  {
    id: 2,
    name: 'drift alerts',
    statements: [
      // Credentials live here, never in the room document everyone downloads.
      `CREATE TABLE room_alert_configs (
        room_id    text PRIMARY KEY REFERENCES rooms (room_id) ON DELETE CASCADE,
        config     jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      // Open alerts, one document per room. Persisted so a restart never
      // re-pages for a finding that was already delivered.
      `CREATE TABLE room_alert_state (
        room_id    text PRIMARY KEY REFERENCES rooms (room_id) ON DELETE CASCADE,
        state      jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
];

/**
 * Arbitrary but fixed. Two instances booting against one database at the same
 * moment would otherwise both see a migration as unapplied and both run it.
 */
const MIGRATION_LOCK_KEY = 7_244_901;

/** Apply every migration not yet recorded. Returns the ids it applied. */
export async function migrate(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  return db.transaction(async (tx) => {
    // Transaction-scoped, so it is released on commit or rollback and a crashed
    // migrator can never leave the lock held.
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id         integer PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const { rows } = await tx.query<{ id: number }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((row) => Number(row.id)));

    const ran: number[] = [];
    for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
      if (applied.has(migration.id)) continue;
      for (const statement of migration.statements) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [migration.id, migration.name]);
      ran.push(migration.id);
    }
    return ran;
  });
}
