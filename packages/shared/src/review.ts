import {
  declaredField,
  intentFieldsFor,
  unapprovedFields,
  type ApprovedField,
  type DesignIntent,
  type ElementIntent,
  type FieldValue,
} from './intent.js';
import { EDGE_KINDS, NODE_KINDS, type ArchEdge, type ArchGraph, type ArchNode, type EdgeKind, type NodeKind } from './types.js';

/**
 * Review mode: the diagram's changes since approval, read like a pull request.
 *
 * The `unapproved-change` check already says *that* something changed. This is
 * the diff underneath it, element by element and field by field, so a reviewer
 * can take each change on its own: approve it into the baseline, or reject it
 * and put the diagram back to what was approved.
 *
 * Only runtime-meaningful fields are compared (see `NODE_INTENT_FIELDS`), the
 * same ones the baseline tracks, so moving or renaming a box is never a change.
 */

export type ChangeType = 'added' | 'removed' | 'changed';

export interface FieldChange {
  field: string;
  /** What was approved. Absent for an element that was never approved. */
  approved?: ApprovedField;
  /** What is drawn now. Absent for an element that has been removed. */
  current?: FieldValue;
  /** Why rejecting this field would not work, when it would not. */
  blocked?: string;
}

export interface ReviewChange {
  id: string;
  element: 'node' | 'edge';
  type: ChangeType;
  label: string;
  fields: FieldChange[];
  /** Why rejecting the whole change would not work, when it would not. */
  blocked?: string;
}

/**
 * Every difference between the diagram and its approved baseline.
 *
 * Empty when nothing has been approved yet: without a baseline, everything on
 * the canvas would be "added", which is noise rather than review. That state
 * is approved wholesale ("Approve design") instead.
 *
 * Ordered removals, additions, then field changes, nodes before edges, so the
 * structural changes a reviewer most needs to see come first.
 */
export function reviewChanges(graph: ArchGraph, intent: DesignIntent): ReviewChange[] {
  if (Object.keys(intent).length === 0) return [];

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const nameOf = (id: string): string => labels.get(id) ?? intent[id]?.label ?? id;
  const edgeName = (edge: { source: string; target: string }): string => `${nameOf(edge.source)} to ${nameOf(edge.target)}`;

  const changes: ReviewChange[] = [];
  const present = new Set<string>();

  const visit = (element: ArchNode | ArchEdge, kind: 'node' | 'edge'): void => {
    present.add(element.id);
    const label = kind === 'node' ? (element as ArchNode).label : edgeName(element as ArchEdge);
    const approved = intent[element.id];

    if (!approved) {
      changes.push({
        id: element.id,
        element: kind,
        type: 'added',
        label,
        fields: intentFieldsFor(kind).map((field) => ({ field, current: declaredField(element, field) })),
      });
      return;
    }

    const differing = unapprovedFields(element, approved);
    if (differing.length === 0) return;
    const change: ReviewChange = {
      id: element.id,
      element: kind,
      type: 'changed',
      label,
      fields: differing.map((field) => {
        const change: FieldChange = { field, approved: approved.fields[field]!, current: declaredField(element, field) };
        const endpoint = approved.fields[field]!.value;
        if ((field === 'source' || field === 'target') && typeof endpoint === 'string' && !nodeIds.has(endpoint)) {
          change.blocked = `${nameOf(endpoint)} is no longer on the diagram.`;
        }
        return change;
      }),
    };
    const blocked = change.fields.find((f) => f.blocked)?.blocked;
    if (blocked) change.blocked = blocked;
    changes.push(change);
  };

  for (const node of graph.nodes) visit(node, 'node');
  for (const edge of graph.edges) visit(edge, 'edge');

  for (const [id, approved] of Object.entries(intent)) {
    if (present.has(id)) continue;
    const change: ReviewChange = {
      id,
      element: approved.kind,
      type: 'removed',
      label: approved.kind === 'edge' ? removedEdgeName(approved, nameOf) : approved.label || id,
      fields: intentFieldsFor(approved.kind)
        .filter((field) => approved.fields[field] !== undefined)
        .map((field) => ({ field, approved: approved.fields[field]! })),
    };
    const blocked = restoreBlocker(id, intent, nodeIds, nameOf);
    if (blocked) change.blocked = blocked;
    changes.push(change);
  }

  const order: Record<ChangeType, number> = { removed: 0, added: 1, changed: 2 };
  return changes.sort(
    (a, b) =>
      order[a.type] - order[b.type] ||
      (a.element === b.element ? 0 : a.element === 'node' ? -1 : 1) ||
      a.label.localeCompare(b.label),
  );
}

function removedEdgeName(approved: ElementIntent, nameOf: (id: string) => string): string {
  const source = approved.fields['source']?.value;
  const target = approved.fields['target']?.value;
  if (typeof source === 'string' && typeof target === 'string') return `${nameOf(source)} to ${nameOf(target)}`;
  return approved.label;
}

