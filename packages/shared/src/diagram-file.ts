import { DEFAULT_NODE_SIZE } from './factory.js';
import { EDGE_INTENT_FIELDS, NODE_INTENT_FIELDS, type ApprovedField, type DesignIntent, type ElementIntent } from './intent.js';
import { EDGE_KINDS, NODE_KINDS, type ArchEdge, type ArchGraph, type ArchNode, type EdgeKind, type NodeKind } from './types.js';

/**
 * The diagram file format: what Export writes and Import reads.
 *
 * A plain graph plus an optional approved baseline, in exactly the shape
 * `POST /api/validate` accepts, so one file serves a repo, a CI check and a
 * re-import. Observations are deliberately absent: they describe a moment in
 * production rather than the design, and are stale within a day.
 */

export const DIAGRAM_FORMAT = 'keel-diagram';
export const DIAGRAM_VERSION = 1;

/** Same bounds as the server's ArchGraphSchema, so an importable file is always a validatable one. */
export const MAX_IMPORT_NODES = 500;
export const MAX_IMPORT_EDGES = 1500;

export interface DiagramFile {
  format: typeof DIAGRAM_FORMAT;
  version: number;
  exportedAt: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
  intent?: DesignIntent;
}

export function serializeDiagram(graph: ArchGraph, intent: DesignIntent = {}, exportedAt = new Date()): string {
  const file: DiagramFile = {
    format: DIAGRAM_FORMAT,
    version: DIAGRAM_VERSION,
    exportedAt: exportedAt.toISOString(),
    nodes: graph.nodes,
    edges: graph.edges,
    ...(Object.keys(intent).length > 0 ? { intent } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ParseResult =
  | { ok: true; graph: ArchGraph; intent: DesignIntent }
  | { ok: false; errors: string[] };

/** Stop listing problems past this; a file with fifty is not fixed one line at a time. */
const MAX_REPORTED_ERRORS = 5;

/**
 * Read a diagram file, or explain exactly why it cannot be read.
 *
 * Strict, and all-or-nothing. Skipping bad records, as the live document does,
 * is right for a shared doc that must keep rendering; for a file someone chose
 * to open, silently dropping half of it is worse than refusing it with a
 * reason. A bare `{ nodes, edges }` graph, such as one written for
 * /api/validate by hand, is accepted too.
 */
export function parseDiagram(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['The file is not valid JSON.'] };
  }

  const errors: string[] = [];
  const fail = (message: string): void => {
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(message);
  };

  if (!isRecord(raw)) return { ok: false, errors: ['Expected a JSON object with "nodes" and "edges".'] };
  if (raw['format'] !== undefined && raw['format'] !== DIAGRAM_FORMAT) {
    return { ok: false, errors: [`Unknown format ${JSON.stringify(raw['format'])}. Expected "${DIAGRAM_FORMAT}".`] };
  }
  if (typeof raw['version'] === 'number' && raw['version'] > DIAGRAM_VERSION) {
    return {
      ok: false,
      errors: [`This file is format version ${raw['version']}; this version of Keel reads up to ${DIAGRAM_VERSION}.`],
    };
  }
  if (!Array.isArray(raw['nodes']) || !Array.isArray(raw['edges'])) {
    return { ok: false, errors: ['Expected "nodes" and "edges" arrays.'] };
  }
  if (raw['nodes'].length > MAX_IMPORT_NODES) fail(`Too many components (${raw['nodes'].length}; the limit is ${MAX_IMPORT_NODES}).`);
  if (raw['edges'].length > MAX_IMPORT_EDGES) fail(`Too many dependencies (${raw['edges'].length}; the limit is ${MAX_IMPORT_EDGES}).`);
  if (errors.length > 0) return { ok: false, errors };

  const nodes: ArchNode[] = [];
  const ids = new Set<string>();
  (raw['nodes'] as unknown[]).forEach((value, i) => {
    const node = readNode(value, `Component ${i + 1}`, fail);
    if (!node) return;
    if (ids.has(node.id)) fail(`Component ${i + 1} reuses the id "${node.id}".`);
    ids.add(node.id);
    nodes.push(node);
  });

  // Every id the file names as a component, including ones rejected above, so
  // an edge to an invalid component is not also reported as pointing nowhere.
  const nodeIds = new Set(
    (raw['nodes'] as unknown[]).flatMap((n) => (isRecord(n) && typeof n['id'] === 'string' ? [n['id']] : [])),
  );
  const edges: ArchEdge[] = [];
  (raw['edges'] as unknown[]).forEach((value, i) => {
    const edge = readEdge(value, `Dependency ${i + 1}`, fail);
    if (!edge) return;
    if (ids.has(edge.id)) fail(`Dependency ${i + 1} reuses the id "${edge.id}".`);
    ids.add(edge.id);
    for (const end of [edge.source, edge.target]) {
      if (!nodeIds.has(end)) fail(`Dependency ${i + 1} points at "${end}", which is not a component in the file.`);
    }
    edges.push(edge);
  });

  const intent = raw['intent'] === undefined ? {} : readIntent(raw['intent'], fail);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, graph: { nodes, edges }, intent };
}

type Fail = (message: string) => void;

