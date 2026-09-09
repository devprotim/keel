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
const NODE_RADIUS = 12;

/** Kind chip: the small tile inside every node that carries kind identity. */
const CHIP_SIZE = 24;
const CHIP_RADIUS = 7;
/** Chip's left edge, offset from the node's own left edge. */
const CHIP_INSET_X = 14;
/** Chip's top edge, offset from the node's own top edge. */
const CHIP_INSET_Y = 12;
/** Glyph padding within the chip, and the glyph's own rendered size. */
const GLYPH_INSET = 4.5;
const GLYPH_SIZE = 15;

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

  ctx.save();

  // Shadow is applied to the fill only. Leaving it on would smear the border
  // stroke as well, which looks blurry rather than raised.
  ctx.shadowColor = theme.nodeShadow;
  ctx.shadowBlur = selected ? 16 : 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = theme.nodeFill;
  traceNodeShape(ctx, rect);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.strokeStyle = severityOrDefault(sceneNode.severity, selected, theme);
  ctx.lineWidth = selected || sceneNode.severity ? 2 : 1;
  if (node.kind === 'external') ctx.setLineDash([6, 4]);
  traceNodeShape(ctx, rect);
  ctx.stroke();
  ctx.setLineDash([]);

  if (hovered && !selected) {
    ctx.strokeStyle = theme.selection;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 2;
    traceNodeShape(ctx, rect);
    ctx.stroke();
    ctx.globalAlpha = 1;

    drawConnectHandles(ctx, rect, theme);
  }

  drawNodeContent(ctx, sceneNode, theme);

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
 * Small dots at the midpoint of each side of a hovered node.
 *
 * Alt/Cmd-drag from anywhere on a node starts a connection, but nothing about
 * a plain rectangle says so. These mark the node as a link source the moment
 * the pointer arrives, before the modifier key is even pressed.
 */
