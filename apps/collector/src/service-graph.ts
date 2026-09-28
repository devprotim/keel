import type { EdgeObservation, NodeObservation } from '@keel/shared';
import type { Span } from './otlp.ts';

/**
 * Traces folded into who-calls-whom, how often, and how slowly.
 *
 * An edge is a caller's CLIENT (or PRODUCER) span paired with the callee's
 * SERVER (or CONSUMER) span that names it as parent. The two halves come from
 * different processes and arrive in any order, often in different export
 * batches, so each waits up to `pairTimeoutMs` for the other. A caller span
 * that never finds its server half (a database, a third-party API) is
 * attributed to whatever its attributes name as the peer, if anything.
 *
 * Latency is the caller's view, since that is what a caller's timeout is
 * measured against.
 */

export interface ServiceGraphOptions {
  pairTimeoutMs: number;
  /**
   * Fraction of traces the pipeline keeps. Rates are scaled up by its
   * inverse; latency percentiles are unaffected by uniform sampling.
   */
  sampleRatio: number;
  /**
   * How long a component or call keeps being reported, at 0 rps, after it
   * was last seen. "Seen recently, idle now" is worth saying, since observed
   * zero traffic demotes findings. Silence beyond this means no data.
   */
  idleRetentionMs: number;
  /** Latency samples kept per edge per window, reservoir-sampled beyond this. */
  maxSamples?: number;
  now?: () => number;
}

interface PendingCall {
  service: string;
  peer: string | null;
  durationMs: number;
  expiresAt: number;
}
interface PendingServe {
  service: string;
  expiresAt: number;
}

interface EdgeWindow {
  count: number;
  samples: number[];
}

export interface GraphSnapshot {
  nodes: NodeObservation[];
  edges: EdgeObservation[];
  /** Seconds of traffic this snapshot averages over. */
  windowSeconds: number;
}

export class ServiceGraph {
  readonly #options: Required<ServiceGraphOptions>;
  /** Keyed by traceId + spanId of the caller's span. */
  readonly #calls = new Map<string, PendingCall>();
  /** Keyed by traceId + parentSpanId: a server half waiting for its caller. */
  readonly #serves = new Map<string, PendingServe>();

  #edges = new Map<string, EdgeWindow>();
  #served = new Map<string, number>();
  /**
   * Only services seen *serving* are reported as nodes. A cron job that only
   * calls out, or a database named by its callers, has no request rate this
   * can measure, and reporting 0 for it would read as "idle" and demote its
   * findings.
   */
  readonly #lastSeenNode = new Map<string, number>();
  readonly #lastSeenEdge = new Map<string, number>();
  #windowStart: number;
  #everSawTraffic = false;

  constructor(options: ServiceGraphOptions) {
    this.#options = { maxSamples: 5000, now: () => Date.now(), ...options };
    this.#windowStart = this.#options.now();
  }

  /** True once any span has been ingested, so an idle collector never pushes an empty set over real data. */
  get hasData(): boolean {
    return this.#everSawTraffic;
  }

  ingest(spans: readonly Span[]): void {
    const now = this.#options.now();
    for (const span of spans) {
      this.#everSawTraffic = true;

      if (span.kind === 'server' || span.kind === 'consumer') {
        this.#served.set(span.service, (this.#served.get(span.service) ?? 0) + 1);
        this.#lastSeenNode.set(span.service, now);
        if (!span.parentSpanId) continue;

        const key = `${span.traceId}:${span.parentSpanId}`;
        const call = this.#calls.get(key);
        if (call) {
          this.#calls.delete(key);
          this.#record(call.service, span.service, call.durationMs, now);
        } else {
          this.#serves.set(key, { service: span.service, expiresAt: now + this.#options.pairTimeoutMs });
        }
      } else if (span.kind === 'client' || span.kind === 'producer') {
        const key = `${span.traceId}:${span.spanId}`;
        const serve = this.#serves.get(key);
        if (serve) {
          this.#serves.delete(key);
          this.#record(span.service, serve.service, span.durationMs, now);
        } else {
          this.#calls.set(key, {
            service: span.service,
            peer: span.peer,
            durationMs: span.durationMs,
            expiresAt: now + this.#options.pairTimeoutMs,
          });
        }
      }
    }
    this.#expire(now);
  }

  /**
   * Close the current window and report it. Rates are per second over the
   * window; the next window starts empty.
   */
  snapshot(): GraphSnapshot {
    const now = this.#options.now();
    this.#expire(now);
    const windowSeconds = Math.max((now - this.#windowStart) / 1000, 1e-3);
    const scale = 1 / this.#options.sampleRatio;
    const rate = (count: number) => round((count * scale) / windowSeconds, 3);

    const nodes: NodeObservation[] = [];
    for (const [ref, seen] of this.#lastSeenNode) {
      if (now - seen > this.#options.idleRetentionMs) {
        this.#lastSeenNode.delete(ref);
        continue;
      }
      nodes.push({ ref, rps: rate(this.#served.get(ref) ?? 0) });
    }

    const edges: EdgeObservation[] = [];
    for (const [key, seen] of this.#lastSeenEdge) {
      if (now - seen > this.#options.idleRetentionMs) {
        this.#lastSeenEdge.delete(key);
        continue;
      }
      const [source = '', target = ''] = key.split('\u0000');
      const window = this.#edges.get(key);
      const edge: EdgeObservation = { source, target, rps: rate(window?.count ?? 0) };
      if (window && window.samples.length > 0) edge.p99Ms = round(percentile(window.samples, 0.99), 1);
      edges.push(edge);
    }

    this.#edges = new Map();
    this.#served = new Map();
    this.#windowStart = now;

    nodes.sort((a, b) => a.ref.localeCompare(b.ref));
    edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
    return { nodes, edges, windowSeconds: round(windowSeconds, 3) };
  }

  #record(source: string, target: string, durationMs: number, now: number): void {
    if (source === target) return;
    const key = `${source}\u0000${target}`;
    let window = this.#edges.get(key);
    if (!window) {
      window = { count: 0, samples: [] };
      this.#edges.set(key, window);
    }
    window.count += 1;
    // Reservoir sampling keeps the percentile honest under heavy traffic
    // without the window's memory growing with it.
    if (window.samples.length < this.#options.maxSamples) window.samples.push(durationMs);
    else {
      const slot = Math.floor(Math.random() * window.count);
      if (slot < this.#options.maxSamples) window.samples[slot] = durationMs;
    }
    this.#lastSeenEdge.set(key, now);
  }

  /** A caller span that never met its server half counts against its named peer. */
  #expire(now: number): void {
    for (const [key, call] of this.#calls) {
      if (call.expiresAt > now) continue;
      this.#calls.delete(key);
      if (call.peer) this.#record(call.service, call.peer, call.durationMs, now);
    }
    for (const [key, serve] of this.#serves) {
      if (serve.expiresAt <= now) this.#serves.delete(key);
    }
  }
}

/** Nearest-rank percentile. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[rank] ?? 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
