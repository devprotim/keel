import {
  approveElement,
  diffObservationSets,
  eventsToDrop,
  readFindingLabel,
  readFindingRecord,
  readObservationEvent,
  readRuleSetting,
  type ApprovedField,
  readEdge,
  readElementIntent,
  readNode,
  readObservationSet,
  restoredElement,
  revertPatch,
  unapprovedFields,
  type ArchEdge,
  type ArchGraph,
  type ArchNode,
  type DesignIntent,
  type ElementIntent,
  type FieldDelta,
  type FindingHistory,
  type FindingLabel,
  type FindingLabels,
  type ObservationEvent,
  type ObservationSet,
  type RuleSetting,
  type RuleSettings,
} from '@keel/shared';
import * as Y from 'yjs';

/**
 * Typed access to the collaborative document.
 *
 * Deliberately free of Angular so it can be tested against real Yjs documents in
 * plain Node, including genuine concurrent-edit scenarios. The Angular service
 * wraps this and adds signals; none of the merge semantics live up there.
 *
 * ## Why each node is its own Y.Map
 *
 * Storing a node as a plain object in a single map would make the whole node the
 * unit of conflict: if Alice renames a box while Bob drags it, last write wins
 * and one of them silently loses their change. Nesting a Y.Map per node moves the
 * conflict boundary down to the individual field, so a rename and a move merge
 * cleanly because they touch different keys. That is the entire reason for the
 * extra indirection.
 */

/** Tags transactions this client originated, so undo can be scoped to them. */
export const LOCAL_ORIGIN = Symbol('keel:local-edit');

type YNode = Y.Map<unknown>;
type YEdge = Y.Map<unknown>;

