import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  applyEvidence,
  buildTimeline,
  emptyGraph,
  findingKey,
  hasUnapprovedChanges,
  incidentView,
  reconcileHistory,
  ruleStats,
  suggestNodes,
  reviewChanges,
  validate,
  type ArchEdge,
  type ArchGraph,
  type ArchNode,
  type DesignIntent,
  type FieldDelta,
  type Finding,
  type FindingHistory,
  type FindingLabels,
  type IncidentView,
  type NodeSuggestion,
  type RuleSetting,
  type RuleSettings,
  type RuleStats,
  type Verdict,
  type ObservationEvent,
  type ObservationSet,
  type ReviewChange,
  type TimelineEntry,
  type ValidationReport,
} from '@keel/shared';
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { KEEL_CONFIG } from '../core/app-config';
import { GraphDoc } from './graph-doc';
import { loadDisplayName, readPeerState, saveDisplayName, type Peer } from './presence';

export type ConnectionStatus = 'connecting' | 'connected' | 'offline' | 'refused';

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

  /**
   * One document per connection, never reused. A doc kept across rooms would
   * carry room A's diagram into room B on the next connect, where the CRDT
   * would merge it in and sync it to B's server.
   */
  #doc = new GraphDoc();
  #provider: WebsocketProvider | null = null;
  #persistence: IndexeddbPersistence | null = null;
  #undoManager: Y.UndoManager | null = null;
  #stopObserving: (() => void) | null = null;

  readonly #graph = signal<ArchGraph>(emptyGraph());
  readonly #observations = signal<readonly ObservationSet[]>([]);
  readonly #intent = signal<DesignIntent>({});
  readonly #events = signal<readonly ObservationEvent[]>([]);
  readonly #ruleSettings = signal<RuleSettings>({});
  readonly #labels = signal<FindingLabels>({});
  readonly #findingHistory = signal<FindingHistory>({});
  /** The socket's first sync has landed, so the document is the room's, not a partial copy. */
  readonly #synced = signal(false);
  /**
   * Coarse wall clock for evidence freshness. Observations go stale with time
   * alone, with no edit to trigger revalidation, so the report needs a tick.
   */
  readonly #now = signal(Date.now());
  readonly #peers = signal<readonly Peer[]>([]);
  /** What the socket itself reports. */
  readonly #socketStatus = signal<'connected' | 'connecting' | 'disconnected'>('connecting');
  /**
   * Why the server last closed the socket on purpose, if it did. The provider
   * reconnects regardless, and the next sync is refused the same way, so
   * without this the header would flicker "Connecting" with no explanation.
   */
  readonly #refusal = signal<string | null>(null);
  /** Viewers of a workspace room. The server drops their writes; this keeps the UI from making any. */
  readonly #readOnly = signal(false);
  /** Bumps when the server closes the socket because who may open the room changed. */
  readonly #accessChecks = signal(0);
  /**
   * The server refused this room outright. Decisive on its own, so a private
   * or deleted room is shut even when the HTTP access check can't be reached.
   */
  readonly #closedBy = signal<'forbidden' | 'deleted' | 'missing' | null>(null);
  /** What the browser reports, which is a separate question. */
  readonly #browserOnline = signal(navigator.onLine);
  readonly #canUndo = signal(false);
  readonly #canRedo = signal(false);
  readonly #displayName = signal(loadDisplayName());
  readonly #avatarUrl = signal<string | null>(null);
  readonly #roomId = signal<string | null>(null);
  /** Diagrams waiting for their room to open, keyed by room id. See queueImport. */
  readonly #pendingImports = new Map<
    string,
    { graph: ArchGraph; intent: DesignIntent; observations: readonly ObservationSet[] }
  >();
  readonly #importCount = signal(0);

  readonly graph = this.#graph.asReadonly();
  readonly observations = this.#observations.asReadonly();
  readonly intent = this.#intent.asReadonly();
  readonly hasBaseline = computed(() => Object.keys(this.#intent()).length > 0);
  readonly hasUnapprovedChanges = computed(() => hasUnapprovedChanges(this.#graph(), this.#intent()));
  /** The diagram's changes since approval, field by field. Empty with no baseline. */
  readonly changes = computed<readonly ReviewChange[]>(() => reviewChanges(this.#graph(), this.#intent()));
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
    if (this.#refusal() !== null) return 'refused';
    switch (this.#socketStatus()) {
      case 'connected':
        return 'connected';
      case 'disconnected':
        return 'offline';
      default:
        return 'connecting';
    }
  });
  readonly refusal = this.#refusal.asReadonly();
  readonly readOnly = this.#readOnly.asReadonly();
  readonly accessChecks = this.#accessChecks.asReadonly();
  readonly closedBy = this.#closedBy.asReadonly();
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
    validate(this.#graph(), {
      observations: this.#observations(),
      intent: this.#intent(),
      now: this.#now(),
      ruleSettings: this.#ruleSettings(),
      labels: this.#labels(),
    }),
  );

  readonly ruleSettings = this.#ruleSettings.asReadonly();
  readonly labels = this.#labels.asReadonly();

  /** Per rule: how often it fires, how people labelled it, how long its findings stay open. */
  readonly ruleStats = computed<readonly RuleStats[]>(() =>
    ruleStats(
      [...this.report().findings, ...this.report().dismissed],
      this.#labels(),
      this.#findingHistory(),
      this.#ruleSettings(),
      { now: this.#now() },
    ),
  );

  /** What to do about names the running system reports that no box carries. */
  readonly nodeSuggestions = computed<readonly NodeSuggestion[]>(() =>
    suggestNodes(this.#graph(), this.report().evidence),
  );

  /**
   * The diagram as it runs: observed values laid over declared ones. This is
   * what the AI reviewer sees, so it critiques the real system, not the claim.
   */
  readonly effectiveGraph = computed<ArchGraph>(() => {
    const evidence = this.report().evidence;
    return evidence ? applyEvidence(this.#graph(), evidence) : this.#graph();
  });

  /** Incident mode: health per element and where to look first. */
  readonly incident = computed<IncidentView>(() => incidentView(this.#graph(), this.report().evidence ?? null));

  /** Incident mode: what the running system and the approved design did in the last day. */
  readonly timeline = computed<readonly TimelineEntry[]>(() =>
    buildTimeline(this.#graph(), this.#events(), this.#intent(), { now: this.#now() }),
  );

  constructor() {
    const goOnline = (): void => this.#browserOnline.set(true);
    const goOffline = (): void => this.#browserOnline.set(false);
    globalThis.addEventListener('online', goOnline);
    globalThis.addEventListener('offline', goOffline);

    const clock = setInterval(() => this.#now.set(Date.now()), 60_000);

    // Keep the room's finding history in step with what fires. Debounced so a
    // finding that flickers while someone types a number is not an occurrence,
    // and only once synced, so a half-loaded document does not "resolve"
    // everything. Every client does this; the writes are idempotent, so two
    // open canvases agree rather than fight.
    let reconcile: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const report = this.report();
      if (!this.#synced() || this.#readOnly()) return;
      const firing = [...report.findings, ...report.dismissed];
      if (reconcile) clearTimeout(reconcile);
      reconcile = setTimeout(() => {
        reconcile = null;
        const change = reconcileHistory(untracked(this.#findingHistory), firing, Date.now());
        if (Object.keys(change.set).length > 0 || change.drop.length > 0) this.#doc.writeFindingHistory(change);
      }, 2000);
    });

    inject(DestroyRef).onDestroy(() => {
      clearInterval(clock);
      if (reconcile) clearTimeout(reconcile);
      globalThis.removeEventListener('online', goOnline);
      globalThis.removeEventListener('offline', goOffline);
      this.disconnect();
    });
  }

  /** Join a room. Safe to call again; the previous connection is torn down. */
  connect(roomId: string): void {
    if (this.#roomId() === roomId) {
      // Refused earlier and since allowed again (e.g. just added as a member).
      if (this.#closedBy() === null) this.#provider?.connect();
      return;
    }
    this.disconnect();
    this.#doc = new GraphDoc();
    // Kept through disconnect() (forgetting a refused room disconnects it),
    // cleared only on arriving somewhere else.
    this.#closedBy.set(null);
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
    this.#provider.on('connection-close', (event: CloseEvent | null) => {
      this.#socketStatus.set('disconnected');
      const refusal = describeRefusal(event?.code);
      if (refusal) this.#refusal.set(refusal);
      const closedBy = closeReason(event?.code);
      if (closedBy) {
        // Retrying would only be refused again, over and over.
        this.#provider?.disconnect();
        this.#closedBy.set(closedBy);
      }
      if (event?.code === CLOSE_ACCESS_CHANGED || closedBy) {
        this.#accessChecks.update((n) => n + 1);
      }
    });
    this.#provider.on('sync', (synced: boolean) => {
      if (synced) this.#refusal.set(null);
      if (synced) this.#synced.set(true);
    });
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
      for (const set of pending.observations) this.importObservations(set);
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
    // Nothing of the room stays on screen once it is left, which matters most
    // when it is left because it became private or was deleted.
    this.#graph.set({ nodes: [], edges: [] });
    this.#observations.set([]);
    this.#intent.set({});
    this.#events.set([]);
    this.#ruleSettings.set({});
    this.#labels.set({});
    this.#findingHistory.set({});
    this.#synced.set(false);
    this.#peers.set([]);
    this.#socketStatus.set('connecting');
    this.#refusal.set(null);
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

  /** Ask the board to re-read this room's access, e.g. after the Share menu changed it. */
  recheckAccess(): void {
    this.#accessChecks.update((n) => n + 1);
  }

  setReadOnly(readOnly: boolean): void {
    this.#readOnly.set(readOnly);
  }

  /** Drop this browser's offline copy of a room it can no longer open. */
  async forgetLocal(roomId: string): Promise<void> {
    if (this.#roomId() === roomId) this.disconnect();
    await clearDocument(`keel:${roomId}`);
  }

  // --- Mutations ----------------------------------------------------------

  addNode(node: ArchNode): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.addNode(node));
  }

  addEdge(edge: ArchEdge): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.addEdge(edge));
  }

  updateNode(id: string, patch: Partial<ArchNode>): void {
    if (this.#readOnly()) return;
    this.#doc.updateNode(id, patch);
  }

  updateEdge(id: string, patch: Partial<ArchEdge>): void {
    if (this.#readOnly()) return;
    this.#doc.updateEdge(id, patch);
  }

  moveNodes(moves: readonly { id: string; x: number; y: number }[]): void {
    if (this.#readOnly()) return;
    this.#doc.moveNodes(moves);
  }

  remove(ids: readonly string[]): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.removeSelection(ids));
  }

  /** Add a diagram from a file to the current room, as one undo step. */
  importDiagram(graph: ArchGraph, intent: DesignIntent = {}): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.importDiagram(graph, intent));
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
  queueImport(
    roomId: string,
    graph: ArchGraph,
    intent: DesignIntent = {},
    observations: readonly ObservationSet[] = [],
  ): void {
    this.#pendingImports.set(roomId, { graph, intent, observations });
  }

  // --- Evidence and intent -----------------------------------------------

  importObservations(set: ObservationSet): void {
    if (this.#readOnly()) return;
    this.#doc.setObservations(set);
    this.#now.set(Date.now());
  }

  removeObservations(source: string): void {
    if (this.#readOnly()) return;
    this.#doc.removeObservations(source);
  }

  /** Approve these elements as they are drawn now, attributed to this user. */
  approve(ids: readonly string[]): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.approve(ids, this.#displayName()));
  }

  /** Approve only these fields of one element, as review mode does per field. */
  approveFields(id: string, fields: readonly string[]): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.approve([id], this.#displayName(), undefined, fields));
  }

  /** Put elements (or some of their fields) back to what was approved. See GraphDoc.reject. */
  reject(targets: readonly { id: string; fields?: readonly string[] }[]): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.reject(targets));
  }

  approveAll(): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.approveAll(this.#displayName()));
  }

  /** Update the diagram to what the running system reports, and approve it. */
  acceptObserved(deltas: readonly FieldDelta[]): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.acceptObserved(deltas, this.#displayName()));
  }

  // --- Tuning ---------------------------------------------------------------

  setRuleSetting(ruleId: string, setting: RuleSetting): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.setRuleSetting(ruleId, setting));
  }

  /** Mark a finding real or noise. Marking it with the verdict it already has clears it. */
  label(finding: Finding, verdict: Verdict): void {
    if (this.#readOnly()) return;
    const key = findingKey(finding);
    const current = this.#labels()[key];
    this.#step(() =>
      this.#doc.setLabel(
        key,
        current?.verdict === verdict ? null : { verdict, ruleId: finding.ruleId, by: this.#displayName(), at: new Date().toISOString() },
      ),
    );
  }

  /** Take a finding's label off, bringing a dismissed one back. */
  clearLabel(finding: Finding): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.setLabel(findingKey(finding), null));
  }

  undo(): void {
    if (this.#readOnly()) return;
    this.#undoManager?.undo();
  }

  redo(): void {
    if (this.#readOnly()) return;
    this.#undoManager?.redo();
  }

  /**
   * Group several mutations into one undo step and one broadcast.
   *
   * Used by the toolbar's "add template" action, where a dozen nodes and edges
   * should be a single Ctrl+Z rather than a dozen.
   */
  batch(fn: () => void): void {
    if (this.#readOnly()) return;
    this.#step(() => this.#doc.transact(fn));
  }

  // --- Internal -----------------------------------------------------------

  /**
   * Run a discrete action as exactly one undo step.
   *
   * The capture window exists so continuous input (a drag, typing a name)
   * coalesces. Without closing it around discrete actions, whether "place a
   * box, then rename it" is one Ctrl+Z or two came down to whether the rename
   * began within 400ms, which is timing, not intent.
   */
  #step(fn: () => void): void {
    this.#undoManager?.stopCapturing();
    fn();
    this.#undoManager?.stopCapturing();
  }

  readonly #syncGraph = (): void => {
    this.#graph.set(this.#doc.toGraph());
    this.#observations.set(this.#doc.toObservations());
    this.#intent.set(this.#doc.toIntent());
    // Same array when the log did not change, so the signal does not fire.
    this.#events.set(this.#doc.toEvents());
    this.#ruleSettings.set(this.#doc.toRuleSettings());
    this.#labels.set(this.#doc.toLabels());
    this.#findingHistory.set(this.#doc.toFindingHistory());
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

/**
 * The server's deliberate close codes (apps/server: Room and the socket
 * route), in words. Anything else is an ordinary disconnect.
 */
function describeRefusal(code: number | undefined): string | null {
  if (code === 1009) return $localize`:Connection status when the server closed the socket because the room is over its size limit:Not syncing · diagram too large`;
  if (code === 1008) return $localize`:Connection status when the server closed the socket for sending too many messages:Not syncing · refused by server`;
  return null;
}

/** Must match apps/server/src/access/policy.ts. */
const CLOSE_ACCESS_CHANGED = 4001;
const CLOSE_FORBIDDEN = 4003;
const CLOSE_DELETED = 4004;
const CLOSE_NOT_FOUND = 4005;

/** The close codes that refuse the room for good, as what `closedBy` reports. */
function closeReason(code: number | undefined): 'forbidden' | 'deleted' | 'missing' | null {
  if (code === CLOSE_FORBIDDEN) return 'forbidden';
  if (code === CLOSE_DELETED) return 'deleted';
  if (code === CLOSE_NOT_FOUND) return 'missing';
  return null;
}
