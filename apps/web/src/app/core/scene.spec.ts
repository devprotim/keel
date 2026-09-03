import { createEdge, createNode, validate, type ArchGraph } from '@keel/shared';
import { describe, expect, it } from 'vitest';
import { hitTest, nodesInRect } from './hit-test';
import { buildScene } from './scene';

function graphOf(): ArchGraph {
  return {
    nodes: [
      { ...createNode('service', 0, 0), id: 'a', label: 'A', w: 100, h: 60 },
      { ...createNode('service', 300, 0), id: 'b', label: 'B', w: 100, h: 60 },
    ],
    edges: [{ ...createEdge('a', 'b'), id: 'e1', timeoutMs: 100 }],
  };
}

describe('buildScene', () => {
  it('anchors edges on the box borders, not their centres', () => {
    const scene = buildScene(graphOf());
    const edge = scene.edges[0]!;

    // A leaves through its right edge at x=100, B is entered at its left, x=300.
    expect(edge.from).toEqual({ x: 100, y: 30 });
    expect(edge.to).toEqual({ x: 300, y: 30 });
  });

  it('skips edges whose endpoints have been deleted', () => {
    // The transient state during collaborative editing: a node is gone but its
    // edge has not been cleaned up yet.
    const graph = graphOf();
    graph.nodes = graph.nodes.filter((n) => n.id !== 'b');

    expect(buildScene(graph).edges).toHaveLength(0);
  });

  it('skips self-loops rather than drawing them wrong', () => {
    const graph = graphOf();
    graph.edges = [{ ...createEdge('a', 'a'), id: 'self' }];

    expect(buildScene(graph).edges).toHaveLength(0);
  });

  it('renders without a validation report', () => {
    const scene = buildScene(graphOf(), null);

    expect(scene.nodes).toHaveLength(2);
    expect(scene.nodes[0]!.severity).toBeNull();
  });

  it('annotates nodes and edges with their worst severity', () => {
    const graph = graphOf();
    graph.edges = [{ ...createEdge('a', 'b'), id: 'e1' }]; // no timeout
    const scene = buildScene(graph, validate(graph));

    expect(scene.edges[0]!.severity).toBe('warning');
    expect(scene.nodes.find((n) => n.node.id === 'b')!.severity).not.toBeNull();
  });

  it('indexes nodes by id', () => {
    expect(buildScene(graphOf()).byNodeId.get('a')!.node.label).toBe('A');
  });
});

describe('hitTest', () => {
  const scene = buildScene(graphOf());

  it('finds a node under the point', () => {
    expect(hitTest(scene, { x: 50, y: 30 })).toEqual({ kind: 'node', id: 'a' });
  });

  it('finds an edge near the line', () => {
    expect(hitTest(scene, { x: 200, y: 33 })).toEqual({ kind: 'edge', id: 'e1' });
  });

  it('ignores an edge outside the tolerance', () => {
    expect(hitTest(scene, { x: 200, y: 80 })).toEqual({ kind: 'none' });
  });

  it('prefers nodes over edges', () => {
    // The edge passes through A's box; clicking there must select the box.
    expect(hitTest(scene, { x: 90, y: 30 })).toEqual({ kind: 'node', id: 'a' });
  });

  it('prefers the topmost node when boxes overlap', () => {
    // Draw order is array order, so the later node is visually on top and must
    // be the one hit testing returns.
    const stacked = buildScene({
      nodes: [
        { ...createNode('service', 0, 0), id: 'under', w: 100, h: 100 },
        { ...createNode('service', 20, 20), id: 'over', w: 100, h: 100 },
      ],
      edges: [],
    });

    expect(hitTest(stacked, { x: 50, y: 50 })).toEqual({ kind: 'node', id: 'over' });
  });

  it('picks the nearest edge when several are in range', () => {
    const crowded = buildScene({
      nodes: [
        { ...createNode('service', 0, 0), id: 'a', w: 40, h: 40 },
        { ...createNode('service', 400, 0), id: 'b', w: 40, h: 40 },
        { ...createNode('service', 400, 60), id: 'c', w: 40, h: 40 },
      ],
      edges: [
        { ...createEdge('a', 'b'), id: 'to-b' },
        { ...createEdge('a', 'c'), id: 'to-c' },
      ],
    });

    const hit = hitTest(crowded, { x: 300, y: 62 }, 40);
    expect(hit).toEqual({ kind: 'edge', id: 'to-c' });
  });

  it('returns none on empty space', () => {
    expect(hitTest(scene, { x: 1000, y: 1000 })).toEqual({ kind: 'none' });
  });
});

describe('nodesInRect', () => {
  const scene = buildScene(graphOf());

  it('selects nodes that merely intersect the marquee', () => {
    // Requiring full containment makes big boxes nearly unselectable.
    expect(nodesInRect(scene, { x: 50, y: 10, w: 20, h: 20 })).toEqual(['a']);
  });

  it('selects everything under a wide marquee', () => {
    expect(nodesInRect(scene, { x: -50, y: -50, w: 600, h: 300 }).sort()).toEqual(['a', 'b']);
  });

  it('selects nothing for a marquee over empty space', () => {
    expect(nodesInRect(scene, { x: 900, y: 900, w: 50, h: 50 })).toEqual([]);
  });
});
