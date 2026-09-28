/** Build OTLP JSON the way SDK exporters send it: nanosecond strings, integer kinds. */
export interface SpanSpec {
  service: string;
  traceId?: string;
  spanId: string;
  parentSpanId?: string;
  kind: 1 | 2 | 3 | 4 | 5;
  startMs?: number;
  durationMs: number;
  attributes?: Record<string, string>;
}

export function otlpExport(spans: readonly SpanSpec[]): unknown {
  const byService = new Map<string, SpanSpec[]>();
  for (const span of spans) byService.set(span.service, [...(byService.get(span.service) ?? []), span]);

  return {
    resourceSpans: [...byService].map(([service, list]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [
        {
          scope: { name: 'test' },
          spans: list.map((span) => {
            const start = BigInt(Math.round((span.startMs ?? 1_790_000_000_000) * 1e6));
            const end = start + BigInt(Math.round(span.durationMs * 1e6));
            return {
              traceId: span.traceId ?? '0af7651916cd43dd8448eb211c80319c',
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: 'op',
              kind: span.kind,
              startTimeUnixNano: start.toString(),
              endTimeUnixNano: end.toString(),
              attributes: Object.entries(span.attributes ?? {}).map(([key, value]) => ({ key, value: { stringValue: value } })),
            };
          }),
        },
      ],
    })),
  };
}
