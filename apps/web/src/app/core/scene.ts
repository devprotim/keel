import type { ArchEdge, ArchGraph, ArchNode, DesignIntent, ReviewChange, Severity, ValidationReport } from '@keel/shared';
import { restoredElement, worstSeverityForNode } from '@keel/shared';
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
  /** Review mode only: how this node differs from the approved design. */
  diff?: DiffState;
}

export type DiffState = 'added' | 'removed' | 'changed';

/** What review mode needs to draw the diff. */
export interface SceneReview {
  changes: readonly ReviewChange[];
  intent: DesignIntent;
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
  diff?: DiffState;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  byNodeId: Map<string, SceneNode>;
  /**
   * Review mode only: removed elements, drawn faded where they were approved.
   * Kept out of `nodes`/`edges` so nothing can select, drag or connect to
   * something that is not in the diagram.
   */
  ghosts?: { nodes: SceneNode[]; edges: SceneEdge[] };
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
export function buildScene(graph: ArchGraph, report?: ValidationReport | null, review?: SceneReview | null): Scene {
  // Review mode shows the diff instead of findings: two colour languages on
  // one canvas would leave "red" meaning either removed or broken.
  const severityReport = review ? null : report;
  const diffs = new Map<string, DiffState>(review?.changes.map((c) => [c.id, c.type]));
  const byNodeId = new Map<string, SceneNode>();
  const nodes: SceneNode[] = [];

  for (const node of graph.nodes) {
    const sceneNode: SceneNode = {
      node,
      rect: nodeRect(node),
      severity: severityReport ? worstSeverityForNode(severityReport, node.id) : null,
    };
    const diff = diffs.get(node.id);
    if (diff) sceneNode.diff = diff;
    nodes.push(sceneNode);
    byNodeId.set(node.id, sceneNode);
  }

  const edgeSeverity = severityReport ? severityByEdge(severityReport) : null;
  const edges: SceneEdge[] = [];

  for (const edge of graph.edges) {
    const sceneEdge = edgeBetween(edge, byNodeId.get(edge.source), byNodeId.get(edge.target));
    if (!sceneEdge) continue;
    sceneEdge.severity = edgeSeverity?.get(edge.id) ?? null;
    const diff = diffs.get(edge.id);
    if (diff) sceneEdge.diff = diff;
    edges.push(sceneEdge);
  }

  const scene: Scene = { nodes, edges, byNodeId };
  if (review) scene.ghosts = ghostsOf(review, byNodeId);
  return scene;
}

/**
 * Removed elements where they were approved. A node approved before layouts
 * were saved has no known position, so it is listed in the panel but not drawn
 * (a ghost at the origin would claim a place it never had).
 */
function ghostsOf(review: SceneReview, present: ReadonlyMap<string, SceneNode>): { nodes: SceneNode[]; edges: SceneEdge[] } {
  const removed = review.changes.filter((c) => c.type === 'removed');
  const ghostNodes = new Map<string, SceneNode>();

  for (const change of removed) {
    const approved = review.intent[change.id];
    if (change.element !== 'node' || !approved?.layout || approved.layout.x === undefined) continue;
    const node = restoredElement(change.id, approved) as ArchNode | null;
    if (node) ghostNodes.set(node.id, { node, rect: nodeRect(node), severity: null, diff: 'removed' });
  }

  const edges: SceneEdge[] = [];
  for (const change of removed) {
    const approved = review.intent[change.id];
    if (change.element !== 'edge' || !approved) continue;
    const edge = restoredElement(change.id, approved) as ArchEdge | null;
    if (!edge) continue;
    const end = (id: string): SceneNode | undefined => present.get(id) ?? ghostNodes.get(id);
    const sceneEdge = edgeBetween(edge, end(edge.source), end(edge.target));
    if (sceneEdge) edges.push({ ...sceneEdge, diff: 'removed' });
  }

  return { nodes: [...ghostNodes.values()], edges };
}

function edgeBetween(edge: ArchEdge, source: SceneNode | undefined, target: SceneNode | undefined): SceneEdge | null {
  // A dangling edge is a normal transient state during collaborative editing:
  // one peer deleted a node and the edge cleanup has not arrived yet. Skipping
  // it is correct; throwing would blank the canvas for everyone.
  if (!source || !target) return null;

  // Self-loops have no meaningful direction between two centres, and the
  // border maths degenerates. They are skipped rather than drawn wrong; the
  // validation engine still reports them.
  if (source === target) return null;

  const from = borderPoint(source.rect, rectCenter(target.rect));
  const to = borderPoint(target.rect, rectCenter(source.rect));
  return { edge, from, to, mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, severity: null };
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
