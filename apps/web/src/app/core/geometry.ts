/**
 * Canvas geometry.
 *
 * Two coordinate spaces exist and must never be confused. **World** space is
 * where the diagram lives: a node at x=400 is at x=400 forever, whatever the user
 * has panned or zoomed to. **Screen** space is pixels in the canvas element.
 *
 * Every function here is pure. Rendering and hit testing both depend on this
 * being correct, and geometry bugs are miserable to debug through a canvas, so it
 * is worth testing directly instead.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The camera. `pan` is a screen-space offset, `zoom` a scale factor.
 *
 * screen = world * zoom + pan
 */
export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export const IDENTITY_VIEWPORT: Viewport = { panX: 0, panY: 0, zoom: 1 };

export function worldToScreen(point: Point, viewport: Viewport): Point {
  return {
    x: point.x * viewport.zoom + viewport.panX,
    y: point.y * viewport.zoom + viewport.panY,
  };
}

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.panX) / viewport.zoom,
    y: (point.y - viewport.panY) / viewport.zoom,
  };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Zoom while keeping the world point under `anchor` pinned to that screen pixel.
 *
 * This is what makes wheel-zoom feel right: the diagram scales around the cursor
 * rather than around the origin. Getting it wrong is immediately obvious to the
 * user and is the single most common canvas bug, which is why it is derived
 * rather than guessed: solve `anchor = world * newZoom + newPan` for `newPan`,
 * where `world` is whatever was under the cursor before the zoom.
 */
export function zoomAt(viewport: Viewport, anchor: Point, nextZoom: number): Viewport {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(anchor, viewport);

  return {
    zoom,
    panX: anchor.x - world.x * zoom,
    panY: anchor.y - world.y * zoom,
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, panX: viewport.panX + dx, panY: viewport.panY + dy };
}

export function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

/** True when two rectangles share any area. Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Smallest rectangle containing all inputs, or null when given none. */
export function boundingBox(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Rectangle spanned by two corners, in any order. Used for marquee selection. */
export function rectFromCorners(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/**
 * Viewport that fits `content` inside a viewport of `width` x `height`.
 *
 * Zoom is capped at 1 so that opening a diagram with three small boxes does not
 * blow them up to fill the screen, which reads as broken rather than helpful.
 */
export function fitToContent(
  content: Rect,
  width: number,
  height: number,
  padding = 64,
): Viewport {
  if (content.w <= 0 || content.h <= 0 || width <= 0 || height <= 0) {
    return IDENTITY_VIEWPORT;
  }

  const zoom = clampZoom(
    Math.min((width - padding * 2) / content.w, (height - padding * 2) / content.h, 1),
  );
  const center = rectCenter(content);

  return {
    zoom,
    panX: width / 2 - center.x * zoom,
    panY: height / 2 - center.y * zoom,
  };
}

/**
 * Where a line from `from` to the centre of `rect` crosses the rectangle border.
 *
 * Edges are drawn between borders, not centres, so the arrowhead lands on the
 * edge of the box instead of disappearing underneath it. Solved by scaling the
 * direction vector until it hits the nearer of the vertical and horizontal
 * bounds, which is exact for an axis-aligned rectangle and far cheaper than
 * testing all four sides.
 */
export function borderPoint(rect: Rect, from: Point): Point {
  const center = rectCenter(rect);
  const dx = from.x - center.x;
  const dy = from.y - center.y;

  // Degenerate case: the other end is at our centre, so there is no direction to
  // travel along. Returning the centre keeps the caller total.
  if (dx === 0 && dy === 0) return center;

  const halfW = rect.w / 2;
  const halfH = rect.h / 2;

  // How far along the ray we can go before crossing each bound.
  const scaleX = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

/**
 * Shortest distance from a point to a line segment.
 *
 * Used to hit-test edges, which have no area. The clamp on `t` is what makes it
 * a segment rather than an infinite line: without it, clicking far off the end of
 * a short edge would still select it.
 */
export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  // Zero-length segment: the two endpoints coincide, so distance is to the point.
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Snap a world coordinate to the nearest grid intersection. */
export function snapToGrid(value: number, grid: number): number {
  return grid <= 0 ? value : Math.round(value / grid) * grid;
}
