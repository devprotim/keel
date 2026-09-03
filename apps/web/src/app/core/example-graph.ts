import { createEdge, createNode, type ArchEdge, type ArchNode } from '@keel/shared';

/**
 * A seed diagram for an empty room.
 *
 * Deliberately imperfect. A flawless example would show an empty findings panel,
 * which teaches the visitor nothing about what the tool is for. This one is a
 * plausible mid-size checkout system carrying the failure modes that actually
 * take services down: an unbounded call, a shared database, a single-instance
 * dependency on the critical path, and a queue with nowhere to put poison
 * messages.
 */
export function exampleGraph(): { nodes: ArchNode[]; edges: ArchEdge[] } {
  const node = (
    id: string,
    kind: Parameters<typeof createNode>[0],
    label: string,
    x: number,
    y: number,
    extra: Partial<ArchNode> = {},
  ): ArchNode => ({ ...createNode(kind, x, y), id, label, ...extra });

  const nodes: ArchNode[] = [
    node('n_web', 'external', 'Web & mobile', 40, 240),
    node('n_gateway', 'gateway', 'API gateway', 280, 240, { replicas: 3, tech: 'Envoy' }),

    node('n_checkout', 'service', 'Checkout', 540, 140, {
      replicas: 4,
      tech: 'Node / Fastify',
      critical: true,
    }),
    node('n_catalog', 'service', 'Catalog', 540, 360, { replicas: 3, tech: 'Node' }),

    // One instance, on the critical path, called synchronously by two services.
    node('n_pricing', 'service', 'Pricing engine', 820, 240, {
      replicas: 1,
      tech: 'Python',
      critical: true,
    }),

    node('n_orders_db', 'datastore', 'Orders DB', 820, 60, {
      replicas: 2,
      tech: 'Postgres 16',
      hasReplica: true,
      hasBackup: true,
    }),

    // Written by two services, and protected by neither replication nor backups.
    node('n_catalog_db', 'datastore', 'Catalog DB', 820, 440, { tech: 'Postgres 16' }),

    node('n_events', 'queue', 'Order events', 1080, 140, { replicas: 3, tech: 'Kafka' }),
    node('n_fulfilment', 'service', 'Fulfilment', 1320, 140, { replicas: 2 }),
    node('n_search_indexer', 'job', 'Search indexer', 1320, 360, { replicas: 1 }),

    node('n_stripe', 'external', 'Stripe', 540, 20),
  ];

  const edge = (
    id: string,
    source: string,
    target: string,
    kind: Parameters<typeof createEdge>[2],
    extra: Partial<ArchEdge> = {},
  ): ArchEdge => ({ ...createEdge(source, target, kind), id, ...extra });

  const edges: ArchEdge[] = [
    edge('e_web_gw', 'n_web', 'n_gateway', 'sync', { timeoutMs: 10_000 }),
    edge('e_gw_checkout', 'n_gateway', 'n_checkout', 'sync', { timeoutMs: 3000, retries: 1 }),
    edge('e_gw_catalog', 'n_gateway', 'n_catalog', 'sync', { timeoutMs: 2000, retries: 1 }),

    // No timeout, into a single-instance service, from the critical path.
    edge('e_checkout_pricing', 'n_checkout', 'n_pricing', 'sync'),
    edge('e_catalog_pricing', 'n_catalog', 'n_pricing', 'sync', { timeoutMs: 800, retries: 4 }),

    // Payment provider called with no circuit breaker.
    edge('e_checkout_stripe', 'n_checkout', 'n_stripe', 'sync', { timeoutMs: 5000, retries: 2 }),

    edge('e_checkout_db', 'n_checkout', 'n_orders_db', 'sync', { timeoutMs: 500 }),
    edge('e_catalog_db', 'n_catalog', 'n_catalog_db', 'sync', { timeoutMs: 500 }),

    // A second writer on the catalog database.
    edge('e_indexer_db', 'n_search_indexer', 'n_catalog_db', 'sync', { timeoutMs: 1000 }),

    edge('e_checkout_events', 'n_checkout', 'n_events', 'async'),
    edge('e_events_fulfilment', 'n_events', 'n_fulfilment', 'async', { idempotent: true }),
    edge('e_events_indexer', 'n_events', 'n_search_indexer', 'async'),
  ];

  return { nodes, edges };
}