function drawConnectHandles(ctx: CanvasRenderingContext2D, rect: Rect, theme: CanvasTheme): void {
  const radius = 3.5;
  const points: Point[] = [
    { x: rect.x + rect.w / 2, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h / 2 },
    { x: rect.x + rect.w / 2, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h / 2 },
  ];

  ctx.save();
  ctx.fillStyle = theme.selectionFill;
  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 1.5;
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Kind chip, glyph, title and the tech/instance meta line.
 *
 * Kind identity used to live in a 4px accent bar plus a 10px muted label —
 * both too quiet to register at a glance. It now lives in one chip: a 24px
 * tile in the kind hue with a glyph inside it, plus the kind name set in that
 * same hue rather than in muted grey.
 */
function drawNodeContent(
  ctx: CanvasRenderingContext2D,
  sceneNode: SceneNode,
  theme: CanvasTheme,
): void {
  const { rect, node } = sceneNode;
  const accent = theme.kindAccent[node.kind];
  const chipX = rect.x + CHIP_INSET_X;
  const chipY = rect.y + CHIP_INSET_Y;
  const textLeft = chipX;
  const available = rect.x + rect.w - 12 - textLeft;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Chip fill: the kind hue at reduced opacity, not a separate lighter token.
  // globalAlpha does the same job `fill-opacity` does in the design mock, and
  // keeps this working automatically if a kind colour is ever retuned.
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(chipX, chipY, CHIP_SIZE, CHIP_SIZE, CHIP_RADIUS);
  ctx.fill();
  ctx.restore();

  drawKindGlyph(ctx, node.kind, chipX + GLYPH_INSET, chipY + GLYPH_INSET, GLYPH_SIZE, accent);

  ctx.fillStyle = accent;
  ctx.font = '600 9px Geist, ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(node.kind.toUpperCase(), chipX + CHIP_SIZE + 7, chipY + 14.5);

  ctx.fillStyle = theme.nodeText;
  ctx.font = '600 14px Geist, ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(truncate(ctx, node.label, available), textLeft, rect.y + rect.h * 0.62);

  drawNodeMeta(ctx, node.kind, node.tech, node.replicas, textLeft, rect.y + rect.h - 11, available, theme);

  ctx.restore();
}

/**
 * Tech string plus instance count, in Geist Mono. The count turns amber when
 * it is 1 — the single-point-of-failure flag the rule engine also raises.
 *
 * `external` is excluded from that flag deliberately: `spof-single-instance`
 * skips external nodes too ("not ours to scale"), so amber-flagging an
 * external's instance count would show a warning the review panel never
 * actually raises.
 */
function drawNodeMeta(
  ctx: CanvasRenderingContext2D,
  kind: NodeKind,
  tech: string | undefined,
  replicas: number,
  left: number,
  baseline: number,
  available: number,
  theme: CanvasTheme,
): void {
  ctx.font = '10.5px Geist Mono, ui-monospace, SFMono-Regular, monospace';
  ctx.fillStyle = theme.nodeMutedText;
  const techText = tech ? truncate(ctx, tech, available) : '';
  if (techText) ctx.fillText(techText, left, baseline);

  const countLeft = techText ? left + ctx.measureText(techText).width + 8 : left;
  const isSpof = replicas === 1 && kind !== 'external';

  ctx.font = '600 10.5px Geist Mono, ui-monospace, SFMono-Regular, monospace';
  ctx.fillStyle = isSpof ? theme.severity.warning : theme.nodeMutedText;
  ctx.fillText(`×${replicas}`, countLeft, baseline);
}

/**
 * Kind glyphs, one per `NodeKind`, drawn in a local 16x16 coordinate space.
 *
 * Hand-drawn with canvas path calls rather than loaded as image assets: there
 * are only seven of them, they need to recolour with the theme and the kind
 * palette, and an SVG-to-canvas asset pipeline would be a lot of machinery for
 * seven small icons.
 */
function drawKindGlyph(
  ctx: CanvasRenderingContext2D,
  kind: NodeKind,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 16, size / 16);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (kind) {
    case 'service':
      // A module: a rounded square with a cross through its centre.
      ctx.beginPath();
      ctx.roundRect(2.5, 2.5, 11, 11, 2.5);
      ctx.moveTo(5.5, 8);
      ctx.lineTo(10.5, 8);
      ctx.moveTo(8, 5.5);
      ctx.lineTo(8, 10.5);
      ctx.stroke();
      break;

    case 'datastore':
      // A database drum: an ellipse cap, straight sides, a curved base and a
      // belt line showing the drum is hollow.
      ctx.beginPath();
      ctx.ellipse(8, 4.2, 5.5, 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(2.5, 4.2);
      ctx.lineTo(2.5, 11.8);
      ctx.bezierCurveTo(2.5, 12.9, 5, 13.8, 8, 13.8);
      ctx.bezierCurveTo(11, 13.8, 13.5, 12.9, 13.5, 11.8);
      ctx.lineTo(13.5, 4.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(2.5, 8);
      ctx.bezierCurveTo(2.5, 9.1, 5, 10, 8, 10);
      ctx.bezierCurveTo(11, 10, 13.5, 9.1, 13.5, 8);
      ctx.stroke();
      break;

    case 'queue':
      // A stadium with two dividers: stacked messages.
      ctx.beginPath();
      ctx.roundRect(1.5, 5, 13, 6, 3);
      ctx.moveTo(5.5, 5);
      ctx.lineTo(5.5, 11);
      ctx.moveTo(9, 5);
      ctx.lineTo(9, 11);
      ctx.stroke();
      break;

    case 'cache':
      // A lightning bolt.
      ctx.beginPath();
      ctx.moveTo(8, 1.5);
      ctx.lineTo(3, 8);
      ctx.lineTo(6.5, 8);
      ctx.lineTo(5.5, 14.5);
      ctx.lineTo(11, 8);
      ctx.lineTo(7.5, 8);
      ctx.closePath();
      ctx.stroke();
      break;

    case 'gateway':
      // A hexagon with a vertical spine, echoing the shape gateways used to
      // have as their whole silhouette.
      ctx.beginPath();
      ctx.moveTo(8, 1.8);
      ctx.lineTo(13.6, 5);
      ctx.lineTo(13.6, 11);
      ctx.lineTo(8, 14.2);
      ctx.lineTo(2.4, 11);
      ctx.lineTo(2.4, 5);
      ctx.closePath();
      ctx.moveTo(8, 5.5);
      ctx.lineTo(8, 10.5);
      ctx.stroke();
      break;

    case 'job':
      // A clock face.
      ctx.beginPath();
      ctx.arc(8, 8, 5.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(8, 5);
      ctx.lineTo(8, 8.2);
      ctx.lineTo(10.4, 9.6);
      ctx.stroke();
      break;

    case 'external':
      // An external-link icon: a frame with an arrow escaping its corner.
      ctx.beginPath();
      ctx.roundRect(2.5, 5.7, 9, 7.8, 1.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(9.5, 2.5);
      ctx.lineTo(13.5, 2.5);
      ctx.lineTo(13.5, 6.5);
      ctx.moveTo(13.5, 2.5);
      ctx.lineTo(7.8, 8.2);
      ctx.stroke();
      break;
  }

  ctx.restore();
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
 * Trace a node's outline without filling or stroking it.
 *
 * Separated from painting so fill, stroke and the hover ring all share one
 * definition. Every kind is the same rounded rect now — kind identity lives in
 * the chip drawn inside the node (`drawNodeContent`), not in the silhouette —
 * so unlike the fill/stroke/clip split this used to serve, there is no
 * per-kind branch left to keep in sync.
 */
function traceNodeShape(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, NODE_RADIUS);
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
