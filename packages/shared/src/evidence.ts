import type { ArchEdge, ArchGraph, ArchNode } from './types.js';

/**
 * Evidence: what the running system says, as opposed to what the diagram says.
 *
 * Every value on an ArchNode or ArchEdge is typed in by a person, and a person
 * can be wrong on the day they type it or become wrong six months later when
 * someone scales a deployment down. Observations are the second source of truth
 * that makes those two cases detectable. They are pushed in from outside
 * (Kubernetes, a service mesh, tracing, a CI script) as one ObservationSet per
 * source, and matched onto the diagram by each node's `ref`.
 *
 * Observations never overwrite what the author declared. They are kept
 * alongside it, and validation runs against the observed value wherever one
 * exists, so a stale declaration can no longer hide a real problem.
 */

/** One component as the running system reports it. */
export interface NodeObservation {
  /** Matches `ArchNode.ref` (or, failing that, the node id). */
  ref: string;
  replicas?: number;
  hasReplica?: boolean;
  hasBackup?: boolean;
  hasDlq?: boolean;
  /** Requests (or messages) per second handled, averaged over the window. */
  rps?: number;
}

/** One dependency as the running system reports it, keyed by both ends' refs. */
export interface EdgeObservation {
  source: string;
  target: string;
  /** `null` means the caller was observed to have no timeout configured. */
  timeoutMs?: number | null;
  retries?: number;
  circuitBreaker?: boolean;
  /** Observed p99 latency of the call. */
  p99Ms?: number;
  rps?: number;
}

/** Everything one source reported at one point in time. Replaced wholesale on each push. */
export interface ObservationSet {
  /** Who reported this, e.g. "kubernetes" or "otel". One set is kept per source. */
  source: string;
  /** ISO 8601 time the observations were taken. */
  observedAt: string;
  nodes?: NodeObservation[];
  edges?: EdgeObservation[];
}

export type ObservedNode = Omit<NodeObservation, 'ref'>;
export type ObservedEdge = Omit<EdgeObservation, 'source' | 'target'>;

export interface EvidenceSource {
  source: string;
  observedAt: string;
  ageMs: number;
  /** Older than the freshness window. Stale sets are reported but never applied. */
  stale: boolean;
  matchedNodeIds: string[];
  matchedEdgeIds: string[];
  /** Refs this source reported that no node on the diagram carries. */
  unmatchedRefs: string[];
}

/** A call the running system makes between two diagrammed components that the diagram does not draw. */
export interface UndiagrammedCall {
  sourceId: string;
  targetId: string;
  source: string;
  rps?: number;
}

export interface Evidence {
  /** Merged fresh observations, by node id. Later observations win per field. */
  nodes: Record<string, ObservedNode>;
  edges: Record<string, ObservedEdge>;
  /** Observed throughput by node or edge id. Absent means no traffic data, not zero. */
  traffic: Record<string, number>;
  /** Nodes carrying a large share of the busiest component's traffic. */
  hotNodeIds: string[];
  sources: EvidenceSource[];
  undiagrammed: UndiagrammedCall[];
}

export interface EvidenceOptions {
  now?: number;
  /** Observations older than this are stale and ignored. Defaults to 24 hours. */
  maxAgeMs?: number;
}

export const DEFAULT_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Share of the busiest node's throughput at which a node counts as hot.
 *
 * Relative rather than absolute so the same threshold means the same thing for
 * a system doing 50 requests a second and one doing 50,000.
 */
const HOT_SHARE = 0.25;

