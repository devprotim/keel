import type { EdgeObservation, NodeObservation, ObservationSet } from './evidence.js';
import { intentFieldsFor, readLayout, type ApprovedField, type ElementIntent } from './intent.js';
import { EDGE_KINDS, NODE_KINDS, type ArchEdge, type ArchNode, type EdgeKind, type NodeKind } from './types.js';

/**
 * Reading the collaborative document's records back into domain types.
 *
 * The room document is a Yjs doc with one top-level map per name below. The
 * client (apps/web GraphDoc) and the server (alerting, which validates a room
 * nobody has open) both read it, and they must read it identically or the two
 * would disagree about what a room contains. So the readers live here, framework-
 * and Yjs-free: a Y.Map satisfies `FieldReader` as it is.
 *
 * Every reader validates rather than casts. The document is shared and long-
 * lived: it can hold data written by an older build or a misbehaving peer, and
 * one bad record must be skipped, never allowed to break the whole room.
 */

export const DOC_MAPS = {
  /** One nested map per node, keyed by node id. */
  nodes: 'nodes',
  /** One nested map per edge, keyed by edge id. */
  edges: 'edges',
  /** One plain ObservationSet per source. */
  observations: 'observations',
  /** One nested map per approved element: `_kind`, `_label`, `_layout`, and one key per field. */
  intent: 'intent',
} as const;

/** The one method the readers need. `Y.Map` has it. */
export interface FieldReader {
  get(key: string): unknown;
}

export function isFieldReader(value: unknown): value is FieldReader {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function';
}

const NODE_KIND_SET = new Set<string>(NODE_KINDS);
const EDGE_KIND_SET = new Set<string>(EDGE_KINDS);

/**
 * Read a node back out of the document, rejecting anything malformed.
 *
 * The document is shared and long-lived: it can contain data written by an older
 * version of the app, or by a peer running a different build. Validating on read
 * means a single bad record is skipped rather than crashing the canvas for
 * everyone in the room.
 */
export function readNode(value: unknown): ArchNode | null {
  if (!isFieldReader(value)) return null;
  const id = str(value.get('id'));
  const kind = str(value.get('kind'));
  if (!id || !kind || !NODE_KIND_SET.has(kind)) return null;

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

export function readEdge(value: unknown): ArchEdge | null {
  if (!isFieldReader(value)) return null;
  const id = str(value.get('id'));
  const source = str(value.get('source'));
  const target = str(value.get('target'));
  const kind = str(value.get('kind'));
  if (!id || !source || !target || !kind || !EDGE_KIND_SET.has(kind)) return null;

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

export function readObservationSet(value: unknown): ObservationSet | null {
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

/** One approved element. The caller has checked it is a nested map, not a stray value. */
export function readElementIntent(value: FieldReader): ElementIntent | null {
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
  const element: ElementIntent = { kind, label: str(value.get('_label')) ?? '', fields };
  const layout = readLayout(value.get('_layout'));
  if (layout) element.layout = layout;
  return element;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
