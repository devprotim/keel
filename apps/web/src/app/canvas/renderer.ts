import type { EdgeKind, NodeKind, Severity } from '@keel/shared';
import {
  rectFromCorners,
  worldToScreen,
  type Point,
  type Rect,
  type Viewport,
} from '../core/geometry';
import type { Scene, SceneEdge, SceneNode } from '../core/scene';
import { presenceColor, type CanvasTheme } from '../core/theme';

/**
 * Immediate-mode canvas rendering.
 *
 * Split across two canvases stacked in the same box. The **content** layer holds
 * the grid, edges and nodes, and is redrawn only when the scene or the camera
 * changes. The **overlay** layer holds live cursors, the selection marquee and
 * the in-progress edge, and is redrawn on every pointer move.
 *
 * The split is the whole performance story: remote cursors move constantly, and
 * without it every mouse movement anywhere in the room would force a full
 * re-render of every node and edge in the diagram.
 */

export interface ContentFrame {
  scene: Scene;
  viewport: Viewport;
  width: number;
  height: number;
  theme: CanvasTheme;
  selection: ReadonlySet<string>;
  hoveredId: string | null;
}

export interface RemoteCursor {
  clientId: number;
  name: string;
  /** World-space position. Undefined while the peer's pointer is off-canvas. */
  point: Point | null;
  selection: readonly string[];
}

export interface OverlayFrame {
  viewport: Viewport;
  width: number;
  height: number;
  theme: CanvasTheme;
  cursors: readonly RemoteCursor[];
  /** Marquee rectangle in world space, while a drag-select is in progress. */
  marquee: { start: Point; end: Point } | null;
  /** Edge being drawn, from a source anchor to the current pointer. */
  pendingEdge: { from: Point; to: Point } | null;
}

const GRID_SIZE = 24;
/** Below this zoom the grid becomes visual noise, so it is dropped. */
const GRID_MIN_ZOOM = 0.45;
const NODE_RADIUS = 10;
const ACCENT_BAR_WIDTH = 4;

/**
 * Size the backing store for the device pixel ratio.
 *
 * Without this the canvas is bitmap-scaled by the browser and everything looks
 * soft on any retina display, which reads as low quality before a user has
 * evaluated a single feature. Returns true when the size actually changed, since
 * assigning width or height clears the canvas even when the value is identical.
 */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): boolean {
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width === width && canvas.height === height) return false;

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return true;
}

export function drawContent(ctx: CanvasRenderingContext2D, frame: ContentFrame): void {
  const { theme, width, height, viewport } = frame;

  ctx.save();
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, frame);

  // World transform for everything below, so drawing code can work in world
  // units and stop thinking about the camera.
  ctx.translate(viewport.panX, viewport.panY);
  ctx.scale(viewport.zoom, viewport.zoom);

  // Edges first so nodes paint over the lines that terminate on them.
  for (const edge of frame.scene.edges) drawEdge(ctx, edge, frame);
  for (const node of frame.scene.nodes) drawNode(ctx, node, frame);

  ctx.restore();
}

export function drawOverlay(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
  const { theme, width, height, viewport } = frame;
  ctx.clearRect(0, 0, width, height);

  if (frame.marquee) {
    const rect = rectFromCorners(
      worldToScreen(frame.marquee.start, viewport),
      worldToScreen(frame.marquee.end, viewport),
    );
    ctx.save();
    ctx.fillStyle = theme.marqueeFill;
    ctx.strokeStyle = theme.marquee;
    ctx.lineWidth = 1;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    ctx.restore();
  }

  if (frame.pendingEdge) {
    const from = worldToScreen(frame.pendingEdge.from, viewport);
    const to = worldToScreen(frame.pendingEdge.to, viewport);

    ctx.save();
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawArrowhead(ctx, from, to, theme.selection, 1);
    ctx.restore();
  }

  for (const cursor of frame.cursors) drawCursor(ctx, cursor, frame);
}

/**
 * Grid drawn in screen space, not world space.
 *
 * Transforming the context and drawing world-space lines would make the stroke
 * width scale with zoom, so the grid would turn into thick slabs when zoomed in
 * and vanish when zoomed out. Computing screen positions keeps every line
 * exactly one hairline wide at any zoom.
 */
function drawGrid(ctx: CanvasRenderingContext2D, frame: ContentFrame): void {
  const { viewport, width, height, theme } = frame;
  if (viewport.zoom < GRID_MIN_ZOOM) return;

  const step = GRID_SIZE * viewport.zoom;
  const startX = viewport.panX % step;
  const startY = viewport.panY % step;

  ctx.save();
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();

  // The 0.5 offset puts each line on a pixel centre; without it a 1px line
  // straddles two device pixels and renders as a 2px blur.
  for (let x = startX; x <= width; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = startY; y <= height; y += step) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
  }

  ctx.stroke();
  ctx.restore();
}