function readNode(value: unknown, where: string, fail: Fail): ArchNode | null {
  if (!isRecord(value)) {
    fail(`${where} is not an object.`);
    return null;
  }
  const id = value['id'];
  const kind = value['kind'];
  if (!isId(id)) {
    fail(`${where} needs a string "id" of 1 to 64 characters.`);
    return null;
  }
  if (typeof kind !== 'string' || !(NODE_KINDS as readonly string[]).includes(kind)) {
    fail(`${where} ("${id}") has kind ${JSON.stringify(kind) ?? 'undefined'}; expected one of ${NODE_KINDS.join(', ')}.`);
    return null;
  }

  const numberOr = (key: string, fallback: number): number => {
    const field = value[key];
    if (field === undefined) return fallback;
    if (typeof field !== 'number' || !Number.isFinite(field)) {
      fail(`${where} ("${id}") has a non-numeric "${key}".`);
      return fallback;
    }
    return field;
  };

  const replicas = numberOr('replicas', 1);
  if (!Number.isInteger(replicas) || replicas < 0) fail(`${where} ("${id}") needs a whole, non-negative "replicas".`);

  const node: ArchNode = {
    id,
    kind: kind as NodeKind,
    label: typeof value['label'] === 'string' ? value['label'] : 'Untitled',
    x: numberOr('x', 0),
    y: numberOr('y', 0),
    w: positive(numberOr('w', DEFAULT_NODE_SIZE.w), DEFAULT_NODE_SIZE.w),
    h: positive(numberOr('h', DEFAULT_NODE_SIZE.h), DEFAULT_NODE_SIZE.h),
    replicas,
  };
  for (const key of ['tech', 'notes', 'ref'] as const) {
    const field = optional(value, key, 'string', where, id, fail);
    if (field !== undefined) node[key] = field;
  }
  for (const key of ['critical', 'hasReplica', 'hasBackup', 'hasDlq'] as const) {
    const field = optional(value, key, 'boolean', where, id, fail);
    if (field !== undefined) node[key] = field;
  }
  return node;
}

function readEdge(value: unknown, where: string, fail: Fail): ArchEdge | null {
  if (!isRecord(value)) {
    fail(`${where} is not an object.`);
    return null;
  }
  const { id, source, target, kind } = value;
  if (!isId(id)) {
    fail(`${where} needs a string "id" of 1 to 64 characters.`);
    return null;
  }
  if (typeof source !== 'string' || typeof target !== 'string') {
    fail(`${where} ("${id}") needs string "source" and "target" ids.`);
    return null;
  }
  if (typeof kind !== 'string' || !(EDGE_KINDS as readonly string[]).includes(kind)) {
    fail(`${where} ("${id}") has kind ${JSON.stringify(kind) ?? 'undefined'}; expected one of ${EDGE_KINDS.join(', ')}.`);
    return null;
  }

  const edge: ArchEdge = { id, source, target, kind: kind as EdgeKind };
  const label = optional(value, 'label', 'string', where, id, fail);
  if (label !== undefined) edge.label = label;
  for (const key of ['timeoutMs', 'retries'] as const) {
    const field = optional(value, key, 'number', where, id, fail);
    if (field === undefined) continue;
    if (!Number.isFinite(field) || field < 0) fail(`${where} ("${id}") needs a non-negative "${key}".`);
    else edge[key] = field;
  }
  for (const key of ['circuitBreaker', 'idempotent'] as const) {
    const field = optional(value, key, 'boolean', where, id, fail);
    if (field !== undefined) edge[key] = field;
  }
  return edge;
}

function readIntent(value: unknown, fail: Fail): DesignIntent {
  if (!isRecord(value)) {
    fail('"intent" is not an object.');
    return {};
  }

  const intent: DesignIntent = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry) || (entry['kind'] !== 'node' && entry['kind'] !== 'edge') || !isRecord(entry['fields'])) {
      fail(`The approval for "${id}" is malformed.`);
      continue;
    }
    const kind = entry['kind'];
    const allowed: readonly string[] = kind === 'node' ? NODE_INTENT_FIELDS : EDGE_INTENT_FIELDS;
    const fields: Record<string, ApprovedField> = {};
    for (const [field, approved] of Object.entries(entry['fields'])) {
      if (!allowed.includes(field)) continue;
      if (!isRecord(approved) || !isFieldValue(approved['value']) || typeof approved['by'] !== 'string' || typeof approved['at'] !== 'string') {
        fail(`The approval for "${id}" has a malformed "${field}".`);
        continue;
      }
      fields[field] = {
        value: approved['value'],
        ...(isFieldValue(approved['previous']) ? { previous: approved['previous'] } : {}),
        by: approved['by'],
        at: approved['at'],
      };
    }
    const element: ElementIntent = {
      kind,
      label: typeof entry['label'] === 'string' ? entry['label'] : id,
      fields,
    };
    intent[id] = element;
  }
  return intent;
}

function optional<T extends 'string' | 'number' | 'boolean'>(
  record: Record<string, unknown>,
  key: string,
  type: T,
  where: string,
  id: string,
  fail: Fail,
): (T extends 'string' ? string : T extends 'number' ? number : boolean) | undefined {
  const field = record[key];
  if (field === undefined || field === null) return undefined;
  if (typeof field !== type) {
    fail(`${where} ("${id}") has a "${key}" that is not a ${type}.`);
    return undefined;
  }
  return field as T extends 'string' ? string : T extends 'number' ? number : boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;

const isFieldValue = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const positive = (value: number, fallback: number): number => (value > 0 ? value : fallback);
