import type { ArchEdge, ArchGraph, ArchNode, EdgeKind, GraphIndex } from './types.js';

/**
 * Build adjacency once per validation pass.
 *
 * Rules run in a loop over every node and edge, so doing this naively would turn
 * each rule into an O(n*e) scan. Indexing up front keeps the whole pass linear in
 * the size of the graph, which matters because validation runs on every keystroke
 * in the inspector, not just on save.
 */
export function indexGraph(graph: ArchGraph): GraphIndex {
  const byId = new Map<string, ArchNode>();
  for (const node of graph.nodes) byId.set(node.id, node);

  const outgoing = new Map<string, ArchEdge[]>();
  const incoming = new Map<string, ArchEdge[]>();
  for (const node of graph.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  for (const edge of graph.edges) {
    // Edges pointing at deleted nodes are skipped rather than treated as fatal.
    // Concurrent editing means we routinely see a delete land before the edge
    // cleanup that follows it, and a transient dangling edge must not blow up
    // validation for everyone in the room.
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge);
    incoming.get(edge.target)!.push(edge);
  }

  return { byId, outgoing, incoming };
}

/** Edges leaving a node, optionally narrowed to one kind. */
export function outgoingOf(index: GraphIndex, nodeId: string, kind?: EdgeKind): readonly ArchEdge[] {
  const edges = index.outgoing.get(nodeId) ?? [];
  return kind ? edges.filter((e) => e.kind === kind) : edges;
}

/** Edges arriving at a node, optionally narrowed to one kind. */
export function incomingOf(index: GraphIndex, nodeId: string, kind?: EdgeKind): readonly ArchEdge[] {
  const edges = index.incoming.get(nodeId) ?? [];
  return kind ? edges.filter((e) => e.kind === kind) : edges;
}

/**
 * Find every cycle reachable in the subgraph of a single edge kind.
 *
 * Iterative depth-first search with an explicit stack. A recursive version reads
 * better but a pathological diagram would blow the call stack, and this runs in
 * the browser on the render path.
 *
 * Returns each cycle as the list of node ids in traversal order. Cycles are
 * deduplicated by their canonical rotation so the same loop found from three
 * different entry points is reported once.
 */
export function findCycles(graph: ArchGraph, index: GraphIndex, kind: EdgeKind): string[][] {
  const WHITE = 0; // unvisited
  const GREY = 1; // on the current path
  const BLACK = 2; // fully explored
  const color = new Map<string, number>();
  for (const node of graph.nodes) color.set(node.id, WHITE);

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const path: string[] = [];

  for (const root of graph.nodes) {
    if (color.get(root.id) !== WHITE) continue;

    // Each frame tracks how many of its successors we have already descended into.
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    color.set(root.id, GREY);
    path.push(root.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = outgoingOf(index, frame.id, kind);

      if (frame.next >= edges.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const target = edges[frame.next]!.target;
      frame.next += 1;

      const targetColor = color.get(target);
      if (targetColor === GREY) {
        // Back edge: everything from `target` to the top of the path is a cycle.
        const start = path.lastIndexOf(target);
        if (start !== -1) {
          const cycle = path.slice(start);
          const key = canonicalCycleKey(cycle);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
        }
      } else if (targetColor === WHITE) {
        color.set(target, GREY);
        path.push(target);
        stack.push({ id: target, next: 0 });
      }
    }
  }

  return cycles;
}

/**
 * Rotate a cycle so it starts at its lexicographically smallest member.
 *
 * [b, c, a] and [a, b, c] describe the same loop; without normalising, the same
 * cycle reached from a different entry point would be reported twice.
 */
function canonicalCycleKey(cycle: string[]): string {
  let minIndex = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i]! < cycle[minIndex]!) minIndex = i;
  }
  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)].join('>');
}

/**
 * Longest chain of synchronous calls starting at `nodeId`.
 *
 * This is the latency amplification measure: a request entering the front of a
 * five-deep synchronous chain cannot be faster than the sum of the whole chain,
 * and its failure probability compounds at every hop.
 *
 * Cycles are bounded by refusing to revisit a node already on the current path,
 * so a cyclic graph yields the longest acyclic walk rather than looping forever.
 */
export function longestSyncDepth(index: GraphIndex, nodeId: string): number {
  const memo = new Map<string, number>();

  /**
   * Returns the depth below `id`, plus whether that number was cut short by
   * running into a node already on the path.
   *
   * The `truncated` flag is the reason this is not a plain memoised DFS. A value
   * computed while a cycle was being cut is only valid for *this* path, so
   * caching it would under-report any later visit that reaches the same node
   * from outside the loop. Only untainted results are safe to keep.
   */
  const walk = (id: string, onPath: Set<string>): { depth: number; truncated: boolean } => {
    if (onPath.has(id)) return { depth: 0, truncated: true };

    const cached = memo.get(id);
    if (cached !== undefined) return { depth: cached, truncated: false };

    onPath.add(id);
    let best = 0;
    let truncated = false;
    for (const edge of outgoingOf(index, id, 'sync')) {
      // An edge back onto the current path closes a cycle. Skip it entirely
      // rather than counting it as a hop, so the result stays a simple path:
      // a <-> b is a one-hop chain, not a two-hop one.
      if (onPath.has(edge.target)) {
        truncated = true;
        continue;
      }
      const result = walk(edge.target, onPath);
      truncated ||= result.truncated;
      best = Math.max(best, 1 + result.depth);
    }
    onPath.delete(id);

    if (!truncated) memo.set(id, best);
    return { depth: best, truncated };
  };

  return walk(nodeId, new Set()).depth;
}

/** Nodes with no edges at all, in either direction. */
export function orphanNodes(graph: ArchGraph, index: GraphIndex): ArchNode[] {
  return graph.nodes.filter(
    (n) => (index.outgoing.get(n.id)?.length ?? 0) === 0 && (index.incoming.get(n.id)?.length ?? 0) === 0,
  );
}

/** Stable, order-independent fingerprint of a graph's semantic content. */
export function graphFingerprint(graph: ArchGraph): string {
  const nodes = [...graph.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => `${n.id}:${n.kind}:${n.label}:${n.replicas}:${n.hasReplica ?? ''}:${n.hasBackup ?? ''}:${n.hasDlq ?? ''}:${n.critical ?? ''}`);
  const edges = [...graph.edges]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => `${e.id}:${e.source}>${e.target}:${e.kind}:${e.timeoutMs ?? ''}:${e.retries ?? ''}:${e.circuitBreaker ?? ''}:${e.idempotent ?? ''}`);
  return fnv1a([...nodes, ...edges].join('|'));
}

/**
 * FNV-1a, 32-bit. Not cryptographic; it only needs to be stable and cheap.
 * Used to cache AI reviews so an unchanged diagram never pays for a second call.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
