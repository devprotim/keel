import {
  approveElement,
  intentFieldsFor,
  type ApprovedField,
  type ArchEdge,
  type ArchGraph,
  type ArchNode,
  type DesignIntent,
  type EdgeKind,
  type EdgeObservation,
  type ElementIntent,
  type FieldDelta,
  type NodeKind,
  type NodeObservation,
  type ObservationSet,
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
    return new Y.UndoManager([this.nodes, this.edges, this.intent], {
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

  /** Replace one source's observations, as the server's ingest route does. */
  setObservations(set: ObservationSet): void {
    this.transact(() => {
      this.observations.set(set.source, JSON.parse(JSON.stringify(set)) as unknown);
    });
  }

  removeObservations(source: string): void {
    this.transact(() => {
      this.observations.delete(source);
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
  approve(ids: readonly string[], by: string, at: string = new Date().toISOString()): void {
    const graph = this.toGraph();
    const intent = this.toIntent();
    const edgeLabel = edgeLabeller(graph);

    this.transact(() => {
      for (const id of ids) {
        const node = graph.nodes.find((n) => n.id === id);
        const edge = node ? undefined : graph.edges.find((e) => e.id === id);
        if (!node && !edge) {
          this.intent.delete(id);
          continue;
        }

        const next = node
          ? approveElement(node, 'node', intent[id], { by, at })
          : approveElement(edge!, 'edge', intent[id], { by, at, label: edgeLabel(edge!) });
        this.#writeIntent(id, next);
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

    return () => {
      this.nodes.unobserveDeep(handler);
      this.edges.unobserveDeep(handler);
      this.observations.unobserveDeep(handler);
      this.intent.unobserveDeep(handler);
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

const NODE_KINDS = new Set<string>([
  'service',
  'datastore',
  'queue',
  'cache',
  'gateway',
  'job',
  'external',
]);
const EDGE_KINDS = new Set<string>(['sync', 'async', 'stream']);

/**
 * Read a node back out of the document, rejecting anything malformed.
 *
 * The document is shared and long-lived: it can contain data written by an older
 * version of the app, or by a peer running a different build. Validating on read
 * means a single bad record is skipped rather than crashing the canvas for
 * everyone in the room.
 */
function readNode(value: YNode): ArchNode | null {
  const id = str(value.get('id'));
  const kind = str(value.get('kind'));
  if (!id || !kind || !NODE_KINDS.has(kind)) return null;

  const node: ArchNode = {
    id,
    kind: kind as NodeKind,
    label: str(value.get('label')) ?? 'Untitled',
    x: num(value.get('x')) ?? 0,
    y: num(value.get('y')) ?? 0,
    w: num(value.get('w')) ?? 180,
    h: num(value.get('h')) ?? 80,
    replicas: num(value.get('replicas')) ?? 1,
  };

  const tech = str(value.get('tech'));
  if (tech !== null) node.tech = tech;
  const notes = str(value.get('notes'));
  if (notes !== null) node.notes = notes;
  const critical = bool(value.get('critical'));
  if (critical !== null) node.critical = critical;
  const hasReplica = bool(value.get('hasReplica'));
  if (hasReplica !== null) node.hasReplica = hasReplica;
  const hasBackup = bool(value.get('hasBackup'));
  if (hasBackup !== null) node.hasBackup = hasBackup;
  const hasDlq = bool(value.get('hasDlq'));
  if (hasDlq !== null) node.hasDlq = hasDlq;
  const ref = str(value.get('ref'));
  if (ref !== null) node.ref = ref;

  return node;
}

function readEdge(value: YEdge): ArchEdge | null {
  const id = str(value.get('id'));
  const source = str(value.get('source'));
  const target = str(value.get('target'));
  const kind = str(value.get('kind'));
  if (!id || !source || !target || !kind || !EDGE_KINDS.has(kind)) return null;

  const edge: ArchEdge = { id, source, target, kind: kind as EdgeKind };

  const label = str(value.get('label'));
  if (label !== null) edge.label = label;
  const timeoutMs = num(value.get('timeoutMs'));
  if (timeoutMs !== null) edge.timeoutMs = timeoutMs;
  const retries = num(value.get('retries'));
  if (retries !== null) edge.retries = retries;
  const circuitBreaker = bool(value.get('circuitBreaker'));
  if (circuitBreaker !== null) edge.circuitBreaker = circuitBreaker;
  const idempotent = bool(value.get('idempotent'));
  if (idempotent !== null) edge.idempotent = idempotent;

  return edge;
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

function readObservationSet(value: unknown): ObservationSet | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const source = str(record['source']);
  const observedAt = str(record['observedAt']);
  if (!source || !observedAt) return null;

  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(record[key])
      ? (record[key] as unknown[]).filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : [];

  const nodes = list('nodes').filter((n) => typeof n['ref'] === 'string') as unknown as NodeObservation[];
  const edges = list('edges').filter(
    (e) => typeof e['source'] === 'string' && typeof e['target'] === 'string',
  ) as unknown as EdgeObservation[];
  return { source, observedAt, nodes, edges };
}

/** Edges have no label of their own worth remembering; name them by their ends. */
function edgeLabeller(graph: ArchGraph): (edge: ArchEdge) => string {
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  return (edge) => `${labels.get(edge.source) ?? edge.source} to ${labels.get(edge.target) ?? edge.target}`;
}

function readIntent(value: Y.Map<unknown>): ElementIntent | null {
  if (!(value instanceof Y.Map)) return null;
  const kind = value.get('_kind');
  if (kind !== 'node' && kind !== 'edge') return null;

  const fields: Record<string, ApprovedField> = {};
  for (const field of intentFieldsFor(kind)) {
    const raw = value.get(field);
    if (typeof raw !== 'object' || raw === null || !('value' in raw)) continue;
    const approved = raw as ApprovedField;
    fields[field] = {
      value: approved.value ?? null,
      ...('previous' in approved ? { previous: approved.previous ?? null } : {}),
      by: str(approved.by) ?? 'unknown',
      at: str(approved.at) ?? '',
    };
  }
  return { kind, label: str(value.get('_label')) ?? '', fields };
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
