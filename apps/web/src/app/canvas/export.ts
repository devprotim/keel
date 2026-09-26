import { serializeDiagram, type ArchGraph, type DesignIntent, type ValidationReport } from '@keel/shared';
import { boundingBox, type Rect } from '../core/geometry';
import { buildScene } from '../core/scene';
import type { CanvasTheme } from '../core/theme';
import { drawContent, type ContentFrame } from './renderer';

/**
 * Diagram export: PNG, SVG and JSON.
 *
 * Both image formats are drawn by the same `drawContent` the live canvas uses,
 * so an export cannot drift from what is on screen. PNG renders it into an
 * offscreen canvas. SVG renders it into svgcanvas, a Canvas 2D look-alike that
 * records the same calls as SVG elements; the alternative, a second hand-written
 * SVG renderer, would have to be kept in step with this one by hand forever.
 */

export interface ImageExportOptions {
  /** Draw validation badges on nodes and edges. */
  findings: boolean;
}

/** World-space margin around the diagram, so edge nodes do not touch the image border. */
const PADDING = 40;
/** Pixel density of a PNG export. 2 keeps text crisp on retina displays and in slides. */
const PNG_SCALE = 2;
/**
 * Longest PNG side, in pixels. Browsers refuse canvases much past this (Safari
 * caps total area at about 16.7 million pixels), and a refused canvas fails
 * silently as a blank image, so large diagrams trade density for fitting.
 */
const MAX_PNG_SIDE = 8192;

export interface ExportLayout {
  /** Diagram bounds in world space, padding included. */
  bounds: Rect;
  scale: number;
  /** Output size in pixels (PNG) or user units (SVG). */
  width: number;
  height: number;
}

/** Where the diagram sits and how large the image must be. Null for an empty diagram. */
export function exportLayout(graph: ArchGraph, preferredScale: number): ExportLayout | null {
  const content = boundingBox(graph.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })));
  if (!content) return null;

  const bounds: Rect = {
    x: content.x - PADDING,
    y: content.y - PADDING,
    w: content.w + PADDING * 2,
    h: content.h + PADDING * 2,
  };
  const scale = Math.min(preferredScale, MAX_PNG_SIDE / Math.max(bounds.w, bounds.h));
  return {
    bounds,
    scale,
    width: Math.max(1, Math.round(bounds.w * scale)),
    height: Math.max(1, Math.round(bounds.h * scale)),
  };
}

function exportFrame(
  graph: ArchGraph,
  report: ValidationReport | null,
  theme: CanvasTheme,
  layout: ExportLayout,
  options: ImageExportOptions,
): ContentFrame {
  return {
    scene: buildScene(graph, options.findings ? report : null),
    viewport: {
      panX: -layout.bounds.x * layout.scale,
      panY: -layout.bounds.y * layout.scale,
      zoom: layout.scale,
    },
    width: layout.width,
    height: layout.height,
    theme,
    selection: new Set(),
    hoveredId: null,
    grid: false,
  };
}

/**
 * Wait for the web fonts the renderer names.
 *
 * Canvas text does not wait for fonts the way DOM text does: drawing before
 * Geist has loaded silently falls back to the system face, and text measured
 * against one font and shown in another truncates in the wrong place.
 */
async function fontsReady(): Promise<void> {
  await Promise.allSettled([
    document.fonts.load('600 14px Geist'),
    document.fonts.load('10.5px "Geist Mono"'),
  ]);
  await document.fonts.ready;
}

export async function exportPng(
  graph: ArchGraph,
  report: ValidationReport | null,
  theme: CanvasTheme,
  options: ImageExportOptions,
): Promise<Blob> {
  const layout = exportLayout(graph, PNG_SCALE);
  if (!layout) throw new Error('The diagram is empty.');
  await fontsReady();

  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not create an image of that size.');

  drawContent(ctx, exportFrame(graph, report, theme, layout, options));

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('This browser could not encode the image.'));
    }, 'image/png');
  });
}

export async function exportSvg(
  graph: ArchGraph,
  report: ValidationReport | null,
  theme: CanvasTheme,
  options: ImageExportOptions,
): Promise<Blob> {
  // SVG is vector, so there is no density to choose: one world unit, one user unit.
  const layout = exportLayout(graph, 1);
  if (!layout) throw new Error('The diagram is empty.');
  await fontsReady();

  // Loaded on demand: most sessions never export an SVG, so it stays out of
  // the initial bundle. The ESM build, not the package entry: see svgcanvas.d.ts.
  const { Context } = await import('svgcanvas/dist/svgcanvas.esm.js');
  const ctx = new Context({ width: layout.width, height: layout.height });

  // svgcanvas implements the subset of CanvasRenderingContext2D the renderer
  // uses (paths, arcs, ellipses, roundRect, dashes, text, transforms); it
  // does not render shadows, so nodes lose their soft drop shadow in SVG.
  drawContent(ctx as unknown as CanvasRenderingContext2D, exportFrame(graph, report, theme, layout, options));

  const svg = ctx.getSerializedSvg();
  return new Blob([svg], { type: 'image/svg+xml' });
}

/**
 * The diagram as JSON, in exactly the shape `POST /api/validate` accepts and
 * Import reads. The format itself lives in @keel/shared (diagram-file.ts).
 */
export function exportJson(graph: ArchGraph, intent: DesignIntent): Blob {
  return new Blob([serializeDiagram(graph, intent)], { type: 'application/json' });
}

/** `keel-<room>-<yyyy-mm-dd>.<ext>`, so repeated exports sort by date instead of overwriting. */
export function exportFilename(roomId: string, extension: string, at = new Date()): string {
  const date = at.toISOString().slice(0, 10);
  return `keel-${roomId}-${date}.${extension}`;
}

/** Hand a blob to the browser as a file download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in some browsers before it
  // has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
