import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { createEdge, createNode, DEFAULT_NODE_SIZE, NODE_KINDS, type EdgeKind, type NodeKind } from '@keel/shared';
import { CollabService } from '../collab/collab.service';
import {
  boundingBox,
  fitToContent,
  panBy,
  rectFromCorners,
  screenToWorld,
  snapToGrid,
  zoomAt,
  type Point,
  type Viewport,
} from '../core/geometry';
import { EDGE_HIT_TOLERANCE, hitTest, nodesInRect } from '../core/hit-test';
import { buildScene } from '../core/scene';
import { FALLBACK_THEME, readTheme, type CanvasTheme } from '../core/theme';
import { drawContent, drawOverlay, resizeCanvas, type RemoteCursor } from './renderer';

/** Pointer gesture in progress. Idle is represented by null. */
type Gesture =
  | { kind: 'pan'; lastScreen: Point }
  | { kind: 'drag'; startWorld: Point; origins: ReadonlyMap<string, Point>; moved: boolean }
  | { kind: 'marquee'; startWorld: Point; currentWorld: Point; additive: boolean }
  | { kind: 'connect'; sourceId: string; fromWorld: Point; toWorld: Point };

const GRID = 8;
const ZOOM_SENSITIVITY = 0.0015;

/**
 * Drag payload MIME type for dragging a kind off the rail onto the canvas.
 * Also read by `board.component.ts`, which is where the drag starts.
 */
export const NODE_DRAG_MIME = 'application/x-keel-node-kind';

@Component({
  selector: 'keel-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './canvas.component.html',
  styleUrl: './canvas.component.scss',
})
export class CanvasComponent {
  private readonly collab = inject(CollabService);

  private readonly hostRef = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly contentRef = viewChild.required<ElementRef<HTMLCanvasElement>>('content');
  private readonly overlayRef = viewChild.required<ElementRef<HTMLCanvasElement>>('overlay');

  readonly viewport = signal<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  readonly selection = signal<ReadonlySet<string>>(new Set());
  readonly hoveredId = signal<string | null>(null);
  /** Kind placed by the next click, or null when the pointer tool is active. */
  readonly placingKind = signal<NodeKind | null>(null);
  readonly edgeKind = signal<EdgeKind>('sync');
  /** True while Alt/Cmd is held, so the cursor can preview the connect gesture. */
  readonly connectModifierHeld = signal(false);

  private readonly size = signal({ width: 0, height: 0 });
  private readonly theme = signal<CanvasTheme>(FALLBACK_THEME);
  private gesture: Gesture | null = null;

  private contentDirty = true;
  private overlayDirty = true;
  private frameHandle: number | null = null;

  private contentCtx: CanvasRenderingContext2D | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;

  readonly scene = computed(() => buildScene(this.collab.graph(), this.collab.report()));

  private readonly cursors = computed<RemoteCursor[]>(() =>
    this.collab.peers().map((peer) => ({
      clientId: peer.clientId,
      name: peer.name,
      point: peer.cursor,
      selection: peer.selection,
    })),
  );

  readonly accessibleNodes = computed(() =>
    this.collab.graph().nodes.map((node) => ({
      id: node.id,
      description: `${node.label}, ${node.kind}, ${node.replicas} ${node.replicas === 1 ? 'instance' : 'instances'}`,
    })),
  );

  /** Whether the pointer is over a node it could connect from right now. */
  readonly connectHover = computed(() => this.hoveredId() !== null && this.connectModifierHeld());

  readonly ariaLabel = computed(() => {
    const graph = this.collab.graph();
    return `Architecture canvas with ${graph.nodes.length} components and ${graph.edges.length} dependencies. Use arrow keys to move the selection, Delete to remove it.`;
  });

