import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../store/sql.ts';

/**
 * Who may open which room.
 *
 * A room starts as a **link room**: anyone holding the id can edit it, which is
 * how Keel has always worked and stays the default. A signed-in user can move a
 * room into a **workspace**, after which only the workspace's members can open
 * it, with the member's role deciding what they may do. Moving it back out
 * makes it a link room again.
 */

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];

export interface User {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface Member extends User {
  role: Role;
}

export interface RoomPlacement {
  roomId: string;
  workspaceId: string;
  name: string;
  movedBy: string;
  movedAt: string;
}

export interface Invite {
  id: string;
  workspaceId: string;
  role: Exclude<Role, 'owner'>;
  createdBy: string;
  expiresAt: string;
}

export interface IngestToken {
  id: string;
  roomId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AccessStore {
  upsertUser(user: User): Promise<void>;

  createWorkspace(name: string, owner: string): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  renameWorkspace(id: string, name: string): Promise<void>;
  workspacesFor(userId: string): Promise<(Workspace & { role: Role })[]>;

  members(workspaceId: string): Promise<Member[]>;
  roleOf(workspaceId: string, userId: string): Promise<Role | null>;
  setRole(workspaceId: string, userId: string, role: Role): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;

  placementOf(roomId: string): Promise<RoomPlacement | null>;
  roomsIn(workspaceId: string): Promise<RoomPlacement[]>;
  placeRoom(placement: RoomPlacement): Promise<void>;
  renameRoom(roomId: string, name: string): Promise<void>;
  releaseRoom(roomId: string): Promise<void>;

  /** Returns the secret once; only its hash is kept. */
  createInvite(workspaceId: string, role: Invite['role'], createdBy: string, ttlMs: number): Promise<{ invite: Invite; token: string }>;
  invites(workspaceId: string): Promise<Invite[]>;
  revokeInvite(workspaceId: string, inviteId: string): Promise<void>;
  /** The invite a secret names, if it exists and has not expired. */
  resolveInvite(token: string, now: number): Promise<Invite | null>;

  createIngestToken(roomId: string, name: string, createdBy: string): Promise<{ token: IngestToken; secret: string }>;
  ingestTokens(roomId: string): Promise<IngestToken[]>;
  revokeIngestToken(roomId: string, tokenId: string): Promise<void>;
  /** True, and the token's last use recorded, if `secret` is a live token for this room. */
  useIngestToken(roomId: string, secret: string): Promise<boolean>;
}

/** Secrets are shown once and stored hashed, so a leaked database is not a leaked set of keys. */
export function newSecret(prefix: 'keel_inv' | 'keel_ing'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function newId(): string {
  return randomUUID();
}

// --- Memory ---------------------------------------------------------------

export class MemoryAccessStore implements AccessStore {
  readonly #users = new Map<string, User>();
  readonly #workspaces = new Map<string, Workspace>();
  readonly #members = new Map<string, Map<string, Role>>();
  readonly #placements = new Map<string, RoomPlacement>();
  readonly #invites = new Map<string, Invite & { hash: string }>();
  readonly #tokens = new Map<string, IngestToken & { hash: string }>();

  async upsertUser(user: User): Promise<void> {
    this.#users.set(user.id, { ...user });
  }

  async createWorkspace(name: string, owner: string): Promise<Workspace> {
    const workspace = { id: newId(), name, createdBy: owner, createdAt: new Date().toISOString() };
    this.#workspaces.set(workspace.id, workspace);
    this.#members.set(workspace.id, new Map([[owner, 'owner']]));
    return { ...workspace };
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const workspace = this.#workspaces.get(id);
    return workspace ? { ...workspace } : null;
  }

  async renameWorkspace(id: string, name: string): Promise<void> {
    const workspace = this.#workspaces.get(id);
    if (workspace) workspace.name = name;
  }

  async workspacesFor(userId: string): Promise<(Workspace & { role: Role })[]> {
    return [...this.#workspaces.values()]
      .flatMap((w) => {
        const role = this.#members.get(w.id)?.get(userId);
        return role ? [{ ...w, role }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async members(workspaceId: string): Promise<Member[]> {
    return [...(this.#members.get(workspaceId) ?? new Map<string, Role>())]
      .map(([id, role]) => ({ ...(this.#users.get(id) ?? { id, name: id, avatarUrl: null }), role }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async roleOf(workspaceId: string, userId: string): Promise<Role | null> {
    return this.#members.get(workspaceId)?.get(userId) ?? null;
  }

  async setRole(workspaceId: string, userId: string, role: Role): Promise<void> {
    this.#members.get(workspaceId)?.set(userId, role);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    this.#members.get(workspaceId)?.delete(userId);
  }

  async placementOf(roomId: string): Promise<RoomPlacement | null> {
    const placement = this.#placements.get(roomId);
    return placement ? { ...placement } : null;
  }

  async roomsIn(workspaceId: string): Promise<RoomPlacement[]> {
    return [...this.#placements.values()].filter((p) => p.workspaceId === workspaceId).sort((a, b) => a.name.localeCompare(b.name));
  }

  async placeRoom(placement: RoomPlacement): Promise<void> {
    this.#placements.set(placement.roomId, { ...placement });
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    const placement = this.#placements.get(roomId);
    if (placement) placement.name = name;
  }

  async releaseRoom(roomId: string): Promise<void> {
    this.#placements.delete(roomId);
    for (const [id, token] of this.#tokens) if (token.roomId === roomId) this.#tokens.delete(id);
  }

  async createInvite(workspaceId: string, role: Invite['role'], createdBy: string, ttlMs: number) {
    const token = newSecret('keel_inv');
    const invite: Invite = { id: newId(), workspaceId, role, createdBy, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    this.#invites.set(invite.id, { ...invite, hash: hashSecret(token) });
    return { invite, token };
  }

  async invites(workspaceId: string): Promise<Invite[]> {
    return [...this.#invites.values()].filter((i) => i.workspaceId === workspaceId).map(withoutHash);
  }

  async revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
    if (this.#invites.get(inviteId)?.workspaceId === workspaceId) this.#invites.delete(inviteId);
  }

  async resolveInvite(token: string, now: number): Promise<Invite | null> {
    const hash = hashSecret(token);
    const found = [...this.#invites.values()].find((i) => i.hash === hash);
    if (!found || Date.parse(found.expiresAt) <= now) return null;
    return withoutHash(found);
  }

  async createIngestToken(roomId: string, name: string, createdBy: string) {
    const secret = newSecret('keel_ing');
    const token: IngestToken = { id: newId(), roomId, name, createdBy, createdAt: new Date().toISOString(), lastUsedAt: null };
    this.#tokens.set(token.id, { ...token, hash: hashSecret(secret) });
    return { token, secret };
  }

  async ingestTokens(roomId: string): Promise<IngestToken[]> {
    return [...this.#tokens.values()].filter((t) => t.roomId === roomId).map(withoutHash);
  }

  async revokeIngestToken(roomId: string, tokenId: string): Promise<void> {
    if (this.#tokens.get(tokenId)?.roomId === roomId) this.#tokens.delete(tokenId);
  }

  async useIngestToken(roomId: string, secret: string): Promise<boolean> {
    const hash = hashSecret(secret);
    const token = [...this.#tokens.values()].find((t) => t.roomId === roomId && t.hash === hash);
    if (!token) return false;
    token.lastUsedAt = new Date().toISOString();
    return true;
  }
}

function withoutHash<T extends { hash: string }>(record: T): Omit<T, 'hash'> {
  const copy: Partial<T> = { ...record };
  delete copy.hash;
  return copy as Omit<T, 'hash'>;
}

// --- Postgres -------------------------------------------------------------

type Row = Record<string, unknown>;
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

export class PostgresAccessStore implements AccessStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  async upsertUser(user: User): Promise<void> {
    await this.#db.query(
      `INSERT INTO users (id, name, avatar_url) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, last_seen_at = now()`,
      [user.id, user.name, user.avatarUrl],
    );
  }

  async createWorkspace(name: string, owner: string): Promise<Workspace> {
    const id = newId();
    return this.#db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(
        'INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3) RETURNING created_at',
        [id, name, owner],
      );
      await tx.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, owner]);
      return { id, name, createdBy: owner, createdAt: iso(rows[0]?.['created_at']) };
    });
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const { rows } = await this.#db.query<Row>('SELECT id, name, created_by, created_at FROM workspaces WHERE id = $1', [id]);
    const row = rows[0];
    return row ? toWorkspace(row) : null;
  }

  async renameWorkspace(id: string, name: string): Promise<void> {
    await this.#db.query('UPDATE workspaces SET name = $2 WHERE id = $1', [id, name]);
  }

  async workspacesFor(userId: string): Promise<(Workspace & { role: Role })[]> {
    const { rows } = await this.#db.query<Row>(
      `SELECT w.id, w.name, w.created_by, w.created_at, m.role
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = $1 ORDER BY w.name`,
      [userId],
    );
    return rows.map((row) => ({ ...toWorkspace(row), role: row['role'] as Role }));
  }

  async members(workspaceId: string): Promise<Member[]> {
    const { rows } = await this.#db.query<Row>(
      `SELECT m.user_id, m.role, u.name, u.avatar_url
       FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY coalesce(u.name, m.user_id)`,
      [workspaceId],
    );
    return rows.map((row) => ({
      id: row['user_id'] as string,
      name: (row['name'] as string | null) ?? (row['user_id'] as string),
      avatarUrl: (row['avatar_url'] as string | null) ?? null,
      role: row['role'] as Role,
    }));
  }

  async roleOf(workspaceId: string, userId: string): Promise<Role | null> {
    const { rows } = await this.#db.query<Row>('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      workspaceId,
      userId,
    ]);
    return (rows[0]?.['role'] as Role | undefined) ?? null;
  }

  async setRole(workspaceId: string, userId: string, role: Role): Promise<void> {
    await this.#db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, userId, role],
    );
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.#db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  }

  async placementOf(roomId: string): Promise<RoomPlacement | null> {
    const { rows } = await this.#db.query<Row>(
      'SELECT room_id, workspace_id, name, moved_by, moved_at FROM room_workspaces WHERE room_id = $1',
      [roomId],
    );
    return rows[0] ? toPlacement(rows[0]) : null;
  }

  async roomsIn(workspaceId: string): Promise<RoomPlacement[]> {
    const { rows } = await this.#db.query<Row>(
      'SELECT room_id, workspace_id, name, moved_by, moved_at FROM room_workspaces WHERE workspace_id = $1 ORDER BY name',
      [workspaceId],
    );
    return rows.map(toPlacement);
  }

  async placeRoom(placement: RoomPlacement): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.query('INSERT INTO rooms (room_id) VALUES ($1) ON CONFLICT (room_id) DO NOTHING', [placement.roomId]);
      await tx.query(
        `INSERT INTO room_workspaces (room_id, workspace_id, name, moved_by, moved_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (room_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, name = EXCLUDED.name,
           moved_by = EXCLUDED.moved_by, moved_at = EXCLUDED.moved_at`,
        [placement.roomId, placement.workspaceId, placement.name, placement.movedBy, placement.movedAt],
      );
    });
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    await this.#db.query('UPDATE room_workspaces SET name = $2 WHERE room_id = $1', [roomId, name]);
  }

  async releaseRoom(roomId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.query('DELETE FROM room_workspaces WHERE room_id = $1', [roomId]);
      // Tokens gate a private room; a link room needs none, and a stale one
      // would quietly regain power if the room were made private again.
      await tx.query('DELETE FROM ingest_tokens WHERE room_id = $1', [roomId]);
    });
  }

  async createInvite(workspaceId: string, role: Invite['role'], createdBy: string, ttlMs: number) {
    const token = newSecret('keel_inv');
    const invite: Invite = { id: newId(), workspaceId, role, createdBy, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    await this.#db.query(
      'INSERT INTO workspace_invites (id, workspace_id, role, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [invite.id, workspaceId, role, hashSecret(token), createdBy, invite.expiresAt],
    );
    return { invite, token };
  }

  async invites(workspaceId: string): Promise<Invite[]> {
    const { rows } = await this.#db.query<Row>(
      'SELECT id, workspace_id, role, created_by, expires_at FROM workspace_invites WHERE workspace_id = $1 ORDER BY expires_at',
      [workspaceId],
    );
    return rows.map(toInvite);
  }

  async revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
    await this.#db.query('DELETE FROM workspace_invites WHERE workspace_id = $1 AND id = $2', [workspaceId, inviteId]);
  }

  async resolveInvite(token: string, now: number): Promise<Invite | null> {
    const { rows } = await this.#db.query<Row>(
      'SELECT id, workspace_id, role, created_by, expires_at FROM workspace_invites WHERE token_hash = $1 AND expires_at > $2',
      [hashSecret(token), new Date(now).toISOString()],
    );
    return rows[0] ? toInvite(rows[0]) : null;
  }

