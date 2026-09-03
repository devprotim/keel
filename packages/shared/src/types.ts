/**
 * Keel domain model.
 *
 * The whole product rests on one idea: a diagram is a *typed graph*, not a bag of
 * boxes. Because nodes and edges carry semantics, we can reason about the design
 * instead of merely drawing it.
 */

/** What a box actually is. Drives both rendering and which rules apply. */
export type NodeKind =
  | 'service'
  | 'datastore'
  | 'queue'
  | 'cache'
  | 'gateway'
  | 'job'
  | 'external';

/**
 * How a dependency behaves at runtime.
 *
 * `sync`   caller blocks on the callee, so failures and latency propagate upstream.
 * `async`  fire-and-forget through a broker, so the callee can be down without
 *          taking the caller with it, but delivery is at-least-once.
 * `stream` a continuous subscription; ordering and replay matter.
 */
export type EdgeKind = 'sync' | 'async' | 'stream';

export interface ArchNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Canvas position of the top-left corner, in world coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Number of running instances. 1 means a single point of failure. */
  replicas: number;
  /** Free-text implementation note, e.g. "Postgres 16" or "Node/Fastify". */
  tech?: string;
  notes?: string;
  /** Author has marked this as on the critical user path. Escalates severities. */
  critical?: boolean;
  /** datastore: has a read replica or standby. */
  hasReplica?: boolean;
  /** datastore: has point-in-time backups. */
  hasBackup?: boolean;
  /** queue: has a dead-letter queue for poison messages. */
  hasDlq?: boolean;
}

export interface ArchEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  /** Caller-side timeout. Absent on a sync edge means an unbounded wait. */
  timeoutMs?: number;
  /** Caller-side retry attempts beyond the first try. */
  retries?: number;
  circuitBreaker?: boolean;
  /** Consumer tolerates duplicate delivery. Required for correct at-least-once. */
  idempotent?: boolean;
}

export interface ArchGraph {
  nodes: ArchNode[];
  edges: ArchEdge[];
}

export type Severity = 'error' | 'warning' | 'info';

/**
 * A validation result. Findings always point at concrete ids so the UI can
 * highlight the exact nodes and edges in question, and so an AI review can be
 * held to the same standard of specificity.
 */
export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  detail: string;
  nodeIds: string[];
  edgeIds: string[];
}

export interface Rule {
  id: string;
  /** Short human name, shown in the rules panel. */
  name: string;
  /** Why this matters, shown as help text. */
  rationale: string;
  run(graph: ArchGraph, index: GraphIndex): Finding[];
}

/** Precomputed adjacency, built once per validation pass. See graph.ts. */
export interface GraphIndex {
  byId: ReadonlyMap<string, ArchNode>;
  outgoing: ReadonlyMap<string, readonly ArchEdge[]>;
  incoming: ReadonlyMap<string, readonly ArchEdge[]>;
}

export const NODE_KINDS: readonly NodeKind[] = [
  'service',
  'datastore',
  'queue',
  'cache',
  'gateway',
  'job',
  'external',
] as const;

export const EDGE_KINDS: readonly EdgeKind[] = ['sync', 'async', 'stream'] as const;
