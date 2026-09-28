import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { ObservationSet } from '@keel/shared';
import { sourceName, type CollectorConfig } from './config.ts';
import type { KeelClient } from './keel-client.ts';
import { mapWorkloads, type Workload } from './kubernetes.ts';
import { parseOtlpTraces } from './otlp.ts';
import { ServiceGraph } from './service-graph.ts';

export interface CollectorDeps {
  config: CollectorConfig;
  keel: KeelClient;
  /** Null when the Kubernetes source is off. */
  kube: { listWorkloads(): Promise<Workload[]> } | null;
  log: (message: string) => void;
  now?: () => number;
}

/**
 * One process, two sources, one push loop.
 *
 * Each source is pushed as its own observation set, so Keel keeps them apart:
 * a trace pipeline going quiet never erases what the cluster reported, and the
 * reverse. A source that fails to collect this round is skipped rather than
 * pushed empty, because an empty set would tell every open canvas that the
 * whole system just disappeared.
 */
export class Collector {
  readonly #deps: CollectorDeps;
  readonly #graph: ServiceGraph;
  readonly #now: () => number;
  #server: http.Server | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;

  constructor(deps: CollectorDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    const { otlp } = deps.config;
    this.#graph = new ServiceGraph({
      pairTimeoutMs: otlp.pairTimeoutMs,
      sampleRatio: otlp.sampleRatio,
      idleRetentionMs: otlp.idleRetentionMs,
      now: this.#now,
    });
  }

  /** Start the OTLP receiver (if enabled) and the push loop. Resolves with the receiver's port. */
  async start(): Promise<number | null> {
    let port: number | null = null;
    if (this.#deps.config.otlp.enabled) {
      this.#server = http.createServer((request, response) => void this.#handle(request, response));
      await new Promise<void>((resolve) => this.#server?.listen(this.#deps.config.otlp.port, this.#deps.config.otlp.host, resolve));
      port = (this.#server.address() as AddressInfo).port;
      this.#deps.log(`OTLP/HTTP receiver listening on ${this.#deps.config.otlp.host}:${port} (POST /v1/traces, JSON)`);
    }

    this.#timer = setInterval(() => void this.tick(), this.#deps.config.pushIntervalMs);
    // First report straight away rather than one interval late.
    void this.tick();
    return port;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    this.#server = null;
  }

  /** One collection round. Overlapping rounds are skipped, not queued. */
  tick(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#collect().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Feed spans directly, bypassing HTTP. */
  ingest(body: unknown): number {
    const spans = parseOtlpTraces(body);
    this.#graph.ingest(spans);
    return spans.length;
  }

  async #collect(): Promise<void> {
    const { config, keel, kube, log } = this.#deps;
    const observedAt = new Date(this.#now()).toISOString();
    const sets: ObservationSet[] = [];

    if (kube) {
      try {
        const nodes = mapWorkloads(await kube.listWorkloads());
        sets.push({ source: sourceName('kubernetes', config.cluster), observedAt, nodes });
      } catch (error) {
        log(`kubernetes: skipped this round: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (config.otlp.enabled && this.#graph.hasData) {
      const { nodes, edges } = this.#graph.snapshot();
      sets.push({ source: sourceName('otel', config.cluster), observedAt, nodes, edges });
    }

    for (const set of sets) {
      const results = await keel.push(config.roomIds, set);
      for (const result of results) {
        if (result.ok) log(`${set.source}: pushed ${set.nodes?.length ?? 0} nodes, ${set.edges?.length ?? 0} edges to ${result.roomId}`);
        else log(`${set.source}: push to ${result.roomId} failed (${result.status ?? 'network'}): ${result.error ?? ''}`);
      }
    }
  }

  async #handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (request.method === 'GET' && request.url === '/health') return reply(200, { status: 'ok' });
    if (request.method !== 'POST' || request.url?.split('?')[0] !== '/v1/traces') return reply(404, { error: 'not found' });

    const type = request.headers['content-type'] ?? '';
    if (!type.startsWith('application/json')) {
      // The exporter's own retry would resend the same protobuf forever.
      return reply(415, { error: 'only OTLP/HTTP JSON is accepted; set `encoding: json` on the otlphttp exporter' });
    }

    try {
      const raw = await readBody(request, this.#deps.config.otlp.maxBodyBytes);
      const encoding = request.headers['content-encoding'];
      const decoded = encoding === 'gzip' ? gunzipSync(raw) : encoding === 'deflate' ? inflateSync(raw) : raw;
      this.ingest(JSON.parse(decoded.toString('utf8')));
      // An empty ExportTraceServiceResponse: everything accepted.
      reply(200, {});
    } catch (error) {
      reply(error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof Error ? error.message : 'bad request' });
    }
  }
}

class BodyTooLarge extends Error {}

function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge(`export larger than ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
