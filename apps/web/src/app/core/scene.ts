import type {
  ArchEdge,
  ArchGraph,
  ArchNode,
  DesignIntent,
  Evidence,
  Health,
  IncidentView,
  ReviewChange,
  Severity,
  ValidationReport,
} from '@keel/shared';
import { formatRps, restoredElement, worstSeverityForNode } from '@keel/shared';
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
  /** Incident mode only: live health, and a short badge such as "0/3 ready". */
  health?: Health;
  liveBadge?: string;
}

/** What incident mode needs to draw live health. */
export interface SceneLive {
  incident: IncidentView;
  evidence: Evidence | null;
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
  /** Incident mode only. */
  health?: Health;
  /** Incident mode: throughput, latency and errors in one line, in place of the label. */
  liveLabel?: string;
  /** Incident mode: stroke width, by traffic. */
  weight?: number;
  /** Incident mode: a call the running system makes that the diagram does not draw. */
  undiagrammed?: boolean;
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
export function buildScene(
  graph: ArchGraph,
  report?: ValidationReport | null,
  review?: SceneReview | null,
  live?: SceneLive | null,
): Scene {
  // Review and incident mode each replace findings on the canvas: two colour
  // languages at once would leave "red" meaning either removed, down or broken.
  const severityReport = review || live ? null : report;
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
  if (live) applyLive(scene, live);
  return scene;
}

/**
 * Health onto every element, traffic into edge weights and labels, and the
 * calls production makes that the diagram does not draw as extra edges.
 */
function applyLive(scene: Scene, { incident, evidence }: SceneLive): void {
  let busiest = 0;
  for (const edge of scene.edges) busiest = Math.max(busiest, evidence?.traffic[edge.edge.id] ?? 0);

  for (const sceneNode of scene.nodes) {
    const report = incident.byId[sceneNode.node.id];
    if (!report) continue;
    sceneNode.health = report.health;
    if (report.ready && report.ready.observed < report.ready.declared) {
      sceneNode.liveBadge = $localize`:Incident mode badge on a node, ready instances out of declared, e.g. 0/3 ready:${report.ready.observed}:ready:/${report.ready.declared}:declared: ready`;
    } else if (report.errorRate !== undefined && report.errorRate > 0 && report.health !== 'healthy') {
      sceneNode.liveBadge = `${percent(report.errorRate)} err`;
    }
  }

  for (const sceneEdge of scene.edges) {
    const report = incident.byId[sceneEdge.edge.id];
    if (!report) continue;
    sceneEdge.health = report.health;
    sceneEdge.weight = weightOf(report.rps, busiest);
    const parts: string[] = [];
    if (report.rps !== undefined) parts.push(formatRps(report.rps));
    if (report.p99Ms !== undefined) parts.push(`p99 ${Math.round(report.p99Ms)} ms`);
    if (report.errorRate !== undefined && report.errorRate > 0) parts.push(`${percent(report.errorRate)} err`);
    if (parts.length > 0) sceneEdge.liveLabel = parts.join(' · ');
  }

  const extra: SceneEdge[] = [];
  for (const call of evidence?.undiagrammed ?? []) {
    const edge: ArchEdge = { id: `undiagrammed:${call.sourceId}:${call.targetId}`, source: call.sourceId, target: call.targetId, kind: 'sync' };
    const sceneEdge = edgeBetween(edge, scene.byNodeId.get(call.sourceId), scene.byNodeId.get(call.targetId));
    if (!sceneEdge) continue;
    sceneEdge.undiagrammed = true;
    sceneEdge.weight = weightOf(call.rps, busiest);
    sceneEdge.liveLabel =
      call.rps !== undefined
        ? $localize`:Incident mode label on a call production makes that the diagram does not draw, with its traffic:not drawn · ${formatRps(call.rps)}:rps:`
        : $localize`:Incident mode label on a call production makes that the diagram does not draw:not drawn`;
    extra.push(sceneEdge);
  }
  if (extra.length > 0) scene.ghosts = { nodes: [], edges: extra };
}

/** 1.5px for an idle call up to 6px for the busiest, on a square-root scale so quiet calls stay visible. */
function weightOf(rps: number | undefined, busiest: number): number {
  if (rps === undefined || busiest <= 0) return 1.5;
  return 1.5 + 4.5 * Math.sqrt(Math.min(rps / busiest, 1));
}

const percent = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;

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
