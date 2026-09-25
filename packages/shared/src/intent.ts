import type { ArchEdge, ArchGraph, ArchNode } from './types.js';

/**
 * Intent: what someone has approved the design to be.
 *
 * Drift detection alone cannot tell an approved change from an accident. If the
 * diagram says three instances and production runs one, that might be a rollout
 * in progress or a deployment someone fat-fingered, and the two need opposite
 * responses. Recording who approved which value, and what it was before, is what
 * lets validation tell them apart: reality matching the previous approved value
 * is a rollout that has not landed yet, reality matching neither is an accident.
 */

export type FieldValue = string | number | boolean | null;

export interface ApprovedField {
  value: FieldValue;
  /** The value approved before this one, when the approval changed it. */
  previous?: FieldValue;
  by: string;
  at: string;
}

export interface ElementIntent {
  kind: 'node' | 'edge';
  /** Label at approval time, so a removed element can still be named. */
  label: string;
  fields: Record<string, ApprovedField>;
}

/** Approved baseline, keyed by node or edge id. Empty means nothing has been approved yet. */
export type DesignIntent = Record<string, ElementIntent>;

/**
 * The fields that carry runtime meaning. Position, label, notes and tech are
 * presentation, so moving a box never counts as an unapproved change.
 */
export const NODE_INTENT_FIELDS = ['kind', 'replicas', 'critical', 'hasReplica', 'hasBackup', 'hasDlq', 'ref'] as const;
export const EDGE_INTENT_FIELDS = ['kind', 'source', 'target', 'timeoutMs', 'retries', 'circuitBreaker', 'idempotent'] as const;

export type NodeIntentField = (typeof NODE_INTENT_FIELDS)[number];
export type EdgeIntentField = (typeof EDGE_INTENT_FIELDS)[number];

const BOOLEAN_FIELDS = new Set(['critical', 'hasReplica', 'hasBackup', 'hasDlq', 'circuitBreaker', 'idempotent']);

/**
 * A declared field in comparable form.
 *
 * Absent and false are the same claim for a checkbox, and an absent retry count
 * means zero retries. Without this, ticking and unticking a box would register
 * as a change against the baseline even though the design is identical.
 */
export function normalizeField(field: string, value: unknown): FieldValue {
  if (BOOLEAN_FIELDS.has(field)) return value === true;
  if (field === 'retries') return typeof value === 'number' ? value : 0;
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return field === 'ref' ? value.trim() || null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

export function declaredField(element: ArchNode | ArchEdge, field: string): FieldValue {
  return normalizeField(field, (element as unknown as Record<string, unknown>)[field]);
}

export function intentFieldsFor(kind: 'node' | 'edge'): readonly string[] {
  return kind === 'node' ? NODE_INTENT_FIELDS : EDGE_INTENT_FIELDS;
}

/**
 * Approve some or all of an element's fields at their current declared values.
 *
 * `previous` is only rewritten when the value actually changes, so re-approving
 * an unchanged element does not erase the memory of what it was before.
 */
export interface ApproveOptions {
  by: string;
  at: string;
  /** Approve only these fields. Defaults to every tracked field. */
  fields?: readonly string[];
  /** Name to remember the element by. Defaults to its label. */
  label?: string;
}

export function approveElement(
  element: ArchNode | ArchEdge,
  kind: 'node' | 'edge',
  existing: ElementIntent | undefined,
  { by, at, fields = intentFieldsFor(kind), label }: ApproveOptions,
): ElementIntent {
  const next: ElementIntent = {
    kind,
    label: label ?? element.label ?? existing?.label ?? element.id,
    fields: { ...existing?.fields },
  };

  for (const field of fields) {
    const value = declaredField(element, field);
    const prior = existing?.fields[field];
    if (prior && prior.value === value) continue;

    next.fields[field] = {
      value,
      ...(prior ? { previous: prior.value } : {}),
      by,
      at,
    };
  }
  return next;
}

/** Fields of an element whose declared value differs from the approved one. */
export function unapprovedFields(element: ArchNode | ArchEdge, intent: ElementIntent): string[] {
  return intentFieldsFor(intent.kind).filter((field) => {
    const approved = intent.fields[field];
    return approved !== undefined && approved.value !== declaredField(element, field);
  });
}

/** Whether anything in the graph differs from, or is missing from, the baseline. */
export function hasUnapprovedChanges(graph: ArchGraph, intent: DesignIntent): boolean {
  if (Object.keys(intent).length === 0) return graph.nodes.length > 0;

  const present = new Set<string>();
  for (const node of graph.nodes) {
    present.add(node.id);
    const approved = intent[node.id];
    if (!approved || unapprovedFields(node, approved).length > 0) return true;
  }
  for (const edge of graph.edges) {
    present.add(edge.id);
    const approved = intent[edge.id];
    if (!approved || unapprovedFields(edge, approved).length > 0) return true;
  }
  return Object.keys(intent).some((id) => !present.has(id));
}
