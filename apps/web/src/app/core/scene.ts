import type { ArchEdge, ArchGraph, ArchNode, Severity, ValidationReport } from '@keel/shared';
import { worstSeverityForNode } from '@keel/shared';
import { borderPoint, rectCenter, type Point, type Rect } from './geometry';

/**
 * The drawable form of a diagram.
 *
 * The graph says what exists; the scene says where it is on screen and what
 * state it is in. Deriving this once per change, rather than inside the render
 * loop, means the expensive part (border intersections for every edge) happens
 * when the data changes rather than sixty times a second while panning.
 *
 * All coordinates here are world space. The viewport transform is applied by the
 * renderer, so a scene is independent of where the camera happens to be.
 */

export interface SceneNode {
  node: ArchNode;
  rect: Rect;
  /** Worst validation severity touching this node, or null when clean. */
  severity: Severity | null;
}

export interface SceneEdge {
  edge: ArchEdge;
  /** Where the line leaves the source box border. */
  from: Point;
  /** Where the line meets the target box border, and the arrowhead sits. */
  to: Point;
  /** Midpoint, used for the label and the hover target. */
  mid: Point;
  severity: Severity | null;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  byNodeId: Map<string, SceneNode>;
}

export const EMPTY_SCENE: Scene = { nodes: [], edges: [], byNodeId: new Map() };

export function nodeRect(node: ArchNode): Rect {
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

/**
 * Build the scene for a graph, annotated with validation state.
 *
 * `report` is optional so the canvas can render before the first validation pass
 * completes. A diagram that will not draw until it has been analysed would flash
 * empty on every load.
 */
export function buildScene(graph: ArchGraph, report?: ValidationReport | null): Scene {
  const byNodeId = new Map<string, SceneNode>();
  const nodes: SceneNode[] = [];

  for (const node of graph.nodes) {
    const sceneNode: SceneNode = {
      node,
      rect: nodeRect(node),
      severity: report ? worstSeverityForNode(report, node.id) : null,
    };
    nodes.push(sceneNode);
    byNodeId.set(node.id, sceneNode);
  }

  const edgeSeverity = report ? severityByEdge(report) : null;
  const edges: SceneEdge[] = [];

  for (const edge of graph.edges) {
    const source = byNodeId.get(edge.source);
    const target = byNodeId.get(edge.target);

    // A dangling edge is a normal transient state during collaborative editing:
    // one peer deleted a node and the edge cleanup has not arrived yet. Skipping
    // it is correct; throwing would blank the canvas for everyone.
    if (!source || !target) continue;

    // Self-loops have no meaningful direction between two centres, and the
    // border maths degenerates. They are skipped rather than drawn wrong; the
    // validation engine still reports them.
    if (source === target) continue;

    const from = borderPoint(source.rect, rectCenter(target.rect));
    const to = borderPoint(target.rect, rectCenter(source.rect));

    edges.push({
      edge,
      from,
      to,
      mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      severity: edgeSeverity?.get(edge.id) ?? null,
    });
  }

  return { nodes, edges, byNodeId };
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Worst severity per edge, computed in one pass rather than per edge. */
function severityByEdge(report: ValidationReport): Map<string, Severity> {
  const worst = new Map<string, Severity>();

  for (const finding of report.findings) {
    for (const edgeId of finding.edgeIds) {
      const current = worst.get(edgeId);
      if (current === undefined || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[current]) {
        worst.set(edgeId, finding.severity);
      }
    }
  }

  return worst;
}
