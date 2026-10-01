import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOSE_NOT_FOUND } from './access/policy.ts';
import { buildApp } from './app.ts';
import { WsPeer } from './collab/ws-peer.ts';
import { loadConfig } from './config.ts';
import { MemoryDocStore } from './store/store.ts';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', PERSIST_DEBOUNCE_MS: '5' }),
    store: new MemoryDocStore(),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function create(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/rooms' });
  expect(response.statusCode).toBe(201);
  return response.json<{ roomId: string }>().roomId;
}

const observations = { source: 'ci', observedAt: new Date().toISOString(), nodes: [{ ref: 'api', replicas: 2 }] };

describe('POST /api/rooms', () => {
  it('mints a random id each time', async () => {
    const first = await create();
    const second = await create();
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});

describe('rooms', () => {
  it('open on every door once created', async () => {
    const roomId = await create();

    const access = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/access` });
    expect(access.json()).toMatchObject({ visibility: 'link', canView: true, canEdit: true });
    expect(access.json()).not.toHaveProperty('missing');

    const peer = new WsPeer(await app.injectWS(`/ws/${roomId}`));
    await peer.synced;

    const pushed = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/observations`, payload: observations });
    expect(pushed.statusCode).toBe(202);
  });

  it('turn a typed id away on every door instead of making a room of it', async () => {
    const access = await app.inject({ method: 'GET', url: '/api/rooms/foo-typed/access' });
    expect(access.json()).toMatchObject({ missing: true, canView: false, canEdit: false });

    const peer = new WsPeer(await app.injectWS('/ws/foo-typed'));
    expect(await peer.closed).toBe(CLOSE_NOT_FOUND);

    const pushed = await app.inject({ method: 'POST', url: '/api/rooms/foo-typed/observations', payload: observations });
    expect(pushed.statusCode).toBe(404);

    const alerts = await app.inject({ method: 'GET', url: '/api/rooms/foo-typed/alerts' });
    expect(alerts.statusCode).toBe(403);
  });
});
