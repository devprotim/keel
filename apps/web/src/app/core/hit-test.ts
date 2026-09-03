import { distanceToSegment, rectContains, rectsOverlap, type Point, type Rect } from './geometry';
import type { Scene } from './scene';

export type HitTarget =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'none' };

export const NO_HIT: HitTarget = { kind: 'none' };

/** How close, in world units, a click must be to an edge to select it. */
export const EDGE_HIT_TOLERANCE = 8;

/**
 * What is under a world-space point.
 *
 * Nodes win over edges, and later nodes win over earlier ones. Draw order is
 * array order, so the last node drawn is the one on top, and it is the one the
 * user believes they are clicking. Iterating in reverse is what makes hit
 * testing agree with what is visible.
 */
export function hitTest(scene: Scene, point: Point, tolerance = EDGE_HIT_TOLERANCE): HitTarget {
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const candidate = scene.nodes[i]!;
    if (rectContains(candidate.rect, point)) return { kind: 'node', id: candidate.node.id };
  }

  // Edges have no area, so the nearest one within tolerance wins rather than the
  // first one found. With several edges converging on a box, "first" would be an
  // arbitrary choice the user cannot predict.
  let best: { id: string; distance: number } | null = null;
  for (const candidate of scene.edges) {
    const distance = distanceToSegment(point, candidate.from, candidate.to);
    if (distance > tolerance) continue;
    if (best === null || distance < best.distance) best = { id: candidate.edge.id, distance };
  }

  return best ? { kind: 'edge', id: best.id } : NO_HIT;
}

/**
 * Ids of every node intersecting a marquee rectangle.
 *
 * Intersection rather than containment: requiring a node to be fully enclosed
 * makes large boxes almost impossible to select without zooming out first.
 */
export function nodesInRect(scene: Scene, rect: Rect): string[] {
  return scene.nodes
    .filter((candidate) => rectsOverlap(candidate.rect, rect))
    .map((candidate) => candidate.node.id);
}
