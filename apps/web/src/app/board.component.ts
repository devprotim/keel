import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { EDGE_KINDS, NODE_KINDS, type EdgeKind, type NodeKind } from '@keel/shared';
import { AuthService } from './auth/auth.service';
import { CanvasComponent, NODE_DRAG_MIME } from './canvas/canvas.component';
import { CollabService } from './collab/collab.service';
import { presenceColor } from './core/theme';
import { exampleGraph } from './core/example-graph';
import { FindingsComponent } from './panels/findings.component';
import { InspectorComponent } from './panels/inspector.component';

/**
 * The board: one room, one diagram, chrome floating over a full-bleed canvas.
 *
 * Chrome used to be a fixed three-column frame (a toolbar header plus two
 * docked side panels) that permanently claimed most of the window for controls
 * that are idle most of the time. It is islands now — brand/room, presence,
 * the kind rail, view tools, the review dock and the inspector card all float
 * over the canvas and claim space only while they have something to say, so
 * the diagram — the actual product — gets the screen instead of the chrome
 * around it.
 */
@Component({
  selector: 'keel-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CanvasComponent, FindingsComponent, InspectorComponent],
  templateUrl: './board.component.html',
  styleUrl: './board.component.scss',
})
export class BoardComponent {
  protected readonly collab = inject(CollabService);
  protected readonly auth = inject(AuthService);

  /** Bound from the route by withComponentInputBinding. */
  readonly roomId = input.required<string>();

  private readonly canvasRef = viewChild.required(CanvasComponent);
  readonly nodeKinds = NODE_KINDS;
  readonly edgeKinds = EDGE_KINDS;

  readonly theme = signal<'light' | 'dark'>(readStoredTheme());
  readonly isEmpty = computed(() => this.collab.graph().nodes.length === 0);

  readonly statusLabel = computed(() => {
    switch (this.collab.status()) {
      case 'connected':
        return 'Live';
      case 'connecting':
        return 'Connecting';
      case 'offline':
        // Edits still work: IndexedDB holds them and the CRDT merges on
        // reconnect. Saying "offline" without that reassurance reads as failure.
        return 'Offline · edits saved';
    }
  });

  readonly peerLabel = computed(() => {
    const count = this.collab.peers().length;
    return count === 0 ? 'You are the only person here' : `${count + 1} people editing`;
  });

  /** Brief "Copied" confirmation after the room chip is clicked. */
  readonly roomIdCopied = signal(false);
  private copyResetHandle: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => this.collab.connect(this.roomId()));

    effect(() => {
      document.documentElement.setAttribute('data-theme', this.theme());
      try {
        localStorage.setItem('keel:theme', this.theme());
      } catch {
        // Storage unavailable; the choice simply will not persist.
      }
    });

    // Real identity overwrites the generated guest name/avatar once a session
    // resolves; a signed-out visitor is untouched and keeps the guest name.
    effect(() => {
      const user = this.auth.user();
      if (user) this.collab.setIdentity(user.name, user.avatarUrl);
    });

    void this.auth.refresh();

    inject(DestroyRef).onDestroy(() => {
      if (this.copyResetHandle !== null) clearTimeout(this.copyResetHandle);
    });
  }

  canvas(): CanvasComponent {
    return this.canvasRef();
  }

  toggleKind(kind: NodeKind): void {
    const canvas = this.canvas();
    canvas.placingKind.set(canvas.placingKind() === kind ? null : kind);
  }

  setEdgeKind(kind: EdgeKind): void {
    this.canvas().edgeKind.set(kind);
  }

  /**
   * Arm the rail tile for the whole drag, reusing `placingKind` — the same
   * signal the click-to-arm fallback uses. The two gesture systems (native
   * drag events here, pointer events on the canvas) never overlap, so one
   * piece of state can serve both without them stepping on each other.
   */
  onKindDragStart(event: DragEvent, kind: NodeKind): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(NODE_DRAG_MIME, kind);
    event.dataTransfer.effectAllowed = 'copy';
    this.canvas().placingKind.set(kind);
  }

  onKindDragEnd(): void {
    this.canvas().placingKind.set(null);
  }

  deselectAll(): void {
    this.canvas().selection.set(new Set());
  }

  async copyRoomLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(globalThis.location.href);
    } catch {
      // Clipboard access can be denied by permissions policy; the room id is
      // still visible in the chip and in the URL, so nothing is lost.
      return;
    }

    this.roomIdCopied.set(true);
    if (this.copyResetHandle !== null) clearTimeout(this.copyResetHandle);
    this.copyResetHandle = setTimeout(() => this.roomIdCopied.set(false), 1500);
  }

  kindColor(kind: NodeKind): string {
    return `var(--keel-kind-${kind})`;
  }

  peerColor(clientId: number): string {
    return presenceColor(clientId);
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('');
  }

  toggleTheme(): void {
    this.theme.update((current) => (current === 'dark' ? 'light' : 'dark'));
  }

  loginWithGithub(): void {
    this.auth.loginWithGithub(`/${this.roomId()}`);
  }

  loginWithGoogle(): void {
    this.auth.loginWithGoogle(`/${this.roomId()}`);
  }

  logout(): void {
    void this.auth.logout();
  }

  /** Seed the room, as one undo step so it can be cleared with a single Ctrl+Z. */
  loadExample(): void {
    const { nodes, edges } = exampleGraph();
    this.collab.batch(() => {
      for (const node of nodes) this.collab.addNode(node);
      for (const edge of edges) this.collab.addEdge(edge);
    });
    queueMicrotask(() => this.canvas().zoomToFit());
  }
}

function readStoredTheme(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem('keel:theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Fall through to the system preference.
  }
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