  constructor() {
    // Any of these changing means the content layer is stale. Overlay redraws
    // far more often and is marked separately, which is the whole point of
    // splitting the two.
    effect(() => {
      this.scene();
      this.viewport();
      this.selection();
      this.hoveredId();
      this.theme();
      this.size();
      this.markContentDirty();
    });

    effect(() => {
      this.cursors();
      this.gestureSignal();
      this.markOverlayDirty();
    });

    effect(() => {
      this.collab.publishSelection([...this.selection()]);
    });

    afterNextRender(() => this.initialise());

    inject(DestroyRef).onDestroy(() => {
      if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
      this.resizeObserver?.disconnect();
      this.themeObserver?.disconnect();
    });
  }

  /** Bumped whenever a gesture mutates, so overlay effects re-run. */
  private readonly gestureVersion = signal(0);
  private gestureSignal(): number {
    return this.gestureVersion();
  }

  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;

  private initialise(): void {
    const host = this.hostRef().nativeElement;
    this.contentCtx = this.contentRef().nativeElement.getContext('2d');
    this.overlayCtx = this.overlayRef().nativeElement.getContext('2d');
    this.theme.set(readTheme(host));

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(host);
    this.measure();

    // The canvas palette comes from CSS custom properties, so a theme switch has
    // to be observed rather than inherited. Watching the attribute that carries
    // the theme is cheaper than polling computed styles every frame.
    this.themeObserver = new MutationObserver(() => this.theme.set(readTheme(host)));
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
  }

  private measure(): void {
    const host = this.hostRef().nativeElement;
    const rect = host.getBoundingClientRect();
    this.size.set({ width: rect.width, height: rect.height });

    const dpr = globalThis.devicePixelRatio || 1;
    resizeCanvas(this.contentRef().nativeElement, rect.width, rect.height, dpr);
    resizeCanvas(this.overlayRef().nativeElement, rect.width, rect.height, dpr);

    // Reset the transform before scaling, otherwise the device-pixel scale
    // compounds on every resize and the diagram grows without bound.
    this.contentCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.markContentDirty();
    this.markOverlayDirty();
  }

  private markContentDirty(): void {
    this.contentDirty = true;
    this.schedule();
  }

  private markOverlayDirty(): void {
    this.overlayDirty = true;
    this.schedule();
  }

