import type { ArchEdge, ArchGraph, ArchNode, EdgeKind, NodeKind } from '@keel/shared';
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
    return new Y.UndoManager([this.nodes, this.edges], {
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

  /** Subscribe to any change, local or remote. Returns an unsubscribe function. */
  observe(listener: () => void): () => void {
    const handler = (): void => listener();
    this.nodes.observeDeep(handler);
    this.edges.observeDeep(handler);

    return () => {
      this.nodes.unobserveDeep(handler);
      this.edges.unobserveDeep(handler);
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

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
