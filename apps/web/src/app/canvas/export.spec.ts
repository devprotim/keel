import { createEdge, createNode, type ArchGraph } from '@keel/shared';
import { describe, expect, it } from 'vitest';
import { exportFilename, exportLayout } from './export';

const graph: ArchGraph = {
  nodes: [
    { ...createNode('service', 100, 50), id: 'a', w: 180, h: 80 },
    { ...createNode('datastore', 500, 300), id: 'b', w: 180, h: 80 },
  ],
  edges: [{ ...createEdge('a', 'b'), id: 'e' }],
};

describe('exportLayout', () => {
  it('frames the diagram with padding, wherever it sits in world space', () => {
    // Content spans x 100..680, y 50..380; 40 of padding on every side.
    expect(exportLayout(graph, 1)).toEqual({
      bounds: { x: 60, y: 10, w: 660, h: 410 },
      scale: 1,
      width: 660,
      height: 410,
    });
  });

  it('renders at the requested density', () => {
    expect(exportLayout(graph, 2)).toMatchObject({ width: 1320, height: 820, scale: 2 });
  });

  it('gives up density rather than exceed what a browser canvas can hold', () => {
    const wide: ArchGraph = {
      nodes: [...graph.nodes, { ...createNode('service', 20_000, 0), id: 'far', w: 180, h: 80 }],
      edges: [],
    };
    const layout = exportLayout(wide, 2)!;
    expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(8192);
    expect(layout.scale).toBeLessThan(1);
  });

  it('has nothing to frame for an empty diagram', () => {
    expect(exportLayout({ nodes: [], edges: [] }, 2)).toBeNull();
  });
});

it('names files by room and date', () => {
  expect(exportFilename('abc123', 'png', new Date('2026-09-25T23:00:00Z'))).toBe('keel-abc123-2026-09-25.png');
});
