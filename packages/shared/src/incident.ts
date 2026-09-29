import type { Evidence, ObservationSet } from './evidence.js';
import type { DesignIntent, FieldValue } from './intent.js';
import { FIELD_LABELS, formatFieldValue } from './review.js';
import type { ArchEdge, ArchGraph, ArchNode } from './types.js';

/**
 * Incident mode: the diagram as a live map of what is broken right now, and
 * of what changed shortly before.
 *
 * Design review asks "what could go wrong"; an incident asks "what is wrong,
 * where do I look first, and what changed". The first two come from the same
 * observations validation already uses, read as health instead of as
 * evidence for rules. The third needs history, which observation sets do not
 * keep (each push replaces the last), so the ingest path records what each
 * push changed as events (`diffObservationSets`).
 */

export type Health = 'down' | 'degraded' | 'healthy' | 'unknown';

/**
 * Where healthy ends. Provisional defaults, deliberately in one place: what
 * on-call should be pointed at first is a call for the people who carry the
 * pager (PROJECT_PLAN task 9), and these are the knobs it turns.
 */
export const INCIDENT_THRESHOLDS = {
  /** Share of requests failing at which a component or call is degraded. */
  errorRateDegraded: 0.05,
  /** Share failing at which it is down. */
  errorRateDown: 0.5,
  /** p99 as a share of the timeout at which a call is about to start timing out. */
  latencyNearTimeout: 0.8,
} as const;

export interface HealthReport {
  id: string;
  element: 'node' | 'edge';
  label: string;
  health: Health;
  /** Why it is not healthy, most important first. Empty when healthy or unknown. */
  reasons: string[];
  rps?: number;
  errorRate?: number;
  p99Ms?: number;
  /** Observed ready instances, and how many the diagram declares. Nodes only. */
  ready?: { observed: number; declared: number };
  /**
   * Components that call this one synchronously, directly or further up the
   * chain. They fail when it does, which is what makes it worth looking at first.
   */
  affects: string[];
}

export interface IncidentView {
  byId: Record<string, HealthReport>;
  /**
   * Everything not healthy, ranked for on-call: down before degraded, then by
   * how much depends on it, components before calls, then by traffic. Root causes, not symptoms: a call
   * failing only because its target is down is folded into the target's entry.
   */
  lookFirst: HealthReport[];
  /** No fresh observations at all, so every health is unknown. */
  noData: boolean;
}

export function incidentView(graph: ArchGraph, evidence: Evidence | null): IncidentView {
  const byId: Record<string, HealthReport> = {};
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const callers = syncCallers(graph);
  const affectsOf = (id: string): string[] =>
    upstreamOf(id, callers)
      .map((nodeId) => nodesById.get(nodeId)?.label ?? nodeId)
      .sort((a, b) => a.localeCompare(b));

  for (const node of graph.nodes) byId[node.id] = nodeHealth(node, evidence, affectsOf);

  for (const edge of graph.edges) {
    const report = edgeHealth(edge, evidence, nodesById);
    const source = nodesById.get(edge.source);
    // A failing call hurts its caller and everything that waits on the caller.
    if (report.health === 'down' || report.health === 'degraded') {
      report.affects = [...new Set([source?.label ?? edge.source, ...affectsOf(edge.source)])].sort((a, b) =>
        a.localeCompare(b),
      );
    }
    byId[edge.id] = report;
  }

  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  const lookFirst = Object.values(byId)
    .filter((report) => report.health === 'down' || report.health === 'degraded')
    .filter((report) => !isSymptom(report, edgesById, byId))
    .sort(
      (a, b) =>
        RANK[a.health] - RANK[b.health] ||
        b.affects.length - a.affects.length ||
        // A component is what on-call acts on; a call into it usually hurts because of it.
        (a.element === b.element ? 0 : a.element === 'node' ? -1 : 1) ||
        (b.rps ?? 0) - (a.rps ?? 0) ||
        a.label.localeCompare(b.label),
    );

  const noData = !evidence || evidence.sources.every((s) => s.stale);
  return { byId, lookFirst, noData };
}

const RANK: Record<Health, number> = { down: 0, degraded: 1, unknown: 2, healthy: 3 };

