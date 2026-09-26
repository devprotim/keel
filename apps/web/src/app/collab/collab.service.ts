import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  applyEvidence,
  emptyGraph,
  hasUnapprovedChanges,
  validate,
  type ArchEdge,
  type ArchGraph,
  type ArchNode,
  type DesignIntent,
  type FieldDelta,
  type ObservationSet,
  type ValidationReport,
} from '@keel/shared';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { KEEL_CONFIG } from '../core/app-config';
import { GraphDoc } from './graph-doc';
import { loadDisplayName, readPeerState, saveDisplayName, type Peer } from './presence';

export type ConnectionStatus = 'connecting' | 'connected' | 'offline';

/**
 * The live document: network, presence, undo, and the signals the UI reads.
 *
 * All merge semantics live in GraphDoc, which is framework-free and separately
 * tested. This class is the wiring: it owns the providers, projects the document
 * into signals, and publishes presence.
 */
@Injectable({ providedIn: 'root' })
export class CollabService {
  readonly #config = inject(KEEL_CONFIG);

  readonly #doc = new GraphDoc();
  #provider: WebsocketProvider | null = null;
  #persistence: IndexeddbPersistence | null = null;
  #undoManager: Y.UndoManager | null = null;
  #stopObserving: (() => void) | null = null;

  readonly #graph = signal<ArchGraph>(emptyGraph());
  readonly #observations = signal<readonly ObservationSet[]>([]);
  readonly #intent = signal<DesignIntent>({});
  /**
   * Coarse wall clock for evidence freshness. Observations go stale with time
   * alone, with no edit to trigger revalidation, so the report needs a tick.
   */
  readonly #now = signal(Date.now());
  readonly #peers = signal<readonly Peer[]>([]);
  /** What the socket itself reports. */
  readonly #socketStatus = signal<'connected' | 'connecting' | 'disconnected'>('connecting');
  /** What the browser reports, which is a separate question. */
  readonly #browserOnline = signal(navigator.onLine);
  readonly #canUndo = signal(false);
  readonly #canRedo = signal(false);
  readonly #displayName = signal(loadDisplayName());
  readonly #avatarUrl = signal<string | null>(null);
  readonly #roomId = signal<string | null>(null);
  /** Diagrams waiting for their room to open, keyed by room id. See queueImport. */
  readonly #pendingImports = new Map<string, { graph: ArchGraph; intent: DesignIntent }>();
  readonly #importCount = signal(0);

