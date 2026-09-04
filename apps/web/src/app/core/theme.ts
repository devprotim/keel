import type { NodeKind, Severity } from '@keel/shared';

/**
 * Canvas colours, read from the stylesheet rather than duplicated here.
 *
 * A canvas cannot use CSS, so the usual outcome is a second palette hardcoded in
 * TypeScript that drifts from the real one. Reading the custom properties off the
 * host element keeps the SCSS token layer as the single source of truth, and
 * means dark mode works on the canvas for free: the tokens change, the canvas is
 * re-read, nothing else has to know.
 */

export interface CanvasTheme {
  background: string;
  grid: string;
  gridStrong: string;

  nodeFill: string;
  nodeStroke: string;
  nodeText: string;
  nodeMutedText: string;
  nodeShadow: string;

  kindAccent: Record<NodeKind, string>;
  severity: Record<Severity, string>;

  edge: string;
  edgeText: string;
  arrow: string;

  selection: string;
  selectionFill: string;
  marquee: string;
  marqueeFill: string;
}

/** Used when a token is missing, so a typo degrades rather than renders nothing. */
const FALLBACK: CanvasTheme = {
  background: '#fbfbfd',
  grid: '#eceef3',
  gridStrong: '#dfe3ea',
  nodeFill: '#ffffff',
  nodeStroke: '#d5d9e2',
  nodeText: '#1c2028',
  nodeMutedText: '#6b7280',
  nodeShadow: 'rgba(16, 24, 40, 0.08)',
  kindAccent: {
    service: '#db2777',
    datastore: '#8b5cf6',
    queue: '#e8890c',
    cache: '#0ea5e9',
    gateway: '#0d9488',
    job: '#64748b',
    external: '#94a3b8',
  },
  severity: { error: '#dc2626', warning: '#d97706', info: '#2563eb' },
  edge: '#98a2b3',
  edgeText: '#6b7280',
  arrow: '#98a2b3',
  selection: '#4f6bed',
  selectionFill: 'rgba(79, 107, 237, 0.08)',
  marquee: '#4f6bed',
  marqueeFill: 'rgba(79, 107, 237, 0.10)',
};

const NODE_KINDS: readonly NodeKind[] = [
  'service',
  'datastore',
  'queue',
  'cache',
  'gateway',
  'job',
  'external',
];

/**
 * Snapshot the theme from CSS custom properties on `element`.
 *
 * Called once per theme change, never inside the render loop: `getComputedStyle`
 * forces style resolution, and doing that per frame would stall rendering.
 */
export function readTheme(element: HTMLElement): CanvasTheme {
  const styles = getComputedStyle(element);
  const read = (token: string, fallback: string): string => {
    const value = styles.getPropertyValue(token).trim();
    return value.length > 0 ? value : fallback;
  };

  const kindAccent = {} as Record<NodeKind, string>;
  for (const kind of NODE_KINDS) {
    kindAccent[kind] = read(`--keel-kind-${kind}`, FALLBACK.kindAccent[kind]);
  }

  return {
    background: read('--keel-canvas-bg', FALLBACK.background),
    grid: read('--keel-canvas-grid', FALLBACK.grid),
    gridStrong: read('--keel-canvas-grid-strong', FALLBACK.gridStrong),
    nodeFill: read('--keel-node-fill', FALLBACK.nodeFill),
    nodeStroke: read('--keel-node-stroke', FALLBACK.nodeStroke),
    nodeText: read('--keel-node-text', FALLBACK.nodeText),
    nodeMutedText: read('--keel-node-muted', FALLBACK.nodeMutedText),
    nodeShadow: read('--keel-node-shadow', FALLBACK.nodeShadow),
    kindAccent,
    severity: {
      error: read('--keel-severity-error', FALLBACK.severity.error),
      warning: read('--keel-severity-warning', FALLBACK.severity.warning),
      info: read('--keel-severity-info', FALLBACK.severity.info),
    },
    edge: read('--keel-edge', FALLBACK.edge),
    edgeText: read('--keel-edge-text', FALLBACK.edgeText),
    arrow: read('--keel-arrow', FALLBACK.arrow),
    selection: read('--keel-selection', FALLBACK.selection),
    selectionFill: read('--keel-selection-fill', FALLBACK.selectionFill),
    marquee: read('--keel-marquee', FALLBACK.marquee),
    marqueeFill: read('--keel-marquee-fill', FALLBACK.marqueeFill),
  };
}

export const FALLBACK_THEME = FALLBACK;

/** Deterministic colour for a collaborator, derived from their client id. */
export function presenceColor(clientId: number): string {
  // Golden-angle hue stepping keeps consecutive joiners visually far apart,
  // where a plain modulo palette would hand near-identical colours to peers who
  // joined one after another.
  const hue = (clientId * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} 70% 52%)`;
}
