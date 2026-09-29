import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../store/migrations.ts';
import { fromPGlite } from '../store/pglite.ts';
import { MemoryAccessStore, PostgresAccessStore, type AccessStore } from './store.ts';

const shared = new PGlite();
afterAll(() => shared.close());
let schemas = 0;

const stores: [string, () => Promise<AccessStore>][] = [
  ['memory', () => Promise.resolve(new MemoryAccessStore())],
  [
    'postgres (PGlite)',
    async () => {
      const schema = `access_${++schemas}`;
      await shared.query(`CREATE SCHEMA ${schema}`);
      await shared.query(`SET search_path TO ${schema}`);
      const db = fromPGlite(shared);
      await migrate(db);
      return new PostgresAccessStore(db);
    },
  ],
];

describe.each(stores)('AccessStore contract: %s', (_name, create) => {
  let store: AccessStore;
  beforeEach(async () => {
    store = await create();
  });

  it('makes the creator the owner, and lists workspaces per member', async () => {
    await store.upsertUser({ id: 'github:1', name: 'Alice', avatarUrl: null });
    const workspace = await store.createWorkspace('Payments', 'github:1');
    expect(await store.roleOf(workspace.id, 'github:1')).toBe('owner');
    expect(await store.workspacesFor('github:1')).toEqual([expect.objectContaining({ id: workspace.id, name: 'Payments', role: 'owner' })]);
    expect(await store.workspacesFor('github:2')).toEqual([]);
    expect(await store.members(workspace.id)).toEqual([{ id: 'github:1', name: 'Alice', avatarUrl: null, role: 'owner' }]);
  });

  it('changes and removes members', async () => {
    const workspace = await store.createWorkspace('Payments', 'github:1');
    await store.setRole(workspace.id, 'github:2', 'viewer');
    await store.setRole(workspace.id, 'github:2', 'editor');
    expect(await store.roleOf(workspace.id, 'github:2')).toBe('editor');
    await store.removeMember(workspace.id, 'github:2');
    expect(await store.roleOf(workspace.id, 'github:2')).toBeNull();
  });

  it('places, renames and releases rooms', async () => {
    const workspace = await store.createWorkspace('Payments', 'github:1');
    await store.placeRoom({ roomId: 'room-1', workspaceId: workspace.id, name: 'Checkout', movedBy: 'github:1', movedAt: '2026-09-28T00:00:00.000Z' });
    await store.renameRoom('room-1', 'Checkout v2');
    expect(await store.placementOf('room-1')).toMatchObject({ workspaceId: workspace.id, name: 'Checkout v2' });
    expect((await store.roomsIn(workspace.id)).map((r) => r.roomId)).toEqual(['room-1']);
    await store.releaseRoom('room-1');
    expect(await store.placementOf('room-1')).toBeNull();
  });

  it('resolves an invite by its secret until it expires or is revoked', async () => {
    const workspace = await store.createWorkspace('Payments', 'github:1');
    const { invite, token } = await store.createInvite(workspace.id, 'viewer', 'github:1', 60_000);
    expect(token).toMatch(/^keel_inv_/);
    expect(await store.resolveInvite(token, Date.now())).toMatchObject({ id: invite.id, role: 'viewer' });
    expect(await store.resolveInvite(token, Date.now() + 120_000)).toBeNull();
    expect(await store.resolveInvite('keel_inv_nope', Date.now())).toBeNull();
    await store.revokeInvite(workspace.id, invite.id);
    expect(await store.resolveInvite(token, Date.now())).toBeNull();
  });

  it('checks ingest tokens per room, records their use, and drops them with the room', async () => {
    const workspace = await store.createWorkspace('Payments', 'github:1');
    await store.placeRoom({ roomId: 'room-1', workspaceId: workspace.id, name: 'r', movedBy: 'github:1', movedAt: '2026-09-28T00:00:00.000Z' });
    const { token, secret } = await store.createIngestToken('room-1', 'prod', 'github:1');
    expect(await store.useIngestToken('room-1', secret)).toBe(true);
    expect(await store.useIngestToken('room-2', secret)).toBe(false);
    expect((await store.ingestTokens('room-1'))[0]).toMatchObject({ id: token.id, name: 'prod', lastUsedAt: expect.any(String) as string });
    expect(JSON.stringify(await store.ingestTokens('room-1'))).not.toContain(secret);

    await store.releaseRoom('room-1');
    expect(await store.useIngestToken('room-1', secret)).toBe(false);
  });
});
