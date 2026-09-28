import { gzipSync } from 'node:zlib';
import type { ObservationSet } from '@keel/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Collector } from './collector.ts';
import { loadConfig } from './config.ts';
import { otlpExport } from './fixtures.ts';
import { KeelClient } from './keel-client.ts';
import type { Workload } from './kubernetes.ts';

const running: Collector[] = [];
afterEach(async () => {
  for (const collector of running.splice(0)) await collector.stop();
});

function setup(options: { kube?: () => Promise<Workload[]>; env?: Record<string, string> } = {}) {
  const pushed: { url: string; set: ObservationSet }[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    pushed.push({ url, set: JSON.parse(init?.body as string) as ObservationSet });
    return Promise.resolve(new Response('{}', { status: 202 }));
  }) as typeof globalThis.fetch;

  const config = loadConfig({
    KEEL_URL: 'https://keel.test',
    KEEL_ROOMS: 'prod-arch',
    KEEL_KUBERNETES: options.kube ? 'true' : 'false',
    KEEL_KUBERNETES_API_URL: 'http://unused',
    KEEL_OTLP_PORT: '1', // replaced below: 0 is not a valid configured port
    KEEL_PUSH_INTERVAL_SECONDS: '3600',
    KEEL_OTLP_PAIR_TIMEOUT_SECONDS: '0.001',
    ...options.env,
  });
  config.otlp.port = 0;
  config.otlp.host = '127.0.0.1';

  const logs: string[] = [];
  const collector = new Collector({
    config,
    keel: new KeelClient(config.keelUrl, { fetch, sleep: () => Promise.resolve() }),
    kube: options.kube ? { listWorkloads: options.kube } : null,
    log: (line) => logs.push(line),
  });
  running.push(collector);
  return { collector, pushed, logs };
}

const trace = otlpExport([
  { service: 'checkout', spanId: 'c1', kind: 3, durationMs: 12 },
  { service: 'pricing', spanId: 's1', parentSpanId: 'c1', kind: 2, durationMs: 10 },
]);

describe('Collector', () => {
  it('accepts gzipped OTLP JSON, as the OpenTelemetry Collector sends it', async () => {
    const { collector, pushed } = setup();
    const port = await collector.start();

    const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify(trace)),
    });
    expect(response.status).toBe(200);

    await collector.tick();
    const otel = pushed.find((p) => p.set.source === 'otel');
    expect(otel?.url).toBe('https://keel.test/api/rooms/prod-arch/observations');
    expect(otel?.set.edges).toEqual([expect.objectContaining({ source: 'checkout', target: 'pricing', p99Ms: 12 })]);
  });

  it('refuses protobuf with instructions, rather than silently dropping it', async () => {
    const { collector } = setup();
    const port = await collector.start();
    const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(415);
    expect(await response.text()).toContain('encoding: json');
  });

  it('refuses an export over the size limit', async () => {
    const { collector } = setup({ env: { KEEL_OTLP_MAX_BODY_BYTES: '100' } });
    const port = await collector.start();
    const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(trace),
    }).catch(() => null);
    // Either a 413, or the connection is cut mid-upload. Never a 200.
    expect(response === null || response.status === 413).toBe(true);
  });

  it('pushes each source as its own set, and nothing for a trace pipeline that never sent anything', async () => {
    const { collector, pushed } = setup({
      kube: () => Promise.resolve([{ metadata: { name: 'pricing' }, status: { readyReplicas: 1 } }]),
    });
    await collector.start();
    await collector.tick();

    expect(pushed.map((p) => p.set.source)).toEqual(['kubernetes']);
    expect(pushed[0]?.set.nodes).toEqual([{ ref: 'pricing', replicas: 1 }]);
  });

  it('skips a Kubernetes round that fails instead of reporting an empty cluster', async () => {
    const { collector, pushed, logs } = setup({ kube: () => Promise.reject(new Error('Kubernetes API 403')) });
    collector.ingest(trace);
    await collector.start();
    await collector.tick();

    expect(pushed.map((p) => p.set.source)).toEqual(['otel']);
    expect(logs.some((l) => l.includes('kubernetes: skipped this round: Kubernetes API 403'))).toBe(true);
  });
});
