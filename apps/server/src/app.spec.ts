import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { MemoryDocStore } from './store/store.ts';

let app: FastifyInstance;
let store: MemoryDocStore;

beforeEach(async () => {
  store = new MemoryDocStore();
  app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(32), PERSIST_DEBOUNCE_MS: '5' }),
    store,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const ruleIdsOf = (body: string): string[] =>
  (JSON.parse(body) as { findings: { ruleId: string }[] }).findings.map((f) => f.ruleId);

const node = (id: string, replicas: number) => ({ id, kind: 'service', label: id, x: 0, y: 0, w: 1, h: 1, replicas, ref: id });

describe('POST /api/rooms/:roomId/observations', () => {
  const body = {
    source: 'kubernetes',
    observedAt: '2026-09-25T11:55:00Z',
    nodes: [{ ref: 'orders', replicas: 1, rps: 120 }],
    edges: [{ source: 'api', target: 'orders', timeoutMs: null, p99Ms: 900 }],
  };

  it('writes the set into the room document, where every client will see it', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/rooms/room-42/observations', payload: body });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: { source: 'kubernetes', observedAt: body.observedAt, nodes: 1, edges: 1 },
    });

    // Durable before the response: reload the room from storage.
    const { snapshot, updates } = await store.load('room-42');
    const doc = new Y.Doc();
    if (snapshot) Y.applyUpdate(doc, snapshot);
    for (const update of updates) Y.applyUpdate(doc, update);
    expect(doc.getMap('observations').get('kubernetes')).toEqual(body);
  });

  it('replaces a source wholesale on the next push', async () => {
    await app.inject({ method: 'POST', url: '/api/rooms/room-42/observations', payload: body });
    await app.inject({
      method: 'POST',
      url: '/api/rooms/room-42/observations',
      payload: { source: 'kubernetes', observedAt: '2026-09-25T12:00:00Z', nodes: [] },
    });

    const { snapshot, updates } = await store.load('room-42');
    const doc = new Y.Doc();
    if (snapshot) Y.applyUpdate(doc, snapshot);
    for (const update of updates) Y.applyUpdate(doc, update);
    expect(doc.getMap('observations').get('kubernetes')).toEqual({
      source: 'kubernetes',
      observedAt: '2026-09-25T12:00:00Z',
      nodes: [],
    });
  });

  it.each([
    ['a bad room id', '/api/rooms/../observations', body],
    ['a missing timestamp', '/api/rooms/room-42/observations', { ...body, observedAt: undefined }],
    ['a negative replica count', '/api/rooms/room-42/observations', { ...body, nodes: [{ ref: 'a', replicas: -1 }] }],
    ['a source with a slash', '/api/rooms/room-42/observations', { ...body, source: 'a/b' }],
  ])('rejects %s', async (_name, url, payload) => {
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });
});

describe('POST /api/validate', () => {
  const graph = {
    nodes: [node('api', 2), node('orders', 3)],
    edges: [{ id: 'e1', source: 'api', target: 'orders', kind: 'sync', timeoutMs: 500, retries: 3 }],
  };

  it('still accepts a bare graph', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/validate', payload: graph });
    expect(response.statusCode).toBe(200);
    expect(ruleIdsOf(response.body)).not.toContain('retry-storm');
  });

  it('validates against observations when they are supplied', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        ...graph,
        observations: [
          { source: 'k8s', observedAt: new Date().toISOString(), nodes: [{ ref: 'orders', replicas: 1 }] },
        ],
      },
    });
    const ruleIds = ruleIdsOf(response.body);
    expect(ruleIds).toContain('retry-storm');
    expect(ruleIds).toContain('observed-drift');
  });
});
