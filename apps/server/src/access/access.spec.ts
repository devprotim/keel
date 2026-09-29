import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { WsPeer } from '../collab/ws-peer.ts';
import { loadConfig } from '../config.ts';
import { MemoryDocStore } from '../store/store.ts';
import { CLOSE_ACCESS_CHANGED, CLOSE_DELETED, CLOSE_FORBIDDEN } from './policy.ts';
import { MemoryAccessStore } from './store.ts';

const SECRET = 's'.repeat(32);
let app: FastifyInstance;
let access: MemoryAccessStore;

beforeEach(async () => {
  access = new MemoryAccessStore();
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      PERSIST_DEBOUNCE_MS: '5',
      SESSION_SECRET: SECRET,
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      PUBLIC_URL: 'https://keel.test',
    }),
    store: new MemoryDocStore(),
    accessStore: access,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/** A session cookie exactly as the OAuth callback would set one. */
async function cookieFor(id: string, name = id): Promise<string> {
  const token = await new SignJWT({ id: `github:${id}`, provider: 'github', name, avatarUrl: null })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));
  return `keel_session=${token}`;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, cookie?: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: { ...(cookie ? { cookie } : {}), ...headers } });

async function privateRoom(roomId = 'room-secret') {
  const alice = await cookieFor('alice', 'Alice');
  const created = await call('POST', '/api/workspaces', alice, { name: 'Payments' });
  const workspaceId = created.json<{ workspace: { id: string } }>().workspace.id;
  const moved = await call('PUT', `/api/rooms/${roomId}/workspace`, alice, { workspaceId, name: 'Checkout architecture' });
  expect(moved.statusCode).toBe(200);
  return { alice, workspaceId, roomId };
}

