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
  {
    id: 3,
    name: 'workspaces and access',
    statements: [
      // Identity as the OAuth provider reports it, refreshed on each sign-in,
      // so member lists can show names for people who are not online.
      `CREATE TABLE users (
        id           text PRIMARY KEY,
        name         text NOT NULL,
        avatar_url   text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE workspaces (
        id         uuid PRIMARY KEY,
        name       text NOT NULL,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE workspace_members (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        user_id      text NOT NULL,
        role         text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        PRIMARY KEY (workspace_id, user_id)
      )`,
      `CREATE INDEX workspace_members_user ON workspace_members (user_id)`,
      // A room is in at most one workspace. No row means a link room.
      `CREATE TABLE room_workspaces (
        room_id      text PRIMARY KEY REFERENCES rooms (room_id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name         text NOT NULL,
        moved_by     text NOT NULL,
        moved_at     timestamptz NOT NULL
      )`,
      `CREATE INDEX room_workspaces_workspace ON room_workspaces (workspace_id)`,
      // Only hashes of secrets are stored.
      `CREATE TABLE workspace_invites (
        id           uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        role         text NOT NULL CHECK (role IN ('editor', 'viewer')),
        token_hash   text NOT NULL UNIQUE,
        created_by   text NOT NULL,
        expires_at   timestamptz NOT NULL
      )`,
      `CREATE TABLE ingest_tokens (
        id           uuid PRIMARY KEY,
        room_id      text NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
        name         text NOT NULL,
        token_hash   text NOT NULL UNIQUE,
        created_by   text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz
      )`,
    ],
  },
  {
    id: 4,
    name: 'room deletion',
    statements: [
      // Ids are random, so remembering deleted ones never blocks a new room.
      `CREATE TABLE deleted_rooms (
        room_id    text PRIMARY KEY,
        deleted_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    id: 5,
    name: 'workspace billing',
    statements: [
      // Written only by the Stripe webhook. No row is the free plan.
      `CREATE TABLE workspace_billing (
        workspace_id    uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
        plan            text NOT NULL CHECK (plan IN ('free', 'team', 'business')),
        status          text NOT NULL,
        customer_id     text NOT NULL,
        subscription_id text,
        item_id         text,
        period_end      timestamptz,
        updated_at      timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX workspace_billing_customer ON workspace_billing (customer_id)`,
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