  /**
   * Coalesce every dirty mark in a tick into one frame.
   *
   * Without this, a pointer move that changes hover, cursor and gesture state
   * would paint three times for a single input event.
   */
  private schedule(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      this.render();
    });
  }

  private render(): void {
    const { width, height } = this.size();
    if (width === 0 || height === 0) return;

    if (this.contentDirty && this.contentCtx) {
      drawContent(this.contentCtx, {
        scene: this.scene(),
        viewport: this.viewport(),
        width,
        height,
        theme: this.theme(),
        selection: this.selection(),
        hoveredId: this.hoveredId(),
      });
      this.contentDirty = false;
    }

    if (this.overlayDirty && this.overlayCtx) {
      const gesture = this.gesture;
      drawOverlay(this.overlayCtx, {
        viewport: this.viewport(),
        width,
        height,
        theme: this.theme(),
        cursors: this.cursors(),
        marquee:
          gesture?.kind === 'marquee'
            ? { start: gesture.startWorld, end: gesture.currentWorld }
            : null,
        pendingEdge:
          gesture?.kind === 'connect' ? { from: gesture.fromWorld, to: gesture.toWorld } : null,
      });
      this.overlayDirty = false;
    }
  }

  // --- Pointer input ------------------------------------------------------

  /**
   * Hit test at the pointer, with the edge tolerance corrected for zoom.
   *
   * The tolerance is defined in world units, but what the user is actually
   * aiming with is a mouse pointer measured in screen pixels. Passing the raw
   * value shrinks the clickable band as you zoom out, so at the zoom level
   * `zoomToFit` leaves you at, a dependency line becomes almost impossible to
   * select. Dividing by zoom keeps the target a constant size on screen.
   */
  private hit(world: Point) {
    return hitTest(this.scene(), world, EDGE_HIT_TOLERANCE / this.viewport().zoom);
  }

  private toWorld(event: PointerEvent | WheelEvent | DragEvent): Point {
    return screenToWorld(this.toScreen(event), this.viewport());
  }

  private toScreen(event: PointerEvent | WheelEvent | DragEvent): Point {
    const rect = this.hostRef().nativeElement.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  onPointerDown(event: PointerEvent): void {
    this.hostRef().nativeElement.focus();
    const world = this.toWorld(event);

    // Middle button, or space held, pans. Both are established conventions and
    // costing nothing to support means neither camp has to relearn anything.
    if (event.button === 1 || this.spaceHeld) {
      this.setGesture({ kind: 'pan', lastScreen: this.toScreen(event) });
      this.capture(event);
      return;
    }

    if (event.button !== 0) return;

    const placing = this.placingKind();
    if (placing) {
      this.placeNode(placing, world);
      return;
    }

    const hit = this.hit(world);

    if (hit.kind === 'node' && (event.altKey || event.metaKey)) {
      this.setGesture({ kind: 'connect', sourceId: hit.id, fromWorld: world, toWorld: world });
      this.capture(event);
      return;
    }

    if (hit.kind === 'none') {
      this.setGesture({
        kind: 'marquee',
        startWorld: world,
        currentWorld: world,
        additive: event.shiftKey,
      });
      if (!event.shiftKey) this.selection.set(new Set());
      this.capture(event);
      return;
    }

    this.applyClickSelection(hit.id, event.shiftKey);

    if (hit.kind === 'node') {
      const origins = new Map<string, Point>();
      for (const sceneNode of this.scene().nodes) {
        if (this.selection().has(sceneNode.node.id)) {
          origins.set(sceneNode.node.id, { x: sceneNode.node.x, y: sceneNode.node.y });
        }
      }
      this.setGesture({ kind: 'drag', startWorld: world, origins, moved: false });
      this.capture(event);
    }
  }

  onPointerMove(event: PointerEvent): void {
    const world = this.toWorld(event);
    this.collab.setCursor(world);

    const gesture = this.gesture;

    if (!gesture) {
      const hit = this.hit(world);
      this.hoveredId.set(hit.kind === 'none' ? null : hit.id);
      this.markOverlayDirty();
      return;
    }

    switch (gesture.kind) {
      case 'pan': {
        const screen = this.toScreen(event);
        this.viewport.update((vp) =>
          panBy(vp, screen.x - gesture.lastScreen.x, screen.y - gesture.lastScreen.y),
        );
        this.setGesture({ kind: 'pan', lastScreen: screen });
        break;
      }

      case 'drag': {
        const dx = world.x - gesture.startWorld.x;
        const dy = world.y - gesture.startWorld.y;
        const moves = [...gesture.origins].map(([id, origin]) => ({
          id,
          // Snapping on the resulting position, not the delta, keeps a dragged
          // node aligned to the grid rather than merely offset by a multiple of
          // it from wherever it happened to start.
          x: snapToGrid(origin.x + dx, GRID),
          y: snapToGrid(origin.y + dy, GRID),
        }));
        this.collab.moveNodes(moves);
        this.setGesture({ ...gesture, moved: true });
        break;
      }

      case 'marquee': {
        this.setGesture({ ...gesture, currentWorld: world });
        const rect = rectFromCorners(gesture.startWorld, world);
        const inside = nodesInRect(this.scene(), rect);
        this.selection.set(
          gesture.additive ? new Set([...this.selection(), ...inside]) : new Set(inside),
        );
        break;
      }

      case 'connect': {
        this.setGesture({ ...gesture, toWorld: world });
        const hit = this.hit(world);
        this.hoveredId.set(hit.kind === 'node' ? hit.id : null);
        break;
      }
    }
  }

  onPointerUp(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture) return;

    if (gesture.kind === 'connect') {
      const hit = this.hit(this.toWorld(event));
      // A self-edge is almost always a mis-drop rather than an intent, and the
      // renderer skips them anyway.
      if (hit.kind === 'node' && hit.id !== gesture.sourceId) {
        this.collab.addEdge(createEdge(gesture.sourceId, hit.id, this.edgeKind()));
      }
    }

    this.setGesture(null);
    this.hoveredId.set(null);
    try {
      this.hostRef().nativeElement.releasePointerCapture(event.pointerId);
    } catch {
      // Capture was never taken, or the pointer is already gone.
    }
  }

  onPointerLeave(): void {
    // Retract the cursor so peers stop seeing it parked at the edge.
    this.collab.setCursor(null);
    this.hoveredId.set(null);
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();

    // ctrlKey is what a trackpad pinch reports, so this covers pinch-to-zoom and
    // Ctrl+wheel with one branch. A plain wheel pans, matching every other
    // canvas tool.
    if (event.ctrlKey || event.metaKey) {
      const anchor = this.toScreen(event);
      this.viewport.update((vp) => zoomAt(vp, anchor, vp.zoom * Math.exp(-event.deltaY * ZOOM_SENSITIVITY)));
      return;
    }

    this.viewport.update((vp) => panBy(vp, -event.deltaX, -event.deltaY));
  }

  // --- Drag-and-drop placement ---------------------------------------------
  //
  // A second path to the same `placeNode` the click-to-arm toolbar flow uses
  // (`onPointerDown` above): dragging a kind off the rail is the discoverable
  // way in, arming-then-clicking is the keyboard- and accessibility-reachable
  // fallback. HTML5 drag events are their own gesture sequence, dispatched
  // independently of the pointer events above, so the two never conflict.

  onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(NODE_DRAG_MIME)) return;
    // Required for the browser to permit a drop at all; omitting it silently
    // rejects every drop on this element.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  onDrop(event: DragEvent): void {
    const kind = event.dataTransfer?.getData(NODE_DRAG_MIME);
    if (!kind || !NODE_KINDS.includes(kind as NodeKind)) return;
    event.preventDefault();
    this.placeNode(kind as NodeKind, this.toWorld(event));
  }

  // --- Keyboard -----------------------------------------------------------

  private spaceHeld = false;

  onKeyDown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;

    if (event.key === 'Alt' || event.key === 'Meta') {
      this.connectModifierHeld.set(true);
    }

    if (event.code === 'Space') {
      this.spaceHeld = true;
      event.preventDefault();
      return;
    }

    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.collab.redo();
      else this.collab.undo();
      return;
    }

    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selection.set(new Set(this.collab.graph().nodes.map((n) => n.id)));
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      const ids = [...this.selection()];
      if (ids.length > 0) {
        this.collab.remove(ids);
        this.selection.set(new Set());
      }
      return;
    }

    if (event.key === 'Escape') {
      this.selection.set(new Set());
      this.placingKind.set(null);
      return;
    }

    const nudge = NUDGES[event.key];
    if (nudge) {
      event.preventDefault();
      // Shift nudges by a whole grid cell; the default is a single unit for
      // fine positioning.
      const step = event.shiftKey ? GRID : 1;
      this.nudgeSelection(nudge.dx * step, nudge.dy * step);
    }
  }

  onKeyUp(event: KeyboardEvent): void {
    if (event.code === 'Space') this.spaceHeld = false;
    if (event.key === 'Alt' || event.key === 'Meta') this.connectModifierHeld.set(false);
  }

  /**
   * Alt+Tab and similar OS-level switches steal focus without ever firing
   * keyup, so the held-modifier signal would otherwise stick on indefinitely.
   */
  onWindowBlur(): void {
    this.connectModifierHeld.set(false);
  }

  // --- Commands -----------------------------------------------------------

  /** `world` is where the node's centre should land, not its top-left corner. */
  placeNode(kind: NodeKind, world: Point): void {
    const x = snapToGrid(world.x - DEFAULT_NODE_SIZE.w / 2, GRID);
    const y = snapToGrid(world.y - DEFAULT_NODE_SIZE.h / 2, GRID);
    const node = createNode(kind, x, y);
    this.collab.addNode(node);
    this.selection.set(new Set([node.id]));
    this.placingKind.set(null);
  }

  /** Drop a node at the centre of the current view. Used by the toolbar. */
  placeNodeAtCentre(kind: NodeKind): void {
    const { width, height } = this.size();
    const centre = screenToWorld({ x: width / 2, y: height / 2 }, this.viewport());
    this.placeNode(kind, centre);
  }

  zoomToFit(): void {
    const { width, height } = this.size();
    const bounds = boundingBox(this.scene().nodes.map((n) => n.rect));
    if (!bounds || width === 0) return;
    this.viewport.set(fitToContent(bounds, width, height));
  }

  resetZoom(): void {
    this.viewport.update((vp) => zoomAt(vp, { x: this.size().width / 2, y: this.size().height / 2 }, 1));
  }

  /** Rounded zoom percentage, for the view-tools readout. */
  readonly zoomPercent = computed(() => Math.round(this.viewport().zoom * 100));

  /**
   * Step the zoom by a multiplicative factor, anchored on the canvas centre.
   *
   * Multiplicative rather than additive so repeated clicks feel consistent at
   * every zoom level: +25% of 400% is a much bigger jump than +25% of 50%,
   * which is exactly the mismatch a fixed-percent step would produce.
   */
  zoomStep(factor: number): void {
    const { width, height } = this.size();
    this.viewport.update((vp) => zoomAt(vp, { x: width / 2, y: height / 2 }, vp.zoom * factor));
  }

  /** Toolbar entry points, so the header does not need the service injected. */
  undoFromToolbar(): void {
    this.collab.undo();
  }

  redoFromToolbar(): void {
    this.collab.redo();
  }

  select(id: string): void {
    this.selection.set(new Set([id]));
  }

  /**
   * Centre on whatever a finding points at, and select it.
   *
   * Accepts either a node or an edge id, because findings cite both and the
   * caller should not have to know which it holds.
   */
  revealNode(id: string): void {
    const scene = this.scene();
    const { width, height } = this.size();
    if (width === 0) return;

    const node = scene.byNodeId.get(id);
    if (node) {
      this.viewport.set(fitToContent(node.rect, width, height, Math.min(width, height) / 3));
      this.selection.set(new Set([id]));
      return;
    }

    const edge = scene.edges.find((candidate) => candidate.edge.id === id);
    if (!edge) return;

    // Frame both endpoints, so the dependency is shown in context rather than
    // zoomed into an anonymous stretch of line.
    const source = scene.byNodeId.get(edge.edge.source);
    const target = scene.byNodeId.get(edge.edge.target);
    const bounds = boundingBox([source?.rect, target?.rect].filter((r) => r !== undefined));
    if (bounds) this.viewport.set(fitToContent(bounds, width, height, 120));

    this.selection.set(new Set([id]));
  }

  private nudgeSelection(dx: number, dy: number): void {
    const ids = this.selection();
    if (ids.size === 0) return;

    const moves = this.scene()
      .nodes.filter((n) => ids.has(n.node.id))
      .map((n) => ({ id: n.node.id, x: n.node.x + dx, y: n.node.y + dy }));

    if (moves.length > 0) this.collab.moveNodes(moves);
  }

  private applyClickSelection(id: string, additive: boolean): void {
    if (!additive) {
      // Clicking an already-selected node keeps the whole selection, so dragging
      // a group does not collapse it to the one node under the pointer.
      if (!this.selection().has(id)) this.selection.set(new Set([id]));
      return;
    }

    const next = new Set(this.selection());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selection.set(next);
  }

  private setGesture(gesture: Gesture | null): void {
    this.gesture = gesture;
    this.gestureVersion.update((v) => v + 1);
  }

  private capture(event: PointerEvent): void {
    try {
      this.hostRef().nativeElement.setPointerCapture(event.pointerId);
    } catch {
      // Some pointer types refuse capture; the gesture still works, it just
      // ends if the pointer leaves the element.
    }
  }
}

const NUDGES: Record<string, { dx: number; dy: number } | undefined> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};
