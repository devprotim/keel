import type { ArchEdge, ArchGraph, ArchNode, EdgeKind, NodeKind } from './types.js';

/**
 * Default box size, in world units. One size for every kind.
 *
 * Kind identity used to be carried partly by silhouette (a cylinder for a
 * datastore, a hexagon for a gateway) and partly by per-kind dimensions. Both
 * made the canvas read as uneven rather than typed. Identity now lives entirely
 * in the kind chip drawn inside the node (see `renderer.ts`), so every node gets
 * the same generous interior instead of some being visibly more cramped than
 * others.
 */
export const DEFAULT_NODE_SIZE = { w: 184, h: 84 };

/** Human-readable default label per kind. */
const DEFAULT_LABEL: Record<NodeKind, string> = {
  service: 'New service',
  datastore: 'New datastore',
  queue: 'New queue',
  cache: 'New cache',
  gateway: 'New gateway',
  job: 'New job',
  external: 'External API',
};

/**
 * Collision-resistant id.
 *
 * Ids are generated on the client and merged by a CRDT without a coordinating
 * server, so they must be unique across peers that have never spoken to each
 * other. `crypto.randomUUID` is available in every target browser and in Node 22.
 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

export function createNode(kind: NodeKind, x: number, y: number, overrides: Partial<ArchNode> = {}): ArchNode {
  return {
    id: newId('n'),
    kind,
    label: DEFAULT_LABEL[kind],
    x,
    y,
    w: DEFAULT_NODE_SIZE.w,
    h: DEFAULT_NODE_SIZE.h,
    // Defaulting to 1 is deliberate. Starting at 2 would silently suppress the
    // single-point-of-failure rule and let the author believe the design is
    // redundant when they never said so.
    replicas: 1,
    ...overrides,
  };
}

export function createEdge(source: string, target: string, kind: EdgeKind = 'sync', overrides: Partial<ArchEdge> = {}): ArchEdge {
  return { id: newId('e'), source, target, kind, ...overrides };
}

export const emptyGraph = (): ArchGraph => ({ nodes: [], edges: [] });