function nodeHealth(node: ArchNode, evidence: Evidence | null, affectsOf: (id: string) => string[]): HealthReport {
  const observed = evidence?.nodes[node.id];
  const rps = evidence?.traffic[node.id];
  const report: HealthReport = {
    id: node.id,
    element: 'node',
    label: node.label,
    health: observed || rps !== undefined ? 'healthy' : 'unknown',
    reasons: [],
    affects: [],
  };
  if (rps !== undefined) report.rps = rps;

  if (observed?.replicas !== undefined) {
    report.ready = { observed: observed.replicas, declared: node.replicas };
    if (observed.replicas === 0) {
      worsen(report, 'down', `No ready instances (${node.replicas} declared)`);
    } else if (observed.replicas < node.replicas) {
      worsen(report, 'degraded', `${observed.replicas} of ${node.replicas} instances ready`);
    }
  }
  if (observed?.errorRate !== undefined) {
    report.errorRate = observed.errorRate;
    rateReason(report, observed.errorRate, 'requests');
  }

  if (report.health === 'down' || report.health === 'degraded') report.affects = affectsOf(node.id);
  return report;
}

function edgeHealth(edge: ArchEdge, evidence: Evidence | null, nodes: ReadonlyMap<string, ArchNode>): HealthReport {
  const observed = evidence?.edges[edge.id];
  const rps = evidence?.traffic[edge.id];
  const label = `${nodes.get(edge.source)?.label ?? edge.source} to ${nodes.get(edge.target)?.label ?? edge.target}`;
  const report: HealthReport = {
    id: edge.id,
    element: 'edge',
    label,
    health: observed || rps !== undefined ? 'healthy' : 'unknown',
    reasons: [],
    affects: [],
  };
  if (rps !== undefined) report.rps = rps;
  if (!observed) return report;

  if (observed.errorRate !== undefined) {
    report.errorRate = observed.errorRate;
    rateReason(report, observed.errorRate, 'calls');
  }
  if (observed.p99Ms !== undefined) {
    report.p99Ms = observed.p99Ms;
    // The timeout it actually runs with, when that was observed.
    const timeout = observed.timeoutMs === null ? undefined : (observed.timeoutMs ?? edge.timeoutMs);
    if (timeout !== undefined && timeout > 0) {
      if (observed.p99Ms >= timeout) {
        worsen(report, 'degraded', `p99 ${round(observed.p99Ms)} ms is at or past the ${timeout} ms timeout`);
      } else if (observed.p99Ms >= timeout * INCIDENT_THRESHOLDS.latencyNearTimeout) {
        worsen(report, 'degraded', `p99 ${round(observed.p99Ms)} ms is close to the ${timeout} ms timeout`);
      }
    }
  }
  return report;
}

function rateReason(report: HealthReport, rate: number, what: string): void {
  const text = `${percent(rate)} of ${what} failing`;
  if (rate >= INCIDENT_THRESHOLDS.errorRateDown) worsen(report, 'down', text);
  else if (rate >= INCIDENT_THRESHOLDS.errorRateDegraded) worsen(report, 'degraded', text);
}

function worsen(report: HealthReport, health: 'down' | 'degraded', reason: string): void {
  if (RANK[health] < RANK[report.health]) report.health = health;
  if (health === 'down') report.reasons.unshift(reason);
  else report.reasons.push(reason);
}

/**
 * A call is a symptom when it fails only because what it calls is failing:
 * the callee is itself down or degraded and the call adds no reason of its own
 * beyond errors (which is how a dead callee looks from the caller).
 */
function isSymptom(
  report: HealthReport,
  edges: ReadonlyMap<string, ArchEdge>,
  byId: Record<string, HealthReport>,
): boolean {
  if (report.element !== 'edge') return false;
  const edge = edges.get(report.id);
  const target = edge ? byId[edge.target] : undefined;
  if (!target || (target.health !== 'down' && target.health !== 'degraded')) return false;
  return report.reasons.every((reason) => reason.includes('failing'));
}

/** Who calls each node synchronously. */
function syncCallers(graph: ArchGraph): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'sync') continue;
    callers.set(edge.target, [...(callers.get(edge.target) ?? []), edge.source]);
  }
  return callers;
}

