import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { KubeClient, mapWorkloads, type Workload } from './kubernetes.ts';

const workload = (name: string, ready: number | undefined, extra: Partial<Workload['metadata']> = {}): Workload => ({
  metadata: { name, namespace: 'prod', ...extra },
  spec: { replicas: 3 },
  status: ready === undefined ? {} : { readyReplicas: ready },
});

describe('mapWorkloads', () => {
  it('reports ready replicas, not desired ones', () => {
    expect(mapWorkloads([workload('orders', 1), workload('scaled-to-zero', undefined)])).toEqual([
      { ref: 'orders', replicas: 1 },
      { ref: 'scaled-to-zero', replicas: 0 },
    ]);
  });

  it('prefers the keel.dev/ref annotation, then the standard name label', () => {
    const refs = mapWorkloads([
      workload('orders-v2', 2, { annotations: { 'keel.dev/ref': 'orders' } }),
      workload('pricing-7d9f', 2, { labels: { 'app.kubernetes.io/name': 'pricing' } }),
    ]).map((o) => o.ref);
    expect(refs).toEqual(['orders', 'pricing']);
  });

  it('adds up workloads that share a ref, such as a canary', () => {
    const [orders] = mapWorkloads([
      workload('orders', 3, { labels: { 'app.kubernetes.io/name': 'orders' } }),
      workload('orders-canary', 1, { labels: { 'app.kubernetes.io/name': 'orders' } }),
    ]);
    expect(orders).toEqual({ ref: 'orders', replicas: 4 });
  });

  it('reads opt-in facts from annotations and honours keel.dev/ignore', () => {
    expect(
      mapWorkloads([
        workload('catalog-db', 1, { annotations: { 'keel.dev/has-replica': 'false', 'keel.dev/has-backup': 'true' } }),
        workload('debug-shell', 1, { annotations: { 'keel.dev/ignore': 'true' } }),
      ]),
    ).toEqual([{ ref: 'catalog-db', replicas: 1, hasReplica: false, hasBackup: true }]);
  });
});

describe('KubeClient', () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function fakeApi(handler: (url: string, auth: string | undefined) => { status: number; body: unknown }) {
    server = http.createServer((request, response) => {
      const { status, body } = handler(request.url ?? '', request.headers.authorization);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  }

  it('lists deployments and statefulsets, per namespace when scoped', async () => {
    const seen: string[] = [];
    const apiUrl = await fakeApi((url) => {
      seen.push(url);
      return { status: 200, body: { items: [workload(url.includes('statefulsets') ? 'db' : 'api', 1)] } };
    });
    const client = new KubeClient({ apiUrl, namespaces: ['prod', 'jobs'] });
    const workloads = await client.listWorkloads();

    expect(seen.sort()).toEqual([
      '/apis/apps/v1/namespaces/jobs/deployments',
      '/apis/apps/v1/namespaces/jobs/statefulsets',
      '/apis/apps/v1/namespaces/prod/deployments',
      '/apis/apps/v1/namespaces/prod/statefulsets',
    ]);
    expect(workloads).toHaveLength(4);
  });

  it('surfaces an RBAC refusal instead of reporting an empty cluster', async () => {
    const apiUrl = await fakeApi(() => ({ status: 403, body: { message: 'forbidden' } }));
    await expect(new KubeClient({ apiUrl, namespaces: [] }).listWorkloads()).rejects.toThrow(/403/);
  });
});
