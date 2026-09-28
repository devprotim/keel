import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewProvider } from './ai/provider.ts';
import { buildApp, isAllowedSocketOrigin, redactRoomIds } from './app.ts';
import { TokenBucket } from './collab/rate-limit.ts';
import { loadConfig } from './config.ts';
import { MemoryDocStore } from './store/store.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function boot(env: Record<string, string> = {}, reviewProvider?: ReviewProvider | null): Promise<FastifyInstance> {
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', PERSIST_DEBOUNCE_MS: '5', ...env }),
    store: new MemoryDocStore(),
    ...(reviewProvider !== undefined ? { reviewProvider } : {}),
  });
  await app.ready();
  apps.push(app);
  return app;
}

const stubProvider = (models: string[]): ReviewProvider & { calls: (string | undefined)[] } => {
  const calls: (string | undefined)[] = [];
  return {
    name: 'stub',
    model: 'stub-default',
    calls,
    async generate(_graph, model) {
      calls.push(model);
      return { findings: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    },
    async listModels() {
      return models;
    },
  };
};

const graph = {
  nodes: [{ id: 'a', kind: 'service', label: 'A', x: 0, y: 0, w: 1, h: 1, replicas: 2 }],
  edges: [],
};

describe('request budgets', () => {
  it('rate-limits review per client, since every call is billed', async () => {
    const app = await boot({ RATE_LIMIT_REVIEW_PER_MIN: '2' }, stubProvider([]));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await app.inject({ method: 'POST', url: '/api/review', payload: graph })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('rate-limits observation pushes, which can create rooms', async () => {
    const app = await boot({ RATE_LIMIT_OBSERVATIONS_PER_MIN: '1' });
    const push = () =>
      app.inject({
        method: 'POST',
        url: '/api/rooms/room-1/observations',
        payload: { source: 'k8s', observedAt: '2026-09-28T00:00:00Z' },
      });
    expect((await push()).statusCode).toBe(202);
    expect((await push()).statusCode).toBe(429);
  });
});

describe('review model choice', () => {
  it('refuses a model that is not on offer', async () => {
    const provider = stubProvider(['cheap', 'pricey']);
    const app = await boot({ REVIEW_ALLOWED_MODELS: 'cheap' }, provider);

    const models = await app.inject({ method: 'GET', url: '/api/review/models' });
    expect(models.json()).toMatchObject({ models: ['cheap'], defaultModel: 'stub-default' });

    const refused = await app.inject({ method: 'POST', url: '/api/review?model=pricey', payload: graph });
    expect(refused.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/api/review?model=made-up', payload: graph });
    expect(unknown.statusCode).toBe(400);

    expect((await app.inject({ method: 'POST', url: '/api/review?model=cheap', payload: graph })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/review', payload: graph })).statusCode).toBe(200);
    expect(provider.calls).toEqual(['cheap', 'stub-default']);
  });
});

describe('graph bounds', () => {
  it.each([
    ['an oversized label', { ...graph.nodes[0], label: 'x'.repeat(201) }],
    ['an oversized id', { ...graph.nodes[0], id: 'x'.repeat(65) }],
    ['an absurd replica count', { ...graph.nodes[0], replicas: 1e9 }],
    ['a coordinate far off the canvas', { ...graph.nodes[0], x: 1e12 }],
  ])('rejects %s', async (_name, node) => {
    const app = await boot();
    const response = await app.inject({ method: 'POST', url: '/api/validate', payload: { nodes: [node], edges: [] } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects negative retries and timeouts on an edge', async () => {
    const app = await boot();
    const nodes = [graph.nodes[0], { ...graph.nodes[0], id: 'b' }];
    for (const bad of [{ retries: -1 }, { timeoutMs: -5 }]) {
      const edges = [{ id: 'e', source: 'a', target: 'b', kind: 'sync', ...bad }];
      const response = await app.inject({ method: 'POST', url: '/api/validate', payload: { nodes, edges } });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('collaboration socket', () => {
  it('refuses an upgrade from a foreign page', async () => {
    const app = await boot();
    const ws = await app.injectWS('/ws/room-1', { headers: { origin: 'https://evil.example' } });
    const code = await new Promise<number>((resolve) => ws.on('close', (c: number) => resolve(c)));
    expect(code).toBe(1008);
  });

  it('closes a socket that floods the room', async () => {
    const app = await boot({ WS_MESSAGES_PER_SECOND: '5' });
    const ws = await app.injectWS('/ws/room-1');
    const closed = new Promise<number>((resolve) => ws.on('close', (c: number) => resolve(c)));
    // Awareness frames with an empty update: harmless, so only the rate matters.
    for (let i = 0; i < 50; i += 1) ws.send(new Uint8Array([1, 1, 0]));
    expect(await closed).toBe(1008);
  });

  it.each([
    [undefined, true],
    ['http://localhost:4200', true],
    ['https://keel.example', true],
    ['https://evil.example', false],
    ['not a url', false],
  ])('origin %s allowed: %s', (origin, allowed) => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(isAllowedSocketOrigin(origin, 'keel.example', config)).toBe(allowed);
  });
});

describe('log redaction', () => {
  it('keeps room ids, which are edit capabilities, out of logged URLs', () => {
    const ws = redactRoomIds('/ws/team-secret-room');
    const api = redactRoomIds('/api/rooms/team-secret-room/observations?x=1');
    expect(ws).not.toContain('team-secret-room');
    expect(api).not.toContain('team-secret-room');
    expect(api).toMatch(/^\/api\/rooms\/room#[0-9a-f]{10}\/observations\?x=1$/);
    // The same room gets the same tag, so its requests can still be correlated.
    expect(redactRoomIds('/ws/team-secret-room')).toBe(ws);
    expect(redactRoomIds('/api/validate')).toBe('/api/validate');
  });
});

describe('TokenBucket', () => {
  it('allows a burst, refuses a sustained flood, and refills', () => {
    let now = 0;
    const bucket = new TokenBucket(10, 20, () => now);
    const burst = Array.from({ length: 25 }, () => bucket.take());
    expect(burst.filter(Boolean)).toHaveLength(20);

    now += 500; // half a second refills five tokens
    expect(Array.from({ length: 6 }, () => bucket.take()).filter(Boolean)).toHaveLength(5);
  });
});