  readonly graph = this.#graph.asReadonly();
  readonly observations = this.#observations.asReadonly();
  readonly intent = this.#intent.asReadonly();
  readonly hasBaseline = computed(() => Object.keys(this.#intent()).length > 0);
  readonly hasUnapprovedChanges = computed(() => hasUnapprovedChanges(this.#graph(), this.#intent()));
  readonly peers = this.#peers.asReadonly();
  /**
   * Connection state, derived from two independent signals.
   *
   * The socket alone is not enough. Chrome's DevTools offline toggle does not
   * reliably tear down an already-established WebSocket, so the provider can sit
   * there reporting "connected" long after the network is gone, and the header
   * cheerfully claims the session is live while nothing is reaching the server.
   * `navigator.onLine` catches exactly that case, and the socket catches the
   * cases the browser cannot see, such as the server going away.
   */
  readonly status = computed<ConnectionStatus>(() => {
    if (!this.#browserOnline()) return 'offline';
    switch (this.#socketStatus()) {
      case 'connected':
        return 'connected';
      case 'disconnected':
        return 'offline';
      default:
        return 'connecting';
    }
  });
  readonly canUndo = this.#canUndo.asReadonly();
  readonly canRedo = this.#canRedo.asReadonly();
  readonly displayName = this.#displayName.asReadonly();
  readonly avatarUrl = this.#avatarUrl.asReadonly();
  readonly roomId = this.#roomId.asReadonly();
  /** Bumps on every import, so the board can frame what just arrived. */
  readonly importCount = this.#importCount.asReadonly();

  /**
   * Deterministic validation, recomputed only when the graph actually changes.
   *
   * A computed signal rather than a call inside the render loop: validation walks
   * the whole graph, and doing that per frame while panning would be pure waste.
   */
  readonly report = computed<ValidationReport>(() =>
    validate(this.#graph(), { observations: this.#observations(), intent: this.#intent(), now: this.#now() }),
  );

  /**
   * The diagram as it runs: observed values laid over declared ones. This is
   * what the AI reviewer sees, so it critiques the real system, not the claim.
   */
  readonly effectiveGraph = computed<ArchGraph>(() => {
    const evidence = this.report().evidence;
    return evidence ? applyEvidence(this.#graph(), evidence) : this.#graph();
  });

  constructor() {
    const goOnline = (): void => this.#browserOnline.set(true);
    const goOffline = (): void => this.#browserOnline.set(false);
    globalThis.addEventListener('online', goOnline);
    globalThis.addEventListener('offline', goOffline);

    const clock = setInterval(() => this.#now.set(Date.now()), 60_000);

    inject(DestroyRef).onDestroy(() => {
      clearInterval(clock);
      globalThis.removeEventListener('online', goOnline);
      globalThis.removeEventListener('offline', goOffline);
      this.disconnect();
    });
  }

  /** Join a room. Safe to call again; the previous connection is torn down. */
  connect(roomId: string): void {
    if (this.#roomId() === roomId) return;
    this.disconnect();
    this.#roomId.set(roomId);

    // Local persistence first. It resolves from IndexedDB immediately, so a
    // reload paints the last known state instead of an empty canvas while the
    // socket is still negotiating.
    this.#persistence = new IndexeddbPersistence(`keel:${roomId}`, this.#doc.doc);

    this.#provider = new WebsocketProvider(this.#config.wsUrl, `ws/${roomId}`, this.#doc.doc, {
      connect: true,
    });

    // y-websocket reports 'connected', 'connecting' and 'disconnected'. Mapping
    // anything that is not 'connected' to 'connecting' was the original bug: a
    // dropped socket showed a permanent, reassuring "Connecting" instead of
    // admitting it was offline.
    this.#provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') this.#socketStatus.set('connected');
      else if (event.status === 'disconnected') this.#socketStatus.set('disconnected');
      else this.#socketStatus.set('connecting');
    });
    this.#provider.on('connection-close', () => this.#socketStatus.set('disconnected'));
    this.#provider.on('connection-error', () => this.#socketStatus.set('disconnected'));

    this.#provider.awareness.setLocalState({
      name: this.#displayName(),
      avatarUrl: this.#avatarUrl(),
      cursor: null,
      selection: [],
    });
    this.#provider.awareness.on('change', this.#syncPeers);

    this.#undoManager = this.#doc.createUndoManager();
    this.#undoManager.on('stack-item-added', this.#syncUndoState);
    this.#undoManager.on('stack-item-popped', this.#syncUndoState);

    this.#stopObserving = this.#doc.observe(this.#syncGraph);
    this.#syncGraph();

    const pending = this.#pendingImports.get(roomId);
    if (pending) {
      this.#pendingImports.delete(roomId);
      this.importDiagram(pending.graph, pending.intent);
    }
  }

  disconnect(): void {
    this.#stopObserving?.();
    this.#stopObserving = null;

    this.#undoManager?.destroy();
    this.#undoManager = null;

    if (this.#provider) {
      this.#provider.awareness.off('change', this.#syncPeers);
      // setLocalState(null) before destroy so peers retract this cursor
      // immediately rather than waiting for an awareness timeout.
      this.#provider.awareness.setLocalState(null);
      this.#provider.destroy();
      this.#provider = null;
    }

    void this.#persistence?.destroy();
    this.#persistence = null;
    this.#roomId.set(null);
    this.#peers.set([]);
    this.#socketStatus.set('connecting');
  }

  // --- Presence -----------------------------------------------------------

  setCursor(point: { x: number; y: number } | null): void {
    this.#patchAwareness({ cursor: point });
  }

  publishSelection(ids: readonly string[]): void {
    this.#patchAwareness({ selection: [...ids] });
  }

  setDisplayName(name: string): void {
    this.setIdentity(name, this.#avatarUrl());
  }

  /** Overwrites the generated guest name once a GitHub/Google sign-in resolves. */
  setIdentity(name: string, avatarUrl: string | null): void {
    const trimmed = name.trim() || 'Anonymous';
    this.#displayName.set(trimmed);
    this.#avatarUrl.set(avatarUrl);
    saveDisplayName(trimmed);
    this.#patchAwareness({ name: trimmed, avatarUrl });
  }

  // --- Mutations ----------------------------------------------------------

  addNode(node: ArchNode): void {
    this.#doc.addNode(node);
  }

  addEdge(edge: ArchEdge): void {
    this.#doc.addEdge(edge);
  }

  updateNode(id: string, patch: Partial<ArchNode>): void {
    this.#doc.updateNode(id, patch);
  }

  updateEdge(id: string, patch: Partial<ArchEdge>): void {
    this.#doc.updateEdge(id, patch);
  }

  moveNodes(moves: readonly { id: string; x: number; y: number }[]): void {
    this.#doc.moveNodes(moves);
  }

  remove(ids: readonly string[]): void {
    this.#doc.removeSelection(ids);
  }

  /** Add a diagram from a file to the current room, as one undo step. */
  importDiagram(graph: ArchGraph, intent: DesignIntent = {}): void {
    this.#doc.importDiagram(graph, intent);
    this.#importCount.update((n) => n + 1);
  }

  /**
   * Import into a room that is about to be opened.
   *
   * The landing page opens a file before any room exists, and the document
   * only exists once `connect` runs, so the diagram waits here until then.
   * Writing before the socket has synced is safe because the room id is new:
   * there is nothing on the server for the import to conflict with, and the
   * CRDT merges it upward either way.
   */
  queueImport(roomId: string, graph: ArchGraph, intent: DesignIntent = {}): void {
    this.#pendingImports.set(roomId, { graph, intent });
  }

  // --- Evidence and intent -----------------------------------------------

  importObservations(set: ObservationSet): void {
    this.#doc.setObservations(set);
    this.#now.set(Date.now());
  }

  removeObservations(source: string): void {
    this.#doc.removeObservations(source);
  }

  /** Approve these elements as they are drawn now, attributed to this user. */
  approve(ids: readonly string[]): void {
    this.#doc.approve(ids, this.#displayName());
  }

  approveAll(): void {
    this.#doc.approveAll(this.#displayName());
  }

  /** Update the diagram to what the running system reports, and approve it. */
  acceptObserved(deltas: readonly FieldDelta[]): void {
    this.#doc.acceptObserved(deltas, this.#displayName());
  }

  undo(): void {
    this.#undoManager?.undo();
  }

  redo(): void {
    this.#undoManager?.redo();
  }

  /**
   * Group several mutations into one undo step and one broadcast.
   *
   * Used by the toolbar's "add template" action, where a dozen nodes and edges
   * should be a single Ctrl+Z rather than a dozen.
   */
  batch(fn: () => void): void {
    this.#doc.transact(fn);
  }

  // --- Internal -----------------------------------------------------------

  readonly #syncGraph = (): void => {
    this.#graph.set(this.#doc.toGraph());
    this.#observations.set(this.#doc.toObservations());
    this.#intent.set(this.#doc.toIntent());
  };

  readonly #syncUndoState = (): void => {
    this.#canUndo.set(this.#undoManager?.canUndo() ?? false);
    this.#canRedo.set(this.#undoManager?.canRedo() ?? false);
  };

  readonly #syncPeers = (): void => {
    const awareness = this.#provider?.awareness;
    if (!awareness) return;

    const peers: Peer[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      // Skip ourselves; we never want to render our own cursor twice.
      if (clientId === awareness.clientID) continue;
      const peer = readPeerState(clientId, state);
      if (peer) peers.push(peer);
    }

    this.#peers.set(peers);
  };

  /**
   * Merge one field into local awareness.
   *
   * Awareness has no partial update: `setLocalState` replaces the whole object,
   * so writing only the cursor would wipe the name and selection. Reading the
   * current state and spreading it is what keeps the three independent.
   */
  #patchAwareness(
    patch: Partial<{ name: string; avatarUrl: string | null; cursor: { x: number; y: number } | null; selection: string[] }>,
  ): void {
    const awareness = this.#provider?.awareness;
    if (!awareness) return;

    const current = (awareness.getLocalState() ?? {}) as Record<string, unknown>;
    awareness.setLocalState({ ...current, ...patch });
  }
}
