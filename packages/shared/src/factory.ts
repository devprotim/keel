import type { ArchEdge, ArchGraph, ArchNode, EdgeKind, NodeKind } from './types.js';

/** Default box size per kind, in world units. */
const DEFAULT_SIZE: Record<NodeKind, { w: number; h: number }> = {
  service: { w: 180, h: 80 },
  datastore: { w: 160, h: 90 },
  queue: { w: 170, h: 70 },
  cache: { w: 150, h: 70 },
  gateway: { w: 180, h: 70 },
  job: { w: 170, h: 70 },
  external: { w: 170, h: 80 },
};

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
  const size = DEFAULT_SIZE[kind];
  return {
    id: newId('n'),
    kind,
    label: DEFAULT_LABEL[kind],
    x,
    y,
    w: size.w,
    h: size.h,
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