  async createIngestToken(roomId: string, name: string, createdBy: string) {
    const secret = newSecret('keel_ing');
    const id = newId();
    const { rows } = await this.#db.query<Row>(
      'INSERT INTO ingest_tokens (id, room_id, name, token_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING created_at',
      [id, roomId, name, hashSecret(secret), createdBy],
    );
    return { token: { id, roomId, name, createdBy, createdAt: iso(rows[0]?.['created_at']), lastUsedAt: null }, secret };
  }

  async ingestTokens(roomId: string): Promise<IngestToken[]> {
    const { rows } = await this.#db.query<Row>(
      'SELECT id, room_id, name, created_by, created_at, last_used_at FROM ingest_tokens WHERE room_id = $1 ORDER BY created_at',
      [roomId],
    );
    return rows.map((row) => ({
      id: row['id'] as string,
      roomId: row['room_id'] as string,
      name: row['name'] as string,
      createdBy: row['created_by'] as string,
      createdAt: iso(row['created_at']),
      lastUsedAt: row['last_used_at'] ? iso(row['last_used_at']) : null,
    }));
  }

  async revokeIngestToken(roomId: string, tokenId: string): Promise<void> {
    await this.#db.query('DELETE FROM ingest_tokens WHERE room_id = $1 AND id = $2', [roomId, tokenId]);
  }

  async useIngestToken(roomId: string, secret: string): Promise<boolean> {
    const { rows } = await this.#db.query<Row>(
      'UPDATE ingest_tokens SET last_used_at = now() WHERE room_id = $1 AND token_hash = $2 RETURNING id',
      [roomId, hashSecret(secret)],
    );
    return rows.length > 0;
  }
}

function toWorkspace(row: Row): Workspace {
  return { id: row['id'] as string, name: row['name'] as string, createdBy: row['created_by'] as string, createdAt: iso(row['created_at']) };
}

function toPlacement(row: Row): RoomPlacement {
  return {
    roomId: row['room_id'] as string,
    workspaceId: row['workspace_id'] as string,
    name: row['name'] as string,
    movedBy: row['moved_by'] as string,
    movedAt: iso(row['moved_at']),
  };
}

function toInvite(row: Row): Invite {
  return {
    id: row['id'] as string,
    workspaceId: row['workspace_id'] as string,
    role: row['role'] as Invite['role'],
    createdBy: row['created_by'] as string,
    expiresAt: iso(row['expires_at']),
  };
}
