import { approveElement, type ArchGraph, type DesignIntent, type ObservationSet } from '@keel/shared';
import { exampleGraph } from './example-graph';

/**
 * The landing page's "See it on an example": the worked example, approved,
 * with production reporting in, so every mode has something true to show.
 *
 * The story, which is the default demo story until someone picks a better one
 * (PROJECT_PLAN task 12): the design was approved with three Catalog
 * instances. Twenty minutes ago the cluster scaled Catalog down to one. Now
 * the gateway's calls to it run close to their timeout and some fail, and
 * Checkout has started calling Catalog directly, which nobody drew. Findings
 * flag the drift as an accident, incident mode ranks it, and the timeline
 * shows the scale-down that started it.
 */
export interface DemoRoom {
  graph: ArchGraph;
  intent: DesignIntent;
  /** Oldest first, so replaying them logs the scale-down as an event. */
  observations: ObservationSet[];
}

export function demoRoom(now = Date.now()): DemoRoom {
  const graph = exampleGraph();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  const approvedAt = at(60 * 24 * 3);
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const intent: DesignIntent = {};
  for (const node of graph.nodes) intent[node.id] = approveElement(node, 'node', undefined, { by: 'Design review', at: approvedAt });
  for (const edge of graph.edges) {
    intent[edge.id] = approveElement(edge, 'edge', undefined, {
      by: 'Design review',
      at: approvedAt,
      label: `${labels.get(edge.source)} to ${labels.get(edge.target)}`,
    });
  }

  const cluster = (catalogReplicas: number) => [
    { ref: 'api-gateway', replicas: 3 },
    { ref: 'checkout', replicas: 4 },
    { ref: 'catalog', replicas: catalogReplicas },
    { ref: 'pricing', replicas: 1 },
    { ref: 'orders-db', replicas: 2 },
    { ref: 'catalog-db', replicas: 1 },
    { ref: 'order-events', replicas: 3 },
    { ref: 'fulfilment', replicas: 2 },
    { ref: 'search-indexer', replicas: 1 },
  ];

  return {
    graph,
    intent,
    observations: [
      { source: 'kubernetes', observedAt: at(25), nodes: cluster(3) },
      { source: 'kubernetes', observedAt: at(20), nodes: cluster(1) },
      {
        source: 'otel',
        observedAt: at(1),
        nodes: [
          { ref: 'api-gateway', rps: 420, errorRate: 0.01 },
          { ref: 'checkout', rps: 90, errorRate: 0.004 },
          { ref: 'catalog', rps: 330, errorRate: 0.09 },
          { ref: 'pricing', rps: 180 },
        ],
        edges: [
          { source: 'api-gateway', target: 'checkout', rps: 90, p99Ms: 640 },
          { source: 'api-gateway', target: 'catalog', rps: 300, p99Ms: 1850, errorRate: 0.08 },
          { source: 'catalog', target: 'pricing', rps: 150, p99Ms: 520 },
          { source: 'checkout', target: 'pricing', rps: 30, p99Ms: 380 },
          { source: 'catalog', target: 'catalog-db', rps: 280, p99Ms: 45 },
          { source: 'checkout', target: 'catalog', rps: 30, p99Ms: 210 },
        ],
      },
    ],
  };
}