async function join(roomId: string, cookie?: string): Promise<WsPeer> {
  const ws = await app.injectWS(`/ws/${roomId}`, { headers: cookie ? { cookie } : {} });
  return new WsPeer(ws);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('link rooms (the default)', () => {
  it('stay open to anyone with the link, signed in or not', async () => {
    const response = await call('GET', '/api/rooms/room-open/access');
    expect(response.json()).toMatchObject({ visibility: 'link', canView: true, canEdit: true, signedIn: false });

    const peer = await join('room-open');
    await peer.synced;
    peer.nodes.set('n1', 'drawn anonymously');
    await settle();
    const other = await join('room-open');
    await other.synced;
    expect(other.nodes.get('n1')).toBe('drawn anonymously');
  });

  it('cannot be moved into a workspace without signing in', async () => {
    expect((await call('POST', '/api/workspaces', undefined, { name: 'x' })).statusCode).toBe(401);
  });
});

describe('workspace rooms', () => {
  it('turn away anyone who is not a member, on every door', async () => {
    const { roomId } = await privateRoom();
    const stranger = await cookieFor('mallory');

    expect((await call('GET', `/api/rooms/${roomId}/access`, stranger)).json()).toEqual({
      visibility: 'workspace',
      role: null,
      canView: false,
      canEdit: false,
      canManage: false,
      signedIn: true,
    });
    expect(await (await join(roomId, stranger)).closed).toBe(CLOSE_FORBIDDEN);
    expect(await (await join(roomId)).closed).toBe(CLOSE_FORBIDDEN);
    expect((await call('GET', `/api/rooms/${roomId}/alerts`, stranger)).statusCode).toBe(403);
    expect((await call('PUT', `/api/rooms/${roomId}/workspace`, stranger, { workspaceId: crypto.randomUUID(), name: 'x' })).statusCode).toBe(403);
  });

  it('let members in, with the name of the workspace and the room', async () => {
    const { alice, roomId } = await privateRoom();
    expect((await call('GET', `/api/rooms/${roomId}/access`, alice)).json()).toMatchObject({
      role: 'owner',
      canEdit: true,
      canManage: true,
      workspace: { name: 'Payments' },
      name: 'Checkout architecture',
    });
    const peer = await join(roomId, alice);
    await peer.synced;
  });

  it('let a viewer watch but drop every write they send', async () => {
    const { alice, workspaceId, roomId } = await privateRoom();
    const invite = await call('POST', `/api/workspaces/${workspaceId}/invites`, alice, { role: 'viewer' });
    const token = invite.json<{ url: string }>().url.split('/invite/')[1] ?? '';
    const bob = await cookieFor('bob', 'Bob');
    expect((await call('POST', `/api/invites/${token}/accept`, bob)).json()).toMatchObject({ role: 'viewer' });

    const editor = await join(roomId, alice);
    const viewer = await join(roomId, bob);
    await Promise.all([editor.synced, viewer.synced]);

    editor.nodes.set('from-owner', 1);
    viewer.nodes.set('from-viewer', 1);
    await settle();

    const fresh = await join(roomId, alice);
    await fresh.synced;
    expect(fresh.nodes.get('from-owner')).toBe(1);
    expect(fresh.nodes.has('from-viewer')).toBe(false);
    // The viewer still receives edits.
    expect(viewer.nodes.get('from-owner')).toBe(1);
  });

  it('accept observations only with an ingest token issued for the room', async () => {
    const { alice, roomId } = await privateRoom();
    const body = { source: 'kubernetes', observedAt: '2026-09-28T00:00:00Z', nodes: [] };
    const push = (headers: Record<string, string>) => call('POST', `/api/rooms/${roomId}/observations`, undefined, body, headers);

    expect((await push({})).statusCode).toBe(401);
    expect((await push({ authorization: 'Bearer keel_ing_wrong' })).statusCode).toBe(403);

    const created = await call('POST', `/api/rooms/${roomId}/ingest-tokens`, alice, { name: 'prod cluster' });
    const { secret, token } = created.json<{ secret: string; token: { id: string } }>();
    expect((await push({ authorization: `Bearer ${secret}` })).statusCode).toBe(202);

    // Listed without the secret, and dead once revoked.
    expect(JSON.stringify((await call('GET', `/api/rooms/${roomId}/ingest-tokens`, alice)).json())).not.toContain(secret);
    await call('DELETE', `/api/rooms/${roomId}/ingest-tokens/${token.id}`, alice);
    expect((await push({ authorization: `Bearer ${secret}` })).statusCode).toBe(403);
  });

  it('disconnect everyone when the room changes hands, so no socket keeps a stale grant', async () => {
    const peer = await join('room-moving');
    await peer.synced;
    await privateRoom('room-moving');
    expect(await peer.closed).toBe(CLOSE_ACCESS_CHANGED);
  });

  it('become link rooms again when an owner releases them', async () => {
    const { alice, roomId } = await privateRoom();
    expect((await call('DELETE', `/api/rooms/${roomId}/workspace`, alice)).statusCode).toBe(204);
    expect((await call('GET', `/api/rooms/${roomId}/access`)).json()).toMatchObject({ visibility: 'link', canEdit: true });
  });
});

describe('deleting a diagram', () => {
  it('is for workspace owners only, and never for a link room', async () => {
    const { roomId } = await privateRoom();
    expect((await call('DELETE', `/api/rooms/${roomId}`, await cookieFor('mallory'))).statusCode).toBe(403);
    expect((await call('DELETE', '/api/rooms/room-open', await cookieFor('mallory'))).statusCode).toBe(403);
  });

  it('disconnects everyone, and keeps an offline copy from bringing it back', async () => {
    const { alice, roomId } = await privateRoom();
    const peer = await join(roomId, alice);
    await peer.synced;
    peer.nodes.set('n1', 'about to go');
    await settle();

    expect((await call('DELETE', `/api/rooms/${roomId}`, alice)).statusCode).toBe(204);
    expect(await peer.closed).toBe(CLOSE_DELETED);

    // A browser that still has the diagram is told it is gone, not given a room to refill.
    expect(await (await join(roomId, alice)).closed).toBe(CLOSE_DELETED);
    expect((await call('GET', `/api/rooms/${roomId}/access`, alice)).json()).toMatchObject({ deleted: true, canView: false });
    const push = await call('POST', `/api/rooms/${roomId}/observations`, alice, { source: 'k8s', observedAt: '2026-09-28T00:00:00Z' });
    expect(push.statusCode).toBe(410);
  });
});

describe('membership', () => {
  it('always keeps an owner', async () => {
    const { alice, workspaceId } = await privateRoom();
    expect((await call('PUT', `/api/workspaces/${workspaceId}/members/github:alice`, alice, { role: 'editor' })).statusCode).toBe(409);
    expect((await call('DELETE', `/api/workspaces/${workspaceId}/members/github:alice`, alice)).statusCode).toBe(409);
  });

  it('never lowers a role through an invite', async () => {
    const { alice, workspaceId } = await privateRoom();
    const invite = await call('POST', `/api/workspaces/${workspaceId}/invites`, alice, { role: 'viewer' });
    const token = invite.json<{ url: string }>().url.split('/invite/')[1] ?? '';
    expect((await call('POST', `/api/invites/${token}/accept`, alice)).json()).toMatchObject({ role: 'owner' });
  });

  it('hides a workspace from non-members as if it did not exist', async () => {
    const { workspaceId } = await privateRoom();
    const response = await call('GET', `/api/workspaces/${workspaceId}`, await cookieFor('mallory'));
    expect(response.statusCode).toBe(404);
  });

  it('lets an owner see members with their names, rooms and invites', async () => {
    const { alice, workspaceId } = await privateRoom();
    // Any visit records the name, not only a fresh sign-in.
    await call('GET', '/api/auth/me', alice);
    const invite = await call('POST', `/api/workspaces/${workspaceId}/invites`, alice, {});
    expect(invite.json<{ url: string }>().url).toMatch(/^https:\/\/keel\.test\/invite\/keel_inv_/);
    const detail = (await call('GET', `/api/workspaces/${workspaceId}`, alice)).json<{
      members: { id: string; role: string }[];
      rooms: { name: string }[];
      invites: unknown[];
    }>();
    expect(detail.members).toEqual([expect.objectContaining({ id: 'github:alice', name: 'Alice', role: 'owner' })]);
    expect(detail.rooms.map((r) => r.name)).toEqual(['Checkout architecture']);
    expect(detail.invites).toHaveLength(1);
  });

  it('refuses an invite that has been revoked', async () => {
    const { alice, workspaceId } = await privateRoom();
    const invite = (await call('POST', `/api/workspaces/${workspaceId}/invites`, alice, {})).json<{ url: string; invite: { id: string } }>();
    const token = invite.url.split('/invite/')[1] ?? '';
    await call('DELETE', `/api/workspaces/${workspaceId}/invites/${invite.invite.id}`, alice);
    expect((await call('GET', `/api/invites/${token}`)).statusCode).toBe(404);
    expect((await call('POST', `/api/invites/${token}/accept`, await cookieFor('bob'))).statusCode).toBe(404);
  });
});