/** Match observation sets onto the diagram and merge them per field. */
export function resolveEvidence(
  graph: ArchGraph,
  sets: readonly ObservationSet[],
  options: EvidenceOptions = {},
): Evidence {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS;

  // A ref can legitimately name more than one box (the same service drawn in
  // two places), so this is a multimap.
  const byRef = new Map<string, ArchNode[]>();
  for (const node of graph.nodes) {
    const key = node.ref?.trim() || node.id;
    const bucket = byRef.get(key);
    if (bucket) bucket.push(node);
    else byRef.set(key, [node]);
  }

  const edgesByPair = new Map<string, ArchEdge[]>();
  for (const edge of graph.edges) {
    const key = pairKey(edge.source, edge.target);
    const bucket = edgesByPair.get(key);
    if (bucket) bucket.push(edge);
    else edgesByPair.set(key, [edge]);
  }

  const evidence: Evidence = {
    nodes: {},
    edges: {},
    traffic: {},
    hotNodeIds: [],
    sources: [],
    undiagrammed: [],
  };

  // Oldest first, so a fresher source overwrites an older one field by field.
  const ordered = [...sets].sort((a, b) => timeOf(a.observedAt) - timeOf(b.observedAt));
  const undiagrammed = new Map<string, UndiagrammedCall>();

  for (const set of ordered) {
    const observedAt = timeOf(set.observedAt);
    const ageMs = Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : Number.POSITIVE_INFINITY;
    const stale = !(ageMs <= maxAgeMs);

    const matchedNodeIds = new Set<string>();
    const matchedEdgeIds = new Set<string>();
    const unmatchedRefs = new Set<string>();

    for (const observation of set.nodes ?? []) {
      const targets = byRef.get(observation.ref);
      if (!targets) {
        unmatchedRefs.add(observation.ref);
        continue;
      }
      const fields: ObservedNode = defined({
        replicas: observation.replicas,
        hasReplica: observation.hasReplica,
        hasBackup: observation.hasBackup,
        hasDlq: observation.hasDlq,
        rps: observation.rps,
      });
      for (const node of targets) {
        matchedNodeIds.add(node.id);
        if (!stale) evidence.nodes[node.id] = { ...evidence.nodes[node.id], ...fields };
      }
    }

    for (const observation of set.edges ?? []) {
      const sources = byRef.get(observation.source);
      const targets = byRef.get(observation.target);
      if (!sources) unmatchedRefs.add(observation.source);
      if (!targets) unmatchedRefs.add(observation.target);
      if (!sources || !targets) continue;

      const fields: ObservedEdge = defined({
        timeoutMs: observation.timeoutMs,
        retries: observation.retries,
        circuitBreaker: observation.circuitBreaker,
        p99Ms: observation.p99Ms,
        rps: observation.rps,
      });
      for (const from of sources) {
        for (const to of targets) {
          const drawn = edgesByPair.get(pairKey(from.id, to.id));
          if (!drawn) {
            // A call with no traffic is not evidence the dependency exists.
            if (!stale && observation.rps !== 0) {
              undiagrammed.set(pairKey(from.id, to.id), {
                sourceId: from.id,
                targetId: to.id,
                source: set.source,
                ...(observation.rps !== undefined ? { rps: observation.rps } : {}),
              });
            }
            continue;
          }
          for (const edge of drawn) {
            matchedEdgeIds.add(edge.id);
            if (!stale) evidence.edges[edge.id] = { ...evidence.edges[edge.id], ...fields };
          }
        }
      }
    }

    evidence.sources.push({
      source: set.source,
      observedAt: set.observedAt,
      ageMs,
      stale,
      matchedNodeIds: [...matchedNodeIds].sort(),
      matchedEdgeIds: [...matchedEdgeIds].sort(),
      unmatchedRefs: [...unmatchedRefs].sort(),
    });
  }

  evidence.undiagrammed = [...undiagrammed.values()];
  computeTraffic(graph, evidence);
  return evidence;
}

/**
 * Throughput per node and edge, and which nodes are hot.
 *
 * A node without its own rps inherits the sum of its observed inbound edges,
 * because tracing usually reports calls rather than per-service totals.
 */
function computeTraffic(graph: ArchGraph, evidence: Evidence): void {
  const inbound = new Map<string, number>();
  for (const edge of graph.edges) {
    const rps = evidence.edges[edge.id]?.rps;
    if (rps === undefined) continue;
    evidence.traffic[edge.id] = rps;
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + rps);
  }

  let busiest = 0;
  for (const node of graph.nodes) {
    const rps = evidence.nodes[node.id]?.rps ?? inbound.get(node.id);
    if (rps === undefined) continue;
    evidence.traffic[node.id] = rps;
    busiest = Math.max(busiest, rps);
  }

  if (busiest <= 0) return;
  evidence.hotNodeIds = graph.nodes
    .filter((node) => (evidence.traffic[node.id] ?? 0) >= busiest * HOT_SHARE)
    .map((node) => node.id);
}

/**
 * The graph as it actually runs: declared values with fresh observations laid over them.
 *
 * Also where traffic turns into importance. A hot node is treated as critical
 * whether or not anyone ticked the box, so findings on the path that carries
 * the load escalate on their own.
 */
export function applyEvidence(graph: ArchGraph, evidence: Evidence): ArchGraph {
  const hot = new Set(evidence.hotNodeIds);

  const nodes = graph.nodes.map((node) => {
    const observed = evidence.nodes[node.id];
    const isHot = hot.has(node.id);
    if (!observed && !isHot) return node;

    const next: ArchNode = { ...node };
    if (observed?.replicas !== undefined) next.replicas = observed.replicas;
    if (observed?.hasReplica !== undefined) next.hasReplica = observed.hasReplica;
    if (observed?.hasBackup !== undefined) next.hasBackup = observed.hasBackup;
    if (observed?.hasDlq !== undefined) next.hasDlq = observed.hasDlq;
    if (isHot) next.critical = true;
    return next;
  });

  const edges = graph.edges.map((edge) => {
    const observed = evidence.edges[edge.id];
    if (!observed) return edge;

    const next: ArchEdge = { ...edge };
    if (observed.timeoutMs === null) delete next.timeoutMs;
    else if (observed.timeoutMs !== undefined) next.timeoutMs = observed.timeoutMs;
    if (observed.retries !== undefined) next.retries = observed.retries;
    if (observed.circuitBreaker !== undefined) next.circuitBreaker = observed.circuitBreaker;
    return next;
  });

  return { nodes, edges };
}

const pairKey = (source: string, target: string): string => `${source}\u0000${target}`;

const timeOf = (iso: string): number => Date.parse(iso);

/** Drop undefined keys, so a source that omits a field never erases another source's value for it. */
function defined<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  const out = {} as T;
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) (out as Record<string, unknown>)[key] = field;
  }
  return out;
}
