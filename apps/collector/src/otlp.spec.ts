import { describe, expect, it } from 'vitest';
import { otlpExport } from './fixtures.ts';
import { parseOtlpTraces } from './otlp.ts';

describe('parseOtlpTraces', () => {
  it('reads service, kind, duration and parent from an SDK-shaped export', () => {
    const spans = parseOtlpTraces(
      otlpExport([
        { service: 'checkout', spanId: 'aaaa', kind: 3, durationMs: 42.5, attributes: { 'peer.service': 'stripe' } },
        { service: 'pricing', spanId: 'bbbb', parentSpanId: 'aaaa', kind: 2, durationMs: 40 },
      ]),
    );
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ service: 'checkout', kind: 'client', peer: 'stripe', parentSpanId: null });
    expect(spans[0]?.durationMs).toBeCloseTo(42.5, 3);
    expect(spans[1]).toMatchObject({ service: 'pricing', kind: 'server', parentSpanId: 'aaaa' });
  });

  it('names an uninstrumented peer from semantic-convention attributes', () => {
    const peers = parseOtlpTraces(
      otlpExport([
        { service: 'a', spanId: '1', kind: 3, durationMs: 1, attributes: { 'db.namespace': 'catalog' } },
        { service: 'a', spanId: '2', kind: 3, durationMs: 1, attributes: { 'server.address': 'orders.prod.svc.cluster.local' } },
        { service: 'a', spanId: '3', kind: 3, durationMs: 1, attributes: { 'server.address': '10.0.0.7' } },
      ]),
    ).map((s) => s.peer);
    expect(peers).toEqual(['catalog', 'orders', null]);
  });

  it('accepts string kind names and skips spans it cannot time', () => {
    const spans = parseOtlpTraces({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] },
          scopeSpans: [
            {
              spans: [
                { traceId: 't', spanId: '1', kind: 'SPAN_KIND_SERVER', startTimeUnixNano: '1000000', endTimeUnixNano: '3000000' },
                { traceId: 't', spanId: '2', kind: 2 },
                { spanId: '3', kind: 2, startTimeUnixNano: '1', endTimeUnixNano: '2' },
              ],
            },
          ],
        },
      ],
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: 'server', durationMs: 2 });
  });

  it('ignores resources with no service.name, and rejects a non-object', () => {
    expect(parseOtlpTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 't', spanId: 's' }] }] }] })).toEqual([]);
    expect(() => parseOtlpTraces('nope')).toThrow();
  });
});
