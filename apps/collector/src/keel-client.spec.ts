import { describe, expect, it } from 'vitest';
import { bounded, KeelClient, MAX_NODES } from './keel-client.ts';

const set = { source: 'kubernetes', observedAt: '2026-09-28T00:00:00.000Z', nodes: [{ ref: 'a', replicas: 1 }] };

function scripted(statuses: (number | Error)[]) {
  const calls: string[] = [];
  const fetch = ((url: string) => {
    calls.push(url);
    const next = statuses.shift() ?? 200;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(new Response('{}', { status: next }));
  }) as typeof globalThis.fetch;
  return { calls, client: new KeelClient('https://keel.test/', { fetch, sleep: () => Promise.resolve() }) };
}

describe('KeelClient', () => {
  it('posts to each room', async () => {
    const { calls, client } = scripted([202, 202]);
    const results = await client.push(['room-a', 'room-b'], set);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls.sort()).toEqual([
      'https://keel.test/api/rooms/room-a/observations',
      'https://keel.test/api/rooms/room-b/observations',
    ]);
  });

  it('retries network errors, 429 and 5xx', async () => {
    const { calls, client } = scripted([new Error('ECONNRESET'), 503, 429, 202]);
    const [result] = await client.push(['room-a'], set);
    expect(result?.ok).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('does not retry a request the server rejected as invalid', async () => {
    const { calls, client } = scripted([400]);
    const [result] = await client.push(['room-a'], set);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(calls).toHaveLength(1);
  });
});

describe('bounded', () => {
  it('keeps the busiest components when a cluster exceeds the server limit', () => {
    const nodes = Array.from({ length: MAX_NODES + 10 }, (_, i) => ({ ref: `n${i}`, rps: i }));
    const kept = bounded({ ...set, nodes }).nodes ?? [];
    expect(kept).toHaveLength(MAX_NODES);
    expect(kept.some((n) => n.ref === 'n0')).toBe(false);
    expect(kept[0]?.ref).toBe(`n${MAX_NODES + 9}`);
  });
});
