import { describe, expect, it } from 'vitest';
import { otlpExport, type SpanSpec } from './fixtures.ts';
import { parseOtlpTraces } from './otlp.ts';
import { ServiceGraph } from './service-graph.ts';

function graph(options: Partial<ConstructorParameters<typeof ServiceGraph>[0]> = {}) {
  let now = 0;
  const g = new ServiceGraph({ pairTimeoutMs: 5000, sampleRatio: 1, idleRetentionMs: 60_000, now: () => now, ...options });
  return {
    g,
    feed: (spans: SpanSpec[]) => g.ingest(parseOtlpTraces(otlpExport(spans))),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const call = (i: number, durationMs = 20): SpanSpec[] => [
  { service: 'checkout', traceId: `t${i}`, spanId: `c${i}`, kind: 3, durationMs },
  { service: 'pricing', traceId: `t${i}`, spanId: `s${i}`, parentSpanId: `c${i}`, kind: 2, durationMs: durationMs / 2 },
];

describe('ServiceGraph', () => {
  it('pairs a caller with its callee into an edge with rate and caller-side p99', () => {
    const { g, feed, advance } = graph();
    for (let i = 0; i < 100; i += 1) feed(call(i, i + 1));
    advance(10_000);

    const snapshot = g.snapshot();
    expect(snapshot.edges).toEqual([{ source: 'checkout', target: 'pricing', rps: 10, p99Ms: 99, errorRate: 0 }]);
    expect(snapshot.nodes).toEqual([{ ref: 'pricing', rps: 10, errorRate: 0 }]);
  });

  it('reports the share of calls that failed, as the caller saw them and as the callee served them', () => {
    const { g, feed, advance } = graph();
    for (let i = 0; i < 20; i += 1) {
      const [client, server] = call(i);
      // A quarter of the calls fail on the caller's side; a tenth fail inside pricing.
      feed([{ ...client!, error: i % 4 === 0 }, { ...server!, error: i % 10 === 0 }]);
    }
    advance(1000);

    const snapshot = g.snapshot();
    expect(snapshot.edges[0]?.errorRate).toBe(0.25);
    expect(snapshot.nodes[0]?.errorRate).toBe(0.1);
  });

  it('pairs halves that arrive in either order, in separate exports', () => {
    const { g, feed, advance } = graph();
    const [client, server] = call(1);
    feed([server!]);
    feed([client!]);
    advance(1000);
    expect(g.snapshot().edges.map((e) => `${e.source}->${e.target}`)).toEqual(['checkout->pricing']);
  });

  it('attributes a call to an uninstrumented peer once pairing times out', () => {
    const { g, feed, advance } = graph();
    feed([{ service: 'catalog', spanId: 'q', kind: 3, durationMs: 3, attributes: { 'db.namespace': 'catalog-db' } }]);
    advance(1000);
    expect(g.snapshot().edges).toEqual([]);
    advance(5000);
    expect(g.snapshot().edges.map((e) => e.target)).toEqual(['catalog-db']);
  });

  it('does not report a request rate for services only seen calling out', () => {
    const { g, feed, advance } = graph();
    feed([{ service: 'nightly-job', spanId: 'x', kind: 3, durationMs: 1, attributes: { 'peer.service': 'billing' } }]);
    advance(6000);
    expect(g.snapshot().nodes).toEqual([]);
  });

  it('reports a recently busy component at 0 rps, then forgets it', () => {
    const { g, feed, advance } = graph({ idleRetentionMs: 30_000 });
    feed(call(1));
    advance(10_000);
    g.snapshot();

    advance(10_000);
    const idle = g.snapshot();
    expect(idle.nodes).toEqual([{ ref: 'pricing', rps: 0 }]);
    expect(idle.edges).toEqual([{ source: 'checkout', target: 'pricing', rps: 0 }]);

    advance(40_000);
    expect(g.snapshot()).toMatchObject({ nodes: [], edges: [] });
  });

  it('scales rates up by the sampling ratio', () => {
    const { g, feed, advance } = graph({ sampleRatio: 0.1 });
    for (let i = 0; i < 10; i += 1) feed(call(i));
    advance(10_000);
    expect(g.snapshot().edges[0]?.rps).toBe(10);
  });

  it('ignores calls a service makes to itself', () => {
    const { g, feed, advance } = graph();
    feed([
      { service: 'a', traceId: 't', spanId: 'c', kind: 3, durationMs: 1 },
      { service: 'a', traceId: 't', spanId: 's', parentSpanId: 'c', kind: 2, durationMs: 1 },
    ]);
    advance(1000);
    expect(g.snapshot().edges).toEqual([]);
  });

  it('keeps latency memory bounded under heavy traffic', () => {
    const { g, feed, advance } = graph({ maxSamples: 50 });
    for (let i = 0; i < 2000; i += 1) feed(call(i, 10));
    advance(1000);
    const edge = g.snapshot().edges[0];
    expect(edge?.rps).toBe(2000);
    expect(edge?.p99Ms).toBe(10);
  });
});