const EDGE_DASH: Record<EdgeKind, number[]> = {
  sync: [],
  async: [7, 5],
  stream: [2, 4],
};

function drawEdge(ctx: CanvasRenderingContext2D, edge: SceneEdge, frame: ContentFrame): void {
  const { theme } = frame;
  const selected = frame.selection.has(edge.edge.id);
  const color = edge.severity ? theme.severity[edge.severity] : selected ? theme.selection : theme.edge;
  const lineWidth = selected ? 2.5 : edge.severity ? 2 : 1.5;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(EDGE_DASH[edge.edge.kind]);

  ctx.beginPath();
  ctx.moveTo(edge.from.x, edge.from.y);
  ctx.lineTo(edge.to.x, edge.to.y);
  ctx.stroke();

  // The arrowhead is solid even on a dashed edge; a dashed arrowhead reads as a
  // rendering glitch rather than a style.
  ctx.setLineDash([]);
  drawArrowhead(ctx, edge.from, edge.to, color, 1);

  if (edge.edge.label) {
    drawEdgeLabel(ctx, edge, theme);
  }

  ctx.restore();
}

function drawEdgeLabel(ctx: CanvasRenderingContext2D, edge: SceneEdge, theme: CanvasTheme): void {
  const label = edge.edge.label ?? '';
  ctx.save();
  ctx.font = '11px Geist, ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Knock a plate out of the line so the text stays readable where it crosses.
  const width = ctx.measureText(label).width + 8;
  ctx.fillStyle = theme.background;
  ctx.fillRect(edge.mid.x - width / 2, edge.mid.y - 8, width, 16);

  ctx.fillStyle = theme.edgeText;
  ctx.fillText(label, edge.mid.x, edge.mid.y);
  ctx.restore();
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  scale: number,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = 10 * scale;
  const spread = Math.PI / 7;

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - length * Math.cos(angle - spread), to.y - length * Math.sin(angle - spread));
  ctx.lineTo(to.x - length * Math.cos(angle + spread), to.y - length * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawNode(ctx: CanvasRenderingContext2D, sceneNode: SceneNode, frame: ContentFrame): void {
  const { theme } = frame;
  const { rect, node } = sceneNode;
  const selected = frame.selection.has(node.id);
  const hovered = frame.hoveredId === node.id;
  const accent = theme.kindAccent[node.kind];

  ctx.save();

  // Shadow is applied to the fill only. Leaving it on would smear the border
  // stroke and the accent bar as well, which looks blurry rather than raised.
  ctx.shadowColor = theme.nodeShadow;
  ctx.shadowBlur = selected ? 16 : 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = theme.nodeFill;
  traceNodeShape(ctx, rect, node.kind);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.strokeStyle = severityOrDefault(sceneNode.severity, selected, theme);
  ctx.lineWidth = selected || sceneNode.severity ? 2 : 1;
  if (node.kind === 'external') ctx.setLineDash([6, 4]);
  traceNodeShape(ctx, rect, node.kind);
  ctx.stroke();
  ctx.setLineDash([]);

  drawAccentBar(ctx, rect, node.kind, accent);

  if (hovered && !selected) {
    ctx.strokeStyle = theme.selection;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 2;
    traceNodeShape(ctx, rect, node.kind);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawNodeText(ctx, sceneNode, theme);

  if (sceneNode.severity) {
    drawSeverityBadge(ctx, rect, theme.severity[sceneNode.severity]);
  }

  ctx.restore();
}

function severityOrDefault(
  severity: Severity | null,
  selected: boolean,
  theme: CanvasTheme,
): string {
  if (severity) return theme.severity[severity];
  return selected ? theme.selection : theme.nodeStroke;
}

/**
 * A coloured spine down the left edge, clipped to the node's own silhouette.
 *
 * Clipping is what lets one accent routine serve every shape: without it the bar
 * would square off the rounded corners it sits inside.
 */
function drawAccentBar(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  kind: NodeKind,
  color: string,
): void {
  ctx.save();
  traceNodeShape(ctx, rect, kind);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, ACCENT_BAR_WIDTH, rect.h);
  ctx.restore();
}

function drawNodeText(
  ctx: CanvasRenderingContext2D,
  sceneNode: SceneNode,
  theme: CanvasTheme,
): void {
  const { rect, node } = sceneNode;
  const left = rect.x + ACCENT_BAR_WIDTH + 12;
  const available = rect.w - (ACCENT_BAR_WIDTH + 12) - 12;

  ctx.save();
  ctx.textAlign = 'left';

  ctx.fillStyle = theme.nodeMutedText;
  ctx.font = '10px Geist, ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(node.kind.toUpperCase(), left, rect.y + 10);

  ctx.fillStyle = theme.nodeText;
  ctx.font = '600 14px Geist, ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(ctx, node.label, available), left, rect.y + rect.h / 2 + 2);

  const subtitle = subtitleFor(node.kind, node.replicas, node.tech);
  if (subtitle) {
    ctx.fillStyle = theme.nodeMutedText;
    ctx.font = '11px Geist, ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(truncate(ctx, subtitle, available), left, rect.y + rect.h - 9);
  }

  ctx.restore();
}

function subtitleFor(kind: NodeKind, replicas: number, tech: string | undefined): string {
  const parts: string[] = [];
  if (tech) parts.push(tech);
  // Replica count is only meaningful for things we run ourselves.
  if (kind !== 'external') parts.push(replicas === 1 ? '1 instance' : `${replicas} instances`);
  return parts.join('  ·  ');
}

/** Clip a string to the available width, with an ellipsis. */
function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;

  // Binary search rather than trimming one character at a time: measureText is
  // the expensive call here and this turns O(n) measurements into O(log n).
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }

  return low > 0 ? `${text.slice(0, low)}…` : '';
}

