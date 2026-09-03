import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  IDENTITY_VIEWPORT,
  borderPoint,
  boundingBox,
  clampZoom,
  distanceToSegment,
  fitToContent,
  rectContains,
  rectFromCorners,
  rectsOverlap,
  screenToWorld,
  snapToGrid,
  worldToScreen,
  zoomAt,
  type Rect,
  type Viewport,
} from './geometry';

const viewport = (overrides: Partial<Viewport> = {}): Viewport => ({
  ...IDENTITY_VIEWPORT,
  ...overrides,
});

describe('coordinate conversion', () => {
  it('is identity at zoom 1 with no pan', () => {
    expect(worldToScreen({ x: 10, y: 20 }, viewport())).toEqual({ x: 10, y: 20 });
  });

  it('applies zoom then pan', () => {
    const vp = viewport({ zoom: 2, panX: 100, panY: 50 });
    expect(worldToScreen({ x: 10, y: 10 }, vp)).toEqual({ x: 120, y: 70 });
  });

  it('round-trips through screen space', () => {
    const vp = viewport({ zoom: 0.37, panX: -412, panY: 88 });
    const original = { x: 1234.5, y: -678.25 };
    const round = screenToWorld(worldToScreen(original, vp), vp);

    expect(round.x).toBeCloseTo(original.x, 9);
    expect(round.y).toBeCloseTo(original.y, 9);
  });
});

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    // The defining property of cursor-anchored zoom. If this fails, the diagram
    // slides out from under the pointer on every scroll.
    const vp = viewport({ zoom: 1, panX: 30, panY: -12 });
    const anchor = { x: 250, y: 180 };
    const worldBefore = screenToWorld(anchor, vp);

    const zoomed = zoomAt(vp, anchor, 2.5);
    const screenAfter = worldToScreen(worldBefore, zoomed);

    expect(screenAfter.x).toBeCloseTo(anchor.x, 9);
    expect(screenAfter.y).toBeCloseTo(anchor.y, 9);
  });

  it('holds the anchor across repeated zooms', () => {
    const anchor = { x: 640, y: 400 };
    let vp = viewport();
    const world = screenToWorld(anchor, vp);

    for (const zoom of [1.3, 1.8, 0.7, 3.2, 0.4]) {
      vp = zoomAt(vp, anchor, zoom);
      const screen = worldToScreen(world, vp);
      expect(screen.x).toBeCloseTo(anchor.x, 6);
      expect(screen.y).toBeCloseTo(anchor.y, 6);
    }
  });

  it('clamps beyond the zoom limits', () => {
    expect(zoomAt(viewport(), { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(viewport(), { x: 0, y: 0 }, 0.0001).zoom).toBe(MIN_ZOOM);
  });

  it('still pins the anchor when the zoom was clamped', () => {
    // A naive implementation computes pan from the requested zoom and then
    // clamps, which drifts precisely when the user is zoomed all the way in.
    const anchor = { x: 300, y: 200 };
    const vp = viewport({ zoom: MAX_ZOOM });
    const world = screenToWorld(anchor, vp);

    const screen = worldToScreen(world, zoomAt(vp, anchor, 999));
    expect(screen.x).toBeCloseTo(anchor.x, 9);
    expect(screen.y).toBeCloseTo(anchor.y, 9);
  });
});