/**
 * Why a removed element cannot be put back, or null when it can.
 *
 * A removed edge brings back its removed endpoints with it (deleting a node
 * took its edges, so undoing one without the other would be half a restore),
 * which only works for endpoints the baseline still describes.
 */
function restoreBlocker(
  id: string,
  intent: DesignIntent,
  present: ReadonlySet<string>,
  nameOf: (id: string) => string,
): string | null {
  const approved = intent[id]!;
  if (!restoredElement(id, approved)) return 'Not enough of it was approved to rebuild it.';
  if (approved.kind === 'node') return null;

  for (const end of ['source', 'target'] as const) {
    const nodeId = approved.fields[end]?.value;
    if (typeof nodeId !== 'string') continue;
    if (present.has(nodeId)) continue;
    const endpoint = intent[nodeId];
    if (!endpoint || endpoint.kind !== 'node' || !restoredElement(nodeId, endpoint)) {
      return `${nameOf(nodeId)} is gone and was never approved, so there is nothing to connect it to.`;
    }
  }
  return null;
}

const NODE_KIND_SET = new Set<string>(NODE_KINDS);
const EDGE_KIND_SET = new Set<string>(EDGE_KINDS);

/**
 * Rebuild a removed element from its approval: runtime fields from the
 * approved values, presentation from the layout saved alongside them.
 *
 * Returns null when the approval does not say enough to rebuild it (no valid
 * kind, or an edge without both ends). A baseline from before layouts were
 * saved still restores, just at the origin at the default size.
 */
export function restoredElement(id: string, approved: ElementIntent): ArchNode | ArchEdge | null {
  const value = (field: string): FieldValue | undefined => approved.fields[field]?.value;
  const layout = approved.layout ?? {};
  const kind = value('kind');

  if (approved.kind === 'node') {
    if (typeof kind !== 'string' || !NODE_KIND_SET.has(kind)) return null;
    const replicas = value('replicas');
    const node: ArchNode = {
      id,
      kind: kind as NodeKind,
      label: layout.label ?? approved.label ?? id,
      x: layout.x ?? 0,
      y: layout.y ?? 0,
      w: layout.w ?? 180,
      h: layout.h ?? 80,
      replicas: typeof replicas === 'number' ? replicas : 1,
    };
    if (layout.tech !== undefined) node.tech = layout.tech;
    if (layout.notes !== undefined) node.notes = layout.notes;
    for (const flag of ['critical', 'hasReplica', 'hasBackup', 'hasDlq'] as const) {
      if (value(flag) === true) node[flag] = true;
    }
    const ref = value('ref');
    if (typeof ref === 'string' && ref !== '') node.ref = ref;
    return node;
  }

  const source = value('source');
  const target = value('target');
  if (typeof kind !== 'string' || !EDGE_KIND_SET.has(kind) || typeof source !== 'string' || typeof target !== 'string') {
    return null;
  }
  const edge: ArchEdge = { id, source, target, kind: kind as EdgeKind };
  if (layout.label !== undefined) edge.label = layout.label;
  const timeoutMs = value('timeoutMs');
  if (typeof timeoutMs === 'number') edge.timeoutMs = timeoutMs;
  const retries = value('retries');
  if (typeof retries === 'number' && retries > 0) edge.retries = retries;
  for (const flag of ['circuitBreaker', 'idempotent'] as const) {
    if (value(flag) === true) edge[flag] = true;
  }
  return edge;
}

/**
 * The patch that puts these fields back to their approved values, in the
 * shape the diagram stores them: a false checkbox or an absent timeout is a
 * cleared key (undefined), matching what the inspector writes.
 */
export function revertPatch(approved: ElementIntent, fields: readonly string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    const entry = approved.fields[field];
    if (!entry) continue;
    const value = entry.value;
    patch[field] = value === null || value === false || (field === 'retries' && value === 0) ? undefined : value;
  }
  return patch;
}

/**
 * A field value as a reviewer reads it. `nameOf` turns an edge's endpoint ids
 * into component names, since an id means nothing on screen.
 */
export function formatFieldValue(field: string, value: FieldValue | undefined, nameOf?: (id: string) => string): string {
  if (value === undefined) return '(none)';
  if ((field === 'source' || field === 'target') && typeof value === 'string') return nameOf?.(value) ?? value;
  if (value === null) return field === 'timeoutMs' ? 'no timeout' : '(none)';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field === 'timeoutMs' && typeof value === 'number') return `${value} ms`;
  return String(value);
}

/** Field names as the inspector labels them. */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  kind: 'Kind',
  replicas: 'Instances',
  critical: 'Critical path',
  hasReplica: 'Replica',
  hasBackup: 'Backups',
  hasDlq: 'Dead-letter queue',
  ref: 'Runtime name',
  source: 'From',
  target: 'To',
  timeoutMs: 'Timeout',
  retries: 'Retries',
  circuitBreaker: 'Circuit breaker',
  idempotent: 'Idempotent',
};
