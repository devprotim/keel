import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { NodeObservation } from '@keel/shared';

/**
 * Kubernetes workloads as Keel observations.
 *
 * The one fact a cluster knows for certain is how many ready replicas each
 * workload has, and that is exactly the number a diagram most often gets wrong
 * (someone scales a deployment down, and the box still says 3). Everything
 * else here is opt-in through annotations on the workload itself.
 */

/** Annotations a workload can carry. All optional. */
export const ANNOTATIONS = {
  /** The Keel runtime name (a node's `ref`) this workload reports as. */
  ref: 'keel.dev/ref',
  /** "true" leaves the workload out entirely. */
  ignore: 'keel.dev/ignore',
  hasReplica: 'keel.dev/has-replica',
  hasBackup: 'keel.dev/has-backup',
  hasDlq: 'keel.dev/has-dlq',
} as const;

/** The subset of a Deployment or StatefulSet this reads. */
export interface Workload {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: { replicas?: number };
  status?: { readyReplicas?: number };
}

/**
 * Map workloads to node observations, one per ref.
 *
 * The ref is, in order: the `keel.dev/ref` annotation, the standard
 * `app.kubernetes.io/name` label, the workload's name. Workloads sharing a
 * ref (a canary beside the stable deployment, or one service in two
 * namespaces) are one component to the diagram, so their ready replicas add up.
 */
export function mapWorkloads(workloads: readonly Workload[]): NodeObservation[] {
  const byRef = new Map<string, NodeObservation>();

  for (const workload of workloads) {
    const annotations = workload.metadata.annotations ?? {};
    if (annotations[ANNOTATIONS.ignore] === 'true') continue;

    const ref = (
      annotations[ANNOTATIONS.ref] ??
      workload.metadata.labels?.['app.kubernetes.io/name'] ??
      workload.metadata.name
    ).trim();
    if (ref === '' || ref.length > 200) continue;

    // Ready, not desired: a deployment asking for 3 with 1 ready is a single
    // point of failure right now, whatever its spec says.
    const ready = workload.status?.readyReplicas ?? 0;
    const existing = byRef.get(ref);
    const observation: NodeObservation = existing ?? { ref, replicas: 0 };
    observation.replicas = (observation.replicas ?? 0) + ready;

    for (const field of ['hasReplica', 'hasBackup', 'hasDlq'] as const) {
      const value = parseFlag(annotations[ANNOTATIONS[field]]);
      if (value !== undefined) observation[field] = value;
    }
    byRef.set(ref, observation);
  }

  return [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

function parseFlag(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export interface KubeClientOptions {
  /** API server base URL. In-cluster, derived from the service environment. */
  apiUrl: string;
  /** Re-read on every request: projected service-account tokens rotate. */
  tokenFile?: string;
  caFile?: string;
  /** Namespaces to read. Empty means all, which needs a ClusterRole. */
  namespaces: readonly string[];
}

/** Options for running inside a pod, from the standard service-account mount. */
export function inClusterOptions(env: NodeJS.ProcessEnv, namespaces: readonly string[]): KubeClientOptions | null {
  const host = env['KUBERNETES_SERVICE_HOST'];
  const port = env['KUBERNETES_SERVICE_PORT'] ?? '443';
  if (!host) return null;
  const mount = '/var/run/secrets/kubernetes.io/serviceaccount';
  return {
    apiUrl: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    tokenFile: `${mount}/token`,
    caFile: `${mount}/ca.crt`,
    namespaces,
  };
}

/** Lists workloads with plain HTTPS. No client library: two GETs don't need one. */
export class KubeClient {
  readonly #options: KubeClientOptions;
  readonly #ca: Buffer | undefined;

  constructor(options: KubeClientOptions) {
    this.#options = options;
    this.#ca = options.caFile ? readFileSync(options.caFile) : undefined;
  }

  async listWorkloads(): Promise<Workload[]> {
    const scopes = this.#options.namespaces.length > 0 ? this.#options.namespaces.map((ns) => `/namespaces/${encodeURIComponent(ns)}`) : [''];
    const lists = await Promise.all(
      scopes.flatMap((scope) => [
        this.#get<{ items: Workload[] }>(`/apis/apps/v1${scope}/deployments`),
        this.#get<{ items: Workload[] }>(`/apis/apps/v1${scope}/statefulsets`),
      ]),
    );
    return lists.flatMap((list) => list.items);
  }

  #get<T>(path: string): Promise<T> {
    const url = new URL(path, this.#options.apiUrl);
    const token = this.#options.tokenFile ? readFileSync(this.#options.tokenFile, 'utf8').trim() : undefined;
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise<T>((resolve, reject) => {
      const request = transport.get(
        url,
        {
          headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          ...(this.#ca ? { ca: this.#ca } : {}),
          timeout: 10_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if ((response.statusCode ?? 0) >= 400) {
              reject(new Error(`Kubernetes API ${response.statusCode} for ${path}: ${body.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(body) as T);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error(`Kubernetes API timed out for ${path}`)));
      request.on('error', reject);
    });
  }
}