export class GraphDoc {
  readonly doc: Y.Doc;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
  }

  get nodes(): Y.Map<YNode> {
    return this.doc.getMap<YNode>('nodes');
  }

  get edges(): Y.Map<YEdge> {
    return this.doc.getMap<YEdge>('edges');
  }

  /**
   * What the running system reports, one plain value per source.
   *
   * Stored whole rather than as nested maps: a push replaces a source's set
   * atomically (see the server's observations route), and nobody edits a
   * single observed field by hand, so there is no concurrent edit to merge.
   */
  get observations(): Y.Map<unknown> {
    return this.doc.getMap<unknown>('observations');
  }

  /** Per-room severity overrides and mutes, one plain value per rule id. See tuning.ts. */
  get ruleSettings(): Y.Map<unknown> {
    return this.doc.getMap<unknown>('ruleSettings');
  }

  /** Real-or-noise labels, one plain value per finding key. */
  get labels(): Y.Map<unknown> {
    return this.doc.getMap<unknown>('labels');
  }

  /** When each finding opened and resolved, one plain value per finding key. */
  get findingHistory(): Y.Map<unknown> {
    return this.doc.getMap<unknown>('findingHistory');
  }

  /** What each observations push changed, oldest first. See incident.ts. */
  get events(): Y.Array<unknown> {
    return this.doc.getArray<unknown>('events');
  }

  /**
   * The approved baseline. One nested map per element, one key per field, so
   * two people approving different components at once both land.
   */
  get intent(): Y.Map<Y.Map<unknown>> {
    return this.doc.getMap<Y.Map<unknown>>('intent');
  }

  /**
   * Run mutations in one transaction tagged as local.
   *
   * Grouping matters for undo as much as for efficiency: deleting a node and its
   * three attached edges must come back as one undo step, not four.
   */
  transact<T>(fn: () => T): T {
    return this.doc.transact(fn, LOCAL_ORIGIN);
  }

  /**
   * Undo scoped to this user's own edits.
   *
   * `trackedOrigins` is the important part. An UndoManager left at its default
   * would happily undo a *collaborator's* change, which is the single most
   * disorienting bug in a shared editor: you press Ctrl+Z and someone else's work
   * disappears. Restricting it to LOCAL_ORIGIN means each person's undo stack
   * contains only what they did.
   */
  createUndoManager(captureTimeout = 400): Y.UndoManager {
    // Intent is in scope so "accept the observed value", which edits a field
    // and approves it in one transaction, undoes as one step rather than
    // leaving an approval behind for a value that is gone.
    // Tuning is in scope too, so a finding marked noise by mistake is one Ctrl+Z
    // away. The finding history is not: it is bookkeeping, not an edit.
    return new Y.UndoManager([this.nodes, this.edges, this.intent, this.ruleSettings, this.labels], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      // Edits within this window coalesce into one undo step, so dragging a box
      // is one undo rather than one per animation frame. Tests pass 0 to get
      // each operation as its own step.
      captureTimeout,
      // Without this, undo is genuinely dangerous in a shared room.
      //
      // Yjs pops stack items until one produces a *visible* change. If a
      // collaborator has since overwritten the field you last edited, undoing
      // your edit changes nothing on screen, so Yjs silently moves on to your
      // previous item and undoes that instead. In practice one Ctrl+Z would
      // skip the move you meant to reverse and delete the node you had created
      // before it.
      //
      // Setting this makes an undo of a remotely-overwritten map key count as a
      // real change, so one Ctrl+Z reverses exactly one of your own actions.
      // The cost is that your undo reclaims a key a peer has since changed,
      // which is the lesser surprise by a wide margin.
      ignoreRemoteMapChanges: true,
    });
  }

  /** Snapshot the document as a plain graph. */
  toGraph(): ArchGraph {
    const nodes: ArchNode[] = [];
    for (const value of this.nodes.values()) {
      const node = readNode(value);
      if (node) nodes.push(node);
    }

    const edges: ArchEdge[] = [];
    for (const value of this.edges.values()) {
      const edge = readEdge(value);
      if (edge) edges.push(edge);
    }

    // Sorted so the projection is stable. Yjs map iteration order is an
    // implementation detail, and an unstable order would reshuffle draw order
    // (and therefore which overlapping node is on top) on unrelated edits.
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    edges.sort((a, b) => a.id.localeCompare(b.id));

    return { nodes, edges };
  }

  addNode(node: ArchNode): void {
    this.transact(() => {
      this.nodes.set(node.id, toYMap(node as unknown as Record<string, unknown>));
    });
  }

  addEdge(edge: ArchEdge): void {
    this.transact(() => {
      this.edges.set(edge.id, toYMap(edge as unknown as Record<string, unknown>));
    });
  }

  /** Apply a partial update. Keys set to undefined are removed. */
  updateNode(id: string, patch: Partial<ArchNode>): void {
    const target = this.nodes.get(id);
    if (!target) return;

    this.transact(() => {
      applyPatch(target, patch as Record<string, unknown>);
    });
  }

  updateEdge(id: string, patch: Partial<ArchEdge>): void {
    const target = this.edges.get(id);
    if (!target) return;

    this.transact(() => {
      applyPatch(target, patch as Record<string, unknown>);
    });
  }

  /**
   * Move several nodes at once.
   *
   * One transaction for the whole selection so a multi-node drag is a single
   * undo step and a single broadcast, rather than one of each per node.
   */
  moveNodes(moves: readonly { id: string; x: number; y: number }[]): void {
    this.transact(() => {
      for (const move of moves) {
        const target = this.nodes.get(move.id);
        if (!target) continue;
        target.set('x', move.x);
        target.set('y', move.y);
      }
    });
  }

  /**
   * Remove nodes and every edge touching them.
   *
   * Leaving the edges behind would strand them pointing at ids that no longer
   * exist. The renderer and validator both tolerate that, because it happens
   * transiently in a distributed edit, but it should never be the resting state
   * of the document.
   */
  removeNodes(ids: readonly string[]): void {
    const doomed = new Set(ids);

    this.transact(() => {
      for (const [edgeId, value] of this.edges.entries()) {
        const source = value.get('source');
        const target = value.get('target');
        if (typeof source === 'string' && doomed.has(source)) this.edges.delete(edgeId);
        else if (typeof target === 'string' && doomed.has(target)) this.edges.delete(edgeId);
      }
      for (const id of doomed) this.nodes.delete(id);
    });
  }

  removeEdges(ids: readonly string[]): void {
    this.transact(() => {
      for (const id of ids) this.edges.delete(id);
    });
  }

  /** Delete a mixed selection of nodes and edges in one step. */
  removeSelection(ids: readonly string[]): void {
    const nodeIds = ids.filter((id) => this.nodes.has(id));
    const edgeIds = ids.filter((id) => this.edges.has(id));

    this.transact(() => {
      if (edgeIds.length > 0) this.removeEdges(edgeIds);
      if (nodeIds.length > 0) this.removeNodes(nodeIds);
    });
  }

  // --- Evidence -------------------------------------------------------------

  /** Every well-formed observation set. Malformed ones are skipped, as with nodes. */
  toObservations(): ObservationSet[] {
    const sets: ObservationSet[] = [];
    for (const value of this.observations.values()) {
      const set = readObservationSet(value);
      if (set) sets.push(set);
    }
    return sets.sort((a, b) => a.source.localeCompare(b.source));
  }

  /**
   * Replace one source's observations and log what changed, exactly as the
   * server's ingest route does (apps/server collab/room-reader.ts).
   */
  setObservations(set: ObservationSet, now: number = Date.now()): void {
    this.transact(() => {
      const events = diffObservationSets(readObservationSet(this.observations.get(set.source)), set);
      this.observations.set(set.source, JSON.parse(JSON.stringify(set)) as unknown);
      if (events.length > 0) this.events.push(events);
      const drop = eventsToDrop(this.events.toArray(), now);
      if (drop > 0) this.events.delete(0, drop);
    });
  }

  /**
   * The event log, skipping anything malformed.
   *
   * Cached until the log itself changes: every edit (each frame of a drag)
   * notifies the same observer, and re-reading 500 events per frame for a log
   * that did not move would be pure waste. Entries are never edited in place,
   * only appended and trimmed from the front, so length and ends identify it.
   */
  toEvents(): readonly ObservationEvent[] {
    const raw = this.events.toArray();
    const key = [raw.length, raw[0], raw[raw.length - 1]] as const;
    const cached = this.#eventsCache;
    if (cached && cached.key[0] === key[0] && cached.key[1] === key[1] && cached.key[2] === key[2]) return cached.events;

    const events: ObservationEvent[] = [];
    for (const value of raw) {
      const event = readObservationEvent(value);
      if (event) events.push(event);
    }
    this.#eventsCache = { key, events };
    return events;
  }

  #eventsCache: { key: readonly [number, unknown, unknown]; events: readonly ObservationEvent[] } | null = null;

  removeObservations(source: string): void {
    this.transact(() => {
      this.observations.delete(source);
    });
  }

  // --- Tuning -----------------------------------------------------------------

  toRuleSettings(): RuleSettings {
    const settings: RuleSettings = {};
    for (const [id, value] of this.ruleSettings.entries()) {
      const setting = readRuleSetting(value);
      if (setting) settings[id] = setting;
    }
    return settings;
  }

  /** Set or clear one rule's setting. An empty setting clears it. */
  setRuleSetting(ruleId: string, setting: RuleSetting): void {
    this.transact(() => {
      if (!setting.severity && !setting.muted) this.ruleSettings.delete(ruleId);
      else this.ruleSettings.set(ruleId, { ...setting });
    });
  }

  toLabels(): FindingLabels {
    const labels: FindingLabels = {};
    for (const [key, value] of this.labels.entries()) {
      const label = readFindingLabel(value);
      if (label) labels[key] = label;
    }
    return labels;
  }

  /** Label a finding real or noise, or clear its label with null. */
  setLabel(key: string, label: FindingLabel | null): void {
    this.transact(() => {
      if (label) this.labels.set(key, { ...label });
      else this.labels.delete(key);
    });
  }

  toFindingHistory(): FindingHistory {
    const history: FindingHistory = {};
    for (const [key, value] of this.findingHistory.entries()) {
      const record = readFindingRecord(value);
      if (record) history[key] = record;
    }
    return history;
  }

  /**
   * Apply a `reconcileHistory` result. Not tagged local: it is bookkeeping every
   * client does, never an edit of this user's to undo.
   */
  writeFindingHistory({ set, drop }: { set: FindingHistory; drop: readonly string[] }): void {
    this.doc.transact(() => {
      for (const [key, record] of Object.entries(set)) this.findingHistory.set(key, { ...record });
      for (const key of drop) this.findingHistory.delete(key);
    });
  }

  // --- Intent ---------------------------------------------------------------

  toIntent(): DesignIntent {
    const intent: DesignIntent = {};
    for (const [id, value] of this.intent.entries()) {
      const element = readIntent(value);
      if (element) intent[id] = element;
    }
    return intent;
  }

  /**
   * Record the current values of these elements as approved.
   *
   * An id that is no longer on the diagram approves its removal, which drops
   * it from the baseline.
   */
  approve(
    ids: readonly string[],
    by: string,
    at: string = new Date().toISOString(),
    fields?: readonly string[],
  ): void {
    const graph = this.toGraph();
    const intent = this.toIntent();
    const edgeLabel = edgeLabeller(graph);
    const present = new Set([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id)]);

    this.transact(() => {
      for (const id of ids) {
        const node = graph.nodes.find((n) => n.id === id);
        const edge = node ? undefined : graph.edges.find((e) => e.id === id);
        if (!node && !edge) {
          this.intent.delete(id);
          // Deleting a node took its edges with it; approving the one approves
          // the other, or the edges would linger as removals of nothing.
          if (intent[id]?.kind === 'node') {
            for (const [edgeId, approved] of Object.entries(intent)) {
              if (approved.kind !== 'edge' || present.has(edgeId)) continue;
              const ends = [approved.fields['source']?.value, approved.fields['target']?.value];
              if (ends.includes(id)) this.intent.delete(edgeId);
            }
          }
          continue;
        }

        const options = { by, at, ...(fields ? { fields } : {}) };
        const next = node
          ? approveElement(node, 'node', intent[id], options)
          : approveElement(edge!, 'edge', intent[id], { ...options, label: edgeLabel(edge!) });
        this.#writeIntent(id, next);
      }
    });
  }

  /**
   * Put these elements back to what was approved, the reverse of `approve`.
   *
   * - A changed element has the given fields (default: every unapproved one)
   *   set back to their approved values.
   * - An element that was never approved is deleted.
   * - An approved element that was deleted is rebuilt from its approval. A
   *   node brings back its removed edges whose other end is still there,
   *   since deleting the node took them; an edge brings back removed ends.
   *
   * One transaction, so a rejection is one undo step. The baseline itself is
   * never touched: rejecting is an edit to the diagram, not an approval.
   */
  reject(targets: readonly { id: string; fields?: readonly string[] }[]): void {
    const intent = this.toIntent();

    this.transact(() => {
      const restore = (id: string): void => {
        if (this.nodes.has(id) || this.edges.has(id)) return;
        const approved = intent[id];
        const element = approved ? restoredElement(id, approved) : null;
        if (!approved || !element) return;
        if (approved.kind === 'edge') {
          const edge = element as ArchEdge;
          for (const end of [edge.source, edge.target]) {
            if (!this.nodes.has(end) && intent[end]?.kind === 'node') restore(end);
          }
          if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) return;
          this.edges.set(id, toYMap(edge as unknown as Record<string, unknown>));
          return;
        }
        this.nodes.set(id, toYMap(element as unknown as Record<string, unknown>));
      };

      const restoredNodes: string[] = [];
      for (const { id, fields } of targets) {
        const target = this.nodes.get(id) ?? this.edges.get(id);
        const approved = intent[id];

        if (target && !approved) {
          if (this.nodes.has(id)) this.removeNodes([id]);
          else this.edges.delete(id);
        } else if (target && approved) {
          const element = this.nodes.has(id) ? readNode(target) : readEdge(target);
          if (!element) continue;
          const patch = revertPatch(approved, fields ?? unapprovedFields(element, approved));
          for (const end of ['source', 'target'] as const) {
            // Never point an edge at a component that is not there.
            if (typeof patch[end] === 'string' && !this.nodes.has(patch[end])) delete patch[end];
          }
          applyPatch(target, patch);
        } else if (!target && approved) {
          restore(id);
          if (approved.kind === 'node') restoredNodes.push(id);
        }
      }

      for (const nodeId of restoredNodes) {
        for (const [edgeId, approved] of Object.entries(intent)) {
          if (approved.kind !== 'edge' || this.edges.has(edgeId)) continue;
          const source = approved.fields['source']?.value;
          const target = approved.fields['target']?.value;
          if (source !== nodeId && target !== nodeId) continue;
          if (typeof source === 'string' && typeof target === 'string' && this.nodes.has(source) && this.nodes.has(target)) {
            restore(edgeId);
          }
        }
      }
    });
  }

  /**
   * Add a whole diagram, and its approved baseline, as one change.
   *
   * One transaction, so it is one undo step and one broadcast, exactly like
   * loading the example. Ids are kept as they are in the file: the baseline is
   * keyed by them, and a room id already scopes them, so the same file opened
   * in two rooms cannot collide.
   */
  importDiagram(graph: ArchGraph, intent: DesignIntent = {}): void {
    this.transact(() => {
      for (const node of graph.nodes) this.nodes.set(node.id, toYMap(node as unknown as Record<string, unknown>));
      for (const edge of graph.edges) this.edges.set(edge.id, toYMap(edge as unknown as Record<string, unknown>));
      for (const [id, element] of Object.entries(intent)) this.#writeIntent(id, element);
    });
  }

  /** Approve the whole diagram as it stands, including any removals. */
  approveAll(by: string, at?: string): void {
    const graph = this.toGraph();
    const ids = new Set([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id), ...this.intent.keys()]);
    this.approve([...ids], by, at);
  }

  /**
   * Make the diagram say what the running system does, and approve that.
   *
   * Accepting reality is a decision, not an edit, so the new value goes into
   * the baseline at the same time. Otherwise the fix for drift would
   * immediately reappear as an unapproved change.
   */
  acceptObserved(deltas: readonly FieldDelta[], by: string, at: string = new Date().toISOString()): void {
    const intent = this.toIntent();
    const edgeLabel = edgeLabeller(this.toGraph());

    this.transact(() => {
      const byElement = new Map<string, FieldDelta[]>();
      for (const delta of deltas) {
        if (!('observed' in delta)) continue;
        byElement.set(delta.elementId, [...(byElement.get(delta.elementId) ?? []), delta]);
      }

      for (const [id, fields] of byElement) {
        const target = this.nodes.get(id) ?? this.edges.get(id);
        if (!target) continue;
        const patch: Record<string, unknown> = {};
        for (const delta of fields) patch[delta.field] = toDeclared(delta.observed ?? null);
        applyPatch(target, patch);

        const options = { by, at, fields: fields.map((d) => d.field) };
        const node = this.nodes.has(id) ? readNode(target) : null;
        const edge = node ? null : readEdge(target);
        if (node) this.#writeIntent(id, approveElement(node, 'node', intent[id], options));
        else if (edge) this.#writeIntent(id, approveElement(edge, 'edge', intent[id], { ...options, label: edgeLabel(edge) }));
      }
    });
  }

  #writeIntent(id: string, next: ElementIntent): void {
    let target = this.intent.get(id);
    if (!target) {
      target = new Y.Map<unknown>();
      this.intent.set(id, target);
    }
    if (target.get('_kind') !== next.kind) target.set('_kind', next.kind);
    if (target.get('_label') !== next.label) target.set('_label', next.label);
    // Presentation, so last approval wins; a whole plain value, not merged per key.
    if (next.layout && JSON.stringify(target.get('_layout')) !== JSON.stringify(next.layout)) {
      target.set('_layout', { ...next.layout });
    }
    for (const [field, approved] of Object.entries(next.fields)) {
      const current = target.get(field) as ApprovedField | undefined;
      // Unchanged approvals are not rewritten, so re-approving an element does
      // not clobber a field a peer approved a moment ago with the same value.
      if (current && current.value === approved.value && current.at === approved.at) continue;
      target.set(field, { ...approved });
    }
  }

  /** Subscribe to any change, local or remote. Returns an unsubscribe function. */
  observe(listener: () => void): () => void {
    const handler = (): void => listener();
    this.nodes.observeDeep(handler);
    this.edges.observeDeep(handler);
    this.observations.observeDeep(handler);
    this.intent.observeDeep(handler);
    this.events.observe(handler);
    this.ruleSettings.observe(handler);
    this.labels.observe(handler);
    this.findingHistory.observe(handler);

    return () => {
      this.nodes.unobserveDeep(handler);
      this.edges.unobserveDeep(handler);
      this.observations.unobserveDeep(handler);
      this.intent.unobserveDeep(handler);
      this.events.unobserve(handler);
      this.ruleSettings.unobserve(handler);
      this.labels.unobserve(handler);
      this.findingHistory.unobserve(handler);
    };
  }
}

function toYMap(source: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

function applyPatch(target: Y.Map<unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    // Undefined means "clear this property", which is how the inspector removes
    // an optional field such as a timeout. Setting undefined into a Y.Map would
    // store a null-ish value that then reads back as present.
    if (value === undefined) target.delete(key);
    else target.set(key, value);
  }
}

/**
 * An observed value in the shape the diagram declares it.
 *
 * The reverse of `normalizeField`: an observed "no timeout" is stored as an
 * absent key, and a false checkbox is cleared rather than stored as false,
 * matching what the inspector writes.
 */
function toDeclared(value: string | number | boolean | null): unknown {
  if (value === null || value === false) return undefined;
  return value;
}

/** Edges have no label of their own worth remembering; name them by their ends. */
function edgeLabeller(graph: ArchGraph): (edge: ArchEdge) => string {
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  return (edge) => `${labels.get(edge.source) ?? edge.source} to ${labels.get(edge.target) ?? edge.target}`;
}

function readIntent(value: unknown): ElementIntent | null {
  return value instanceof Y.Map ? readElementIntent(value) : null;
}