describe('clampZoom', () => {
  it('passes through values in range', () => {
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe('rect helpers', () => {
  const rect: Rect = { x: 10, y: 10, w: 100, h: 50 };

  it('detects containment, including on the border', () => {
    expect(rectContains(rect, { x: 50, y: 30 })).toBe(true);
    expect(rectContains(rect, { x: 10, y: 10 })).toBe(true);
    expect(rectContains(rect, { x: 9, y: 30 })).toBe(false);
  });

  it('detects overlap but not mere touching', () => {
    expect(rectsOverlap(rect, { x: 50, y: 30, w: 100, h: 50 })).toBe(true);
    expect(rectsOverlap(rect, { x: 110, y: 10, w: 10, h: 10 })).toBe(false);
  });

  it('builds a rect from corners in any order', () => {
    const fromCorners = rectFromCorners({ x: 100, y: 80 }, { x: 20, y: 10 });
    expect(fromCorners).toEqual({ x: 20, y: 10, w: 80, h: 70 });
  });

  it('bounds a set of rects', () => {
    expect(boundingBox([rect, { x: 200, y: 5, w: 50, h: 20 }])).toEqual({
      x: 10,
      y: 5,
      w: 240,
      h: 55,
    });
  });

  it('returns null for an empty set', () => {
    expect(boundingBox([])).toBeNull();
  });
});

describe('fitToContent', () => {
  it('centres the content', () => {
    const content: Rect = { x: 0, y: 0, w: 200, h: 100 };
    const vp = fitToContent(content, 1000, 600);
    const center = worldToScreen({ x: 100, y: 50 }, vp);

    expect(center.x).toBeCloseTo(500, 6);
    expect(center.y).toBeCloseTo(300, 6);
  });

  it('does not magnify small diagrams past 1:1', () => {
    // Three small boxes blown up to fill a 4K screen reads as a bug.
    expect(fitToContent({ x: 0, y: 0, w: 50, h: 50 }, 1920, 1080).zoom).toBe(1);
  });

  it('shrinks to fit a large diagram', () => {
    expect(fitToContent({ x: 0, y: 0, w: 8000, h: 4000 }, 1000, 600).zoom).toBeLessThan(1);
  });

  it('falls back to identity on degenerate input', () => {
    expect(fitToContent({ x: 0, y: 0, w: 0, h: 0 }, 100, 100)).toEqual(IDENTITY_VIEWPORT);
  });
});

describe('borderPoint', () => {
  const rect: Rect = { x: 0, y: 0, w: 100, h: 100 };

  it('exits through the right edge for a point due east', () => {
    expect(borderPoint(rect, { x: 500, y: 50 })).toEqual({ x: 100, y: 50 });
  });

  it('exits through the top edge for a point due north', () => {
    expect(borderPoint(rect, { x: 50, y: -500 })).toEqual({ x: 50, y: 0 });
  });

  it('lands exactly on a corner for a diagonal of equal aspect', () => {
    expect(borderPoint(rect, { x: 600, y: 600 })).toEqual({ x: 100, y: 100 });
  });

  it('always returns a point on the border', () => {
    const wide: Rect = { x: -30, y: 40, w: 180, h: 60 };
    for (const angle of [0, 0.7, 1.9, 3.0, 4.4, 5.8]) {
      const from = { x: 60 + Math.cos(angle) * 900, y: 70 + Math.sin(angle) * 900 };
      const point = borderPoint(wide, from);

      const onVertical = Math.abs(point.x - wide.x) < 1e-9 || Math.abs(point.x - (wide.x + wide.w)) < 1e-9;
      const onHorizontal = Math.abs(point.y - wide.y) < 1e-9 || Math.abs(point.y - (wide.y + wide.h)) < 1e-9;

      expect(onVertical || onHorizontal).toBe(true);
      expect(rectContains(wide, point)).toBe(true);
    }
  });

  it('returns the centre when the target coincides with it', () => {
    expect(borderPoint(rect, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
  });
});

describe('distanceToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };

  it('measures perpendicular distance within the segment', () => {
    expect(distanceToSegment({ x: 50, y: 10 }, a, b)).toBeCloseTo(10, 9);
  });

  it('measures to the nearest endpoint beyond the segment', () => {
    // Without clamping this would report 10 instead of ~50, and clicking far off
    // the end of a short edge would select it.
    expect(distanceToSegment({ x: 150, y: 10 }, a, b)).toBeCloseTo(Math.hypot(50, 10), 9);
  });

  it('is zero on the segment', () => {
    expect(distanceToSegment({ x: 40, y: 0 }, a, b)).toBeCloseTo(0, 9);
  });

  it('handles a zero-length segment', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, a, a)).toBeCloseTo(5, 9);
  });
});

describe('snapToGrid', () => {
  it('snaps to the nearest multiple', () => {
    expect(snapToGrid(23, 10)).toBe(20);
    expect(snapToGrid(26, 10)).toBe(30);
    expect(snapToGrid(-23, 10)).toBe(-20);
  });

  it('is a no-op for a non-positive grid', () => {
    expect(snapToGrid(23.7, 0)).toBe(23.7);
  });
});
