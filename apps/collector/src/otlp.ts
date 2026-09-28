/**
 * OTLP trace export, JSON encoding, reduced to what a service graph needs.
 *
 * Only JSON: decoding protobuf would mean vendoring the OTLP schema and a
 * protobuf runtime. The OpenTelemetry Collector's `otlphttp` exporter and
 * every SDK's HTTP exporter can send JSON (`encoding: json`).
 */

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer' | 'unspecified';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  /** `service.name` of the resource that emitted the span. */
  service: string;
  kind: SpanKind;
  durationMs: number;
  /** When the span ended, in epoch milliseconds. */
  endMs: number;
  /** Attributes that can name the far end of a call whose server is not instrumented. */
  peer: string | null;
  /** The call failed, by the span's own status. */
  error: boolean;
}

/** Numbers per the OTLP proto; JSON encoding requires integers, some senders use names. */
const KINDS: Record<string, SpanKind> = {
  '0': 'unspecified',
  '1': 'internal',
  '2': 'server',
  '3': 'client',
  '4': 'producer',
  '5': 'consumer',
  SPAN_KIND_UNSPECIFIED: 'unspecified',
  SPAN_KIND_INTERNAL: 'internal',
  SPAN_KIND_SERVER: 'server',
  SPAN_KIND_CLIENT: 'client',
  SPAN_KIND_PRODUCER: 'producer',
  SPAN_KIND_CONSUMER: 'consumer',
};

/**
 * Where an uninstrumented callee's name comes from, most specific first.
 * `peer.service` is set deliberately by the caller; the rest are semantic
 * conventions for databases, queues and plain HTTP.
 */
const PEER_ATTRIBUTES = ['peer.service', 'db.namespace', 'db.name', 'messaging.destination.name', 'server.address', 'net.peer.name'];

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  boolValue?: boolean;
  doubleValue?: number;
}
interface KeyValue {
  key: string;
  value?: AnyValue;
}
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  status?: { code?: number | string };
}
interface OtlpExport {
  resourceSpans?: {
    resource?: { attributes?: KeyValue[] };
    scopeSpans?: { spans?: OtlpSpan[] }[];
    /** Pre-1.0 name for scopeSpans, still sent by some older SDKs. */
    instrumentationLibrarySpans?: { spans?: OtlpSpan[] }[];
  }[];
}

/** Parse one export request. Malformed spans are skipped, not fatal. */
export function parseOtlpTraces(body: unknown): Span[] {
  if (typeof body !== 'object' || body === null) throw new Error('expected an OTLP ExportTraceServiceRequest object');
  const spans: Span[] = [];

  for (const resourceSpans of (body as OtlpExport).resourceSpans ?? []) {
    const service = attribute(resourceSpans.resource?.attributes, 'service.name');
    if (!service) continue;

    const scopes = [...(resourceSpans.scopeSpans ?? []), ...(resourceSpans.instrumentationLibrarySpans ?? [])];
    for (const scope of scopes) {
      for (const span of scope.spans ?? []) {
        if (!span.traceId || !span.spanId) continue;
        const start = nanosToMs(span.startTimeUnixNano);
        const end = nanosToMs(span.endTimeUnixNano);
        if (start === null || end === null || end < start) continue;

        spans.push({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ? span.parentSpanId : null,
          service,
          kind: KINDS[String(span.kind ?? 0)] ?? 'unspecified',
          durationMs: end - start,
          endMs: end,
          peer: peerOf(span.attributes),
          error: String(span.status?.code) === '2' || span.status?.code === 'STATUS_CODE_ERROR',
        });
      }
    }
  }
  return spans;
}

function attribute(attributes: KeyValue[] | undefined, key: string): string | null {
  const value = attributes?.find((a) => a.key === key)?.value;
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return String(value.intValue);
  return null;
}

function peerOf(attributes: KeyValue[] | undefined): string | null {
  for (const key of PEER_ATTRIBUTES) {
    const value = attribute(attributes, key);
    if (!value) continue;
    // A cluster DNS name is the service name plus routing noise.
    if (key === 'server.address' || key === 'net.peer.name') {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':')) continue;
      return value.split('.')[0] ?? null;
    }
    return value;
  }
  return null;
}

/** Nanosecond timestamps exceed 2^53, so they arrive as strings and are cut to ms before converting. */
function nanosToMs(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return value / 1e6;
  if (!/^\d+$/.test(value)) return null;
  return Number(BigInt(value) / 1000n) / 1000;
}