function upstreamOf(id: string, callers: ReadonlyMap<string, string[]>): string[] {
  const seen = new Set<string>();
  const queue = [...(callers.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (next === id || seen.has(next)) continue;
    seen.add(next);
    queue.push(...(callers.get(next) ?? []));
  }
  return [...seen];
}

// --- Events -------------------------------------------------------------------

/** One thing a push changed about the running system. */
export interface ObservationEvent {
  /** When the set that showed the change was observed. */
  at: string;
  /** Which source reported it. */
  source: string;
  /** `source` events are about the reporter itself: it started reporting. */
  kind: 'node' | 'edge' | 'source';
  /** The node's ref, or the edge's source ref. Empty for a source event. */
  ref: string;
  /** The edge's target ref. */
  target?: string;
  /** A tracked field, `present` for appearing or vanishing, or `errorRate` for crossing the degraded line. */
  field: string;
  from?: FieldValue;
  to?: FieldValue;
}

/** Events one push may add. A redeploy of everything is one line in the timeline's eyes, not a flood. */
export const MAX_EVENTS_PER_PUSH = 50;
/** Events a room keeps, oldest dropped first. */
export const MAX_EVENTS = 500;
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many of the oldest stored events to drop, so the log stays within
 * MAX_EVENTS and EVENT_RETENTION_MS. The log is oldest first; malformed
 * entries at its head go too.
 */
export function eventsToDrop(stored: readonly unknown[], now: number): number {
  let expired = 0;
  for (const value of stored) {
    const event = readObservationEvent(value);
    const t = event ? Date.parse(event.at) : NaN;
    if (Number.isFinite(t) && now - t <= EVENT_RETENTION_MS) break;
    expired += 1;
  }
  return Math.max(expired, stored.length - MAX_EVENTS);
}

const NODE_EVENT_FIELDS = ['replicas', 'hasReplica', 'hasBackup', 'hasDlq'] as const;
const EDGE_EVENT_FIELDS = ['timeoutMs', 'retries', 'circuitBreaker'] as const;

/**
 * What changed between a source's previous set and its new one.
 *
 * Only discrete facts are events: instance counts, settings, a component
 * appearing or vanishing, and error rates crossing the degraded line. Rates
 * and latencies move on every push, and recording each wobble would bury the
 * one change that matters.
 */
export function diffObservationSets(previous: ObservationSet | null | undefined, next: ObservationSet): ObservationEvent[] {
  const at = next.observedAt;
  const source = next.source;
  if (!previous) return [{ at, source, kind: 'source', ref: '', field: 'present', from: false, to: true }];

  const events: ObservationEvent[] = [];
  const line = INCIDENT_THRESHOLDS.errorRateDegraded;
  const crossed = (from: number | undefined, to: number | undefined): boolean =>
    from !== undefined && to !== undefined && from >= line !== to >= line;

  const before = new Map((previous.nodes ?? []).map((n) => [n.ref, n]));
  const after = new Map((next.nodes ?? []).map((n) => [n.ref, n]));
  for (const [ref, now] of after) {
    const was = before.get(ref);
    if (!was) {
      events.push({ at, source, kind: 'node', ref, field: 'present', from: false, to: true });
      continue;
    }
    for (const field of NODE_EVENT_FIELDS) {
      if (was[field] !== undefined && now[field] !== undefined && was[field] !== now[field]) {
        events.push({ at, source, kind: 'node', ref, field, from: was[field], to: now[field] });
      }
    }
    if (crossed(was.errorRate, now.errorRate)) {
      events.push({ at, source, kind: 'node', ref, field: 'errorRate', from: was.errorRate!, to: now.errorRate! });
    }
  }
  for (const ref of before.keys()) {
    if (!after.has(ref)) events.push({ at, source, kind: 'node', ref, field: 'present', from: true, to: false });
  }

  const key = (e: { source: string; target: string }): string => `${e.source}\u0000${e.target}`;
  const edgesBefore = new Map((previous.edges ?? []).map((e) => [key(e), e]));
  const edgesAfter = new Map((next.edges ?? []).map((e) => [key(e), e]));
  for (const [k, now] of edgesAfter) {
    const was = edgesBefore.get(k);
    const where = { at, source, kind: 'edge' as const, ref: now.source, target: now.target };
    if (!was) {
      events.push({ ...where, field: 'present', from: false, to: true });
      continue;
    }
    for (const field of EDGE_EVENT_FIELDS) {
      if (was[field] !== undefined && now[field] !== undefined && was[field] !== now[field]) {
        events.push({ ...where, field, from: was[field], to: now[field] });
      }
    }
    if (crossed(was.errorRate, now.errorRate)) {
      events.push({ ...where, field: 'errorRate', from: was.errorRate!, to: now.errorRate! });
    }
  }
  for (const [k, was] of edgesBefore) {
    if (!edgesAfter.has(k)) {
      events.push({ at, source, kind: 'edge', ref: was.source, target: was.target, field: 'present', from: true, to: false });
    }
  }

  return events.slice(0, MAX_EVENTS_PER_PUSH);
}

// --- Timeline -----------------------------------------------------------------

export interface TimelineEntry {
  at: string;
  kind: 'observed' | 'approved' | 'source';
  text: string;
  /** Who reported or approved it. */
  by: string;
  /** The diagram element it is about, when there is one on the canvas. */
  elementId?: string;
}

export interface TimelineOptions {
  now?: number;
  /** How far back to look. Defaults to 24 hours. */
  windowMs?: number;
}

/**
 * What changed recently, newest first: the running system (from recorded
 * events) and the approved design (from approval times), side by side, since
 * "someone approved dropping the retries an hour ago" and "the error rate
 * rose an hour ago" are the same story.
 */
export function buildTimeline(
  graph: ArchGraph,
  events: readonly ObservationEvent[],
  intent: DesignIntent,
  options: TimelineOptions = {},
): TimelineEntry[] {
  const now = options.now ?? Date.now();
  const since = now - (options.windowMs ?? 24 * 60 * 60 * 1000);
  const recent = (at: string): boolean => {
    const t = Date.parse(at);
    return Number.isFinite(t) && t >= since;
  };

  const byRef = new Map<string, ArchNode>();
  for (const node of graph.nodes) byRef.set(node.ref?.trim() || node.id, node);
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const nameOf = (id: string): string => labels.get(id) ?? intent[id]?.label ?? id;

  const entries: TimelineEntry[] = [];
  for (const event of events) {
    if (!recent(event.at)) continue;
    entries.push(describeEvent(event, byRef, graph));
  }

  for (const [id, element] of Object.entries(intent)) {
    // One entry per approval: fields approved together share a time and an approver.
    const groups = new Map<string, string[]>();
    for (const [field, approved] of Object.entries(element.fields)) {
      if (!recent(approved.at) || approved.previous === undefined) continue;
      const key = `${approved.at}\u0000${approved.by}`;
      groups.set(key, [
        ...(groups.get(key) ?? []),
        `${FIELD_LABELS[field] ?? field} ${formatFieldValue(field, approved.previous, nameOf)} → ${formatFieldValue(field, approved.value, nameOf)}`,
      ]);
    }
    const present = labels.has(id) || graph.edges.some((e) => e.id === id);
    for (const [key, changes] of groups) {
      const [at = '', by = ''] = key.split('\u0000');
      entries.push({
        at,
        kind: 'approved',
        by,
        text: `${by} approved ${element.label}: ${changes.join(', ')}`,
        ...(present ? { elementId: id } : {}),
      });
    }
  }

  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function describeEvent(event: ObservationEvent, byRef: ReadonlyMap<string, ArchNode>, graph: ArchGraph): TimelineEntry {
  const base = { at: event.at, by: event.source };
  if (event.kind === 'source') return { ...base, kind: 'source', text: `${event.source} started reporting` };

  const from = byRef.get(event.ref);
  const name = from?.label ?? event.ref;
  let label = name;
  let elementId = from?.id;
  if (event.kind === 'edge') {
    const to = event.target ? byRef.get(event.target) : undefined;
    label = `${name} to ${to?.label ?? event.target}`;
    elementId = graph.edges.find((e) => e.source === from?.id && e.target === to?.id)?.id;
  }

  let text: string;
  if (event.field === 'present') {
    text = event.to ? `${label} started reporting` : `${label} stopped reporting`;
  } else if (event.field === 'errorRate') {
    const rate = typeof event.to === 'number' ? event.to : 0;
    text =
      rate >= INCIDENT_THRESHOLDS.errorRateDegraded
        ? `${label}: errors rose to ${percent(rate)}`
        : `${label}: errors back down to ${percent(rate)}`;
  } else {
    const field = FIELD_LABELS[event.field] ?? event.field;
    text = `${label}: ${field} ${formatFieldValue(event.field, event.from)} → ${formatFieldValue(event.field, event.to)}`;
  }
  return { ...base, kind: 'observed', text, ...(elementId ? { elementId } : {}) };
}

/** A stored event, validated: the document is shared and can hold anything. */
export function readObservationEvent(value: unknown): ObservationEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { at, source, kind, ref, field } = record;
  if (typeof at !== 'string' || typeof source !== 'string' || typeof ref !== 'string' || typeof field !== 'string') return null;
  if (kind !== 'node' && kind !== 'edge' && kind !== 'source') return null;
  const event: ObservationEvent = { at, source, kind, ref, field };
  if (typeof record['target'] === 'string') event.target = record['target'];
  if (isFieldValue(record['from'])) event.from = record['from'];
  if (isFieldValue(record['to'])) event.to = record['to'];
  return event;
}

const isFieldValue = (value: unknown): value is FieldValue =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const percent = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;
const round = (ms: number): number => Math.round(ms);
