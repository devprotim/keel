import type { ObservationSet } from '@keel/shared';

/** The server's bounds (ObservationSetSchema in apps/server/src/app.ts). */
export const MAX_NODES = 500;
export const MAX_EDGES = 1500;

export interface PushResult {
  roomId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Posts observation sets to one or more Keel rooms.
 *
 * Retries only what a retry can fix: network errors, 429 and 5xx. A 400 means
 * this collector sent something the server will never accept, and retrying it
 * just repeats the failure.
 */
export class KeelClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(baseUrl: string, deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = deps.fetch ?? fetch;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async push(roomIds: readonly string[], set: ObservationSet): Promise<PushResult[]> {
    const body = JSON.stringify(bounded(set));
    return Promise.all(roomIds.map((roomId) => this.#pushOne(roomId, body)));
  }

  async #pushOne(roomId: string, body: string): Promise<PushResult> {
    const url = `${this.#baseUrl}/api/rooms/${encodeURIComponent(roomId)}/observations`;
    let last: PushResult = { roomId, ok: false };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await this.#sleep(500 * 2 ** (attempt - 1));
      try {
        const response = await this.#fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return { roomId, ok: true, status: response.status };
        last = { roomId, ok: false, status: response.status, error: (await response.text()).slice(0, 300) };
        if (response.status !== 429 && response.status < 500) return last;
      } catch (error) {
        last = { roomId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return last;
  }
}

/**
 * Keep a set inside the server's bounds, busiest first, so a large cluster
 * reports its most important components rather than being refused outright.
 */
export function bounded(set: ObservationSet): ObservationSet {
  const byTraffic = <T extends { rps?: number }>(items: T[]) => [...items].sort((a, b) => (b.rps ?? 0) - (a.rps ?? 0));
  return {
    ...set,
    ...(set.nodes ? { nodes: set.nodes.length > MAX_NODES ? byTraffic(set.nodes).slice(0, MAX_NODES) : set.nodes } : {}),
    ...(set.edges ? { edges: set.edges.length > MAX_EDGES ? byTraffic(set.edges).slice(0, MAX_EDGES) : set.edges } : {}),
  };
}
