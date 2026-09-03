import { describe, expect, it } from 'vitest';
import { findCycles, graphFingerprint, indexGraph, longestSyncDepth, orphanNodes } from './graph.js';
import { createEdge, createNode } from './factory.js';
import type { ArchEdge, ArchGraph, ArchNode } from './types.js';

/** Build a graph from terse `a->b` style specs so tests read as topology. */
function graphOf(nodeIds: string[], edgeSpecs: [string, string, ArchEdge['kind']?][]): ArchGraph {
  const nodes: ArchNode[] = nodeIds.map((id) => ({ ...createNode('service', 0, 0), id, label: id }));
  const edges: ArchEdge[] = edgeSpecs.map(([source, target, kind]) => ({
    ...createEdge(source, target, kind ?? 'sync'),
    id: `${source}->${target}`,
  }));
  return { nodes, edges };
}

describe('indexGraph', () => {
  it('builds adjacency in both directions', () => {
    const graph = graphOf(['a', 'b', 'c'], [['a', 'b'], ['a', 'c']]);
    const index = indexGraph(graph);

    expect(index.outgoing.get('a')).toHaveLength(2);
    expect(index.incoming.get('b')).toHaveLength(1);
    expect(index.outgoing.get('b')).toHaveLength(0);
  });

  it('ignores edges pointing at deleted nodes instead of throwing', () => {
    // This is the transient state a CRDT produces when one peer deletes a node
    // and the edge cleanup has not yet replicated. It must not break validation.
    const graph = graphOf(['a'], [['a', 'ghost']]);
    const index = indexGraph(graph);

    expect(index.outgoing.get('a')).toHaveLength(0);
    expect(() => indexGraph(graph)).not.toThrow();
  });
});

describe('findCycles', () => {
  it('finds nothing in an acyclic graph', () => {
    const graph = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    expect(findCycles(graph, indexGraph(graph), 'sync')).toEqual([]);
  });

  it('finds a simple two-node cycle', () => {
    const graph = graphOf(['a', 'b'], [['a', 'b'], ['b', 'a']]);
    const cycles = findCycles(graph, indexGraph(graph), 'sync');

    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.slice().sort()).toEqual(['a', 'b']);
  });

  it('reports a cycle once regardless of which node it is entered from', () => {
    const graph = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
    expect(findCycles(graph, indexGraph(graph), 'sync')).toHaveLength(1);
  });

  it('separates cycles by edge kind', () => {
    // Sync a->b plus async b->a is a legitimate request/callback pattern and is
    // explicitly not a synchronous deadlock.
    const graph = graphOf(['a', 'b'], [['a', 'b', 'sync'], ['b', 'a', 'async']]);
    const index = indexGraph(graph);

    expect(findCycles(graph, index, 'sync')).toEqual([]);
    expect(findCycles(graph, index, 'async')).toEqual([]);
  });

  it('finds two independent cycles', () => {
    const graph = graphOf(
      ['a', 'b', 'c', 'd'],
      [['a', 'b'], ['b', 'a'], ['c', 'd'], ['d', 'c']],
    );
    expect(findCycles(graph, indexGraph(graph), 'sync')).toHaveLength(2);
  });

  it('handles a self-loop', () => {
    const graph = graphOf(['a'], [['a', 'a']]);
    expect(findCycles(graph, indexGraph(graph), 'sync')).toEqual([['a']]);
  });

  it('does not overflow the stack on a long chain', () => {
    // The iterative implementation exists for this case; a recursive DFS would
    // throw here, and users do paste in large generated diagrams.
    const ids = Array.from({ length: 10_000 }, (_, i) => `n${i}`);
    const edges = ids.slice(0, -1).map((id, i): [string, string] => [id, ids[i + 1]!]);
    const graph = graphOf(ids, edges);

    expect(() => findCycles(graph, indexGraph(graph), 'sync')).not.toThrow();
  });
});

describe('longestSyncDepth', () => {
  it('counts hops along a chain', () => {
    const graph = graphOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);
    expect(longestSyncDepth(indexGraph(graph), 'a')).toBe(3);
  });

  it('returns 0 for a leaf', () => {
    const graph = graphOf(['a', 'b'], [['a', 'b']]);
    expect(longestSyncDepth(indexGraph(graph), 'b')).toBe(0);
  });

  it('takes the longest branch, not the first', () => {
    const graph = graphOf(
      ['a', 'short', 'b', 'c', 'd'],
      [['a', 'short'], ['a', 'b'], ['b', 'c'], ['c', 'd']],
    );
    expect(longestSyncDepth(indexGraph(graph), 'a')).toBe(3);
  });

  it('ignores asynchronous hops', () => {
    const graph = graphOf(['a', 'b', 'c'], [['a', 'b', 'sync'], ['b', 'c', 'async']]);
    expect(longestSyncDepth(indexGraph(graph), 'a')).toBe(1);
  });

  it('terminates on a cycle', () => {
    const graph = graphOf(['a', 'b'], [['a', 'b'], ['b', 'a']]);
    expect(longestSyncDepth(indexGraph(graph), 'a')).toBe(1);
  });

  it('does not let a truncated cyclic result poison a later acyclic path', () => {
    // `shared` is reachable both from inside the a<->b loop and from `outside`.
    // A naive memo would cache the truncated depth computed inside the loop and
    // then under-report the depth from `outside`.
    const graph = graphOf(
      ['a', 'b', 'shared', 'tail1', 'tail2', 'outside'],
      [
        ['a', 'b'],
        ['b', 'a'],
        ['b', 'shared'],
        ['shared', 'tail1'],
        ['tail1', 'tail2'],
        ['outside', 'shared'],
      ],
    );
    expect(longestSyncDepth(indexGraph(graph), 'outside')).toBe(3);
  });
});

describe('orphanNodes', () => {
  it('finds only fully disconnected nodes', () => {
    const graph = graphOf(['a', 'b', 'lonely'], [['a', 'b']]);
    const orphans = orphanNodes(graph, indexGraph(graph));

    expect(orphans.map((n) => n.id)).toEqual(['lonely']);
  });
});

describe('graphFingerprint', () => {
  it('is stable across node and edge ordering', () => {
    const graph = graphOf(['a', 'b'], [['a', 'b']]);
    const shuffled: ArchGraph = { nodes: [...graph.nodes].reverse(), edges: [...graph.edges] };

    expect(graphFingerprint(shuffled)).toBe(graphFingerprint(graph));
  });

  it('ignores position, since moving a box does not change the design', () => {
    const graph = graphOf(['a', 'b'], [['a', 'b']]);
    const moved: ArchGraph = {
      nodes: graph.nodes.map((n) => ({ ...n, x: n.x + 500, y: n.y + 500 })),
      edges: graph.edges,
    };

    expect(graphFingerprint(moved)).toBe(graphFingerprint(graph));
  });

  it('changes when semantics change', () => {
    const graph = graphOf(['a', 'b'], [['a', 'b']]);
    const scaled: ArchGraph = {
      nodes: graph.nodes.map((n) => (n.id === 'b' ? { ...n, replicas: 3 } : n)),
      edges: graph.edges,
    };

    expect(graphFingerprint(scaled)).not.toBe(graphFingerprint(graph));
  });
});