function drawSeverityBadge(ctx: CanvasRenderingContext2D, rect: Rect, color: string): void {
  const radius = 7;
  const cx = rect.x + rect.w - radius - 6;
  const cy = rect.y + radius + 6;

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 10px Geist, ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', cx, cy + 0.5);
  ctx.restore();
}

/**
 * Trace the silhouette for a node kind without filling or stroking it.
 *
 * Separated from painting so fill, stroke and clip all share one definition. Two
 * copies of the path maths would eventually disagree, and the bug would show up
 * as a border that does not match its own fill.
 */
function traceNodeShape(ctx: CanvasRenderingContext2D, rect: Rect, kind: NodeKind): void {
  ctx.beginPath();

  switch (kind) {
    case 'datastore':
      traceCylinder(ctx, rect);
      break;
    case 'gateway':
      traceHexagon(ctx, rect);
      break;
    case 'queue':
      traceStadium(ctx, rect);
      break;
    default:
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, NODE_RADIUS);
  }
}

/** A database drum: an ellipse cap on top, straight sides, curved base. */
function traceCylinder(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const capHeight = Math.min(14, rect.h / 4);
  const radiusX = rect.w / 2;
  const cx = rect.x + radiusX;

  ctx.ellipse(cx, rect.y + capHeight, radiusX, capHeight, 0, Math.PI, 0);
  ctx.lineTo(rect.x + rect.w, rect.y + rect.h - capHeight);
  ctx.ellipse(cx, rect.y + rect.h - capHeight, radiusX, capHeight, 0, 0, Math.PI);
  ctx.closePath();
}

function traceHexagon(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const inset = Math.min(16, rect.w / 5);
  ctx.moveTo(rect.x + inset, rect.y);
  ctx.lineTo(rect.x + rect.w - inset, rect.y);
  ctx.lineTo(rect.x + rect.w, rect.y + rect.h / 2);
  ctx.lineTo(rect.x + rect.w - inset, rect.y + rect.h);
  ctx.lineTo(rect.x + inset, rect.y + rect.h);
  ctx.lineTo(rect.x, rect.y + rect.h / 2);
  ctx.closePath();
}

/** Fully rounded ends, evoking a pipe. */
function traceStadium(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, rect.h / 2);
}

/**
 * A collaborator's pointer, drawn in screen space so it stays a constant size.
 *
 * Scaling cursors with the diagram would make a zoomed-out peer's pointer
 * invisible, which defeats the purpose of showing it.
 */
function drawCursor(
  ctx: CanvasRenderingContext2D,
  cursor: RemoteCursor,
  frame: OverlayFrame,
): void {
  if (!cursor.point) return;

  const at = worldToScreen(cursor.point, frame.viewport);
  // Skip peers scrolled off screen; the label would otherwise pin to the edge
  // and imply they are somewhere they are not.
  if (at.x < -40 || at.y < -40 || at.x > frame.width + 40 || at.y > frame.height + 40) return;

  const color = presenceColor(cursor.clientId);

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(at.x, at.y + 16);
  ctx.lineTo(at.x + 4.5, at.y + 12);
  ctx.lineTo(at.x + 11, at.y + 11.5);
  ctx.closePath();
  ctx.fill();

  if (cursor.name) {
    ctx.font = '600 11px Geist, ui-sans-serif, system-ui, sans-serif';
    const width = ctx.measureText(cursor.name).width + 12;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(at.x + 12, at.y + 14, width, 18, 5);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(cursor.name, at.x + 18, at.y + 23.5);
  }

  ctx.restore();
}
