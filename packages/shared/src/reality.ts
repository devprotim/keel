import type { Evidence, ObservedEdge, ObservedNode } from './evidence.js';
import { declaredField, intentFieldsFor, normalizeField, type DesignIntent, type ElementIntent, type FieldValue } from './intent.js';
import type { ArchEdge, ArchGraph, ArchNode, FieldDelta, Finding, GraphIndex, Severity } from './types.js';

/**
 * Checks that compare the diagram against something other than itself.
 *
 * The rules in rules.ts can only find flaws in what was drawn. These find the
 * places where what was drawn is not true: the running system disagrees with
 * it, or it disagrees with what was approved. They are not `Rule`s because
 * they need more than the graph, but they report through the same Finding
 * shape and can be muted by id like any rule.
 */

export interface RealityCheck {
  id: string;
  name: string;
  rationale: string;
}

export const REALITY_CHECKS: readonly RealityCheck[] = [
  {
    id: 'observed-drift',
    name: 'Running system differs from the diagram',
    rationale:
      'A number typed into a diagram is a claim. When the running system reports a different ' +
      'value, every rule that trusted the claim was checking a system that does not exist.',
  },
  {
    id: 'unapproved-change',
    name: 'Change without approval',
    rationale:
      'Without a record of what was approved, an intended change and an accident look ' +
      'identical. A baseline is what makes drift actionable.',
  },
  {
    id: 'timeout-below-latency',
    name: 'Timeout below observed latency',
    rationale:
      'A timeout shorter than the real p99 fails healthy requests every day, and retries turn ' +
      'each of those failures into extra load on the dependency that was already slow.',
  },
  {
    id: 'undiagrammed-dependency',
    name: 'Dependency missing from the diagram',
    rationale:
      'A call that runs in production but is not drawn is invisible to every rule. The riskiest ' +
      'dependency is usually the one nobody remembered to draw.',
  },
  {
    id: 'stale-evidence',
    name: 'Stale observations',
    rationale:
      'Evidence older than the freshness window is not applied, so the components it covered ' +
      'fall back to trusting what was typed.',
  },
];

const NODE_OBSERVABLE = ['replicas', 'hasReplica', 'hasBackup', 'hasDlq'] as const;
const EDGE_OBSERVABLE = ['timeoutMs', 'retries', 'circuitBreaker'] as const;

export interface RealityInput {
  declared: ArchGraph;
  /** Declared graph with evidence applied. Criticality is read from here, so hot paths escalate. */
  effective: ArchGraph;
  index: GraphIndex;
  evidence: Evidence | null;
  intent: DesignIntent;
  maxAgeMs: number;
}

export function realityFindings(input: RealityInput): Finding[] {
  const findings: Finding[] = [];
  const effectiveById = new Map<string, ArchNode>();
  for (const node of input.effective.nodes) effectiveById.set(node.id, node);
  const effectiveEdges = new Map<string, ArchEdge>();
  for (const edge of input.effective.edges) effectiveEdges.set(edge.id, edge);

  const hasBaseline = Object.keys(input.intent).length > 0;
  const labelOf = (id: string): string => input.index.byId.get(id)?.label ?? id;

  for (const node of input.declared.nodes) {
    const critical = effectiveById.get(node.id)?.critical;
    findings.push(
      ...compareElement({
        element: node,
        kind: 'node',
        label: node.label,
        observed: input.evidence?.nodes[node.id],
        observable: NODE_OBSERVABLE,
        intent: input.intent[node.id],
        hasBaseline,
        critical,
        nodeIds: [node.id],
        edgeIds: [],
        labelOf,
      }),
    );
  }

  for (const edge of input.declared.edges) {
    if (!input.index.byId.has(edge.source) || !input.index.byId.has(edge.target)) continue;
    const critical = effectiveById.get(edge.source)?.critical || effectiveById.get(edge.target)?.critical;
    findings.push(
      ...compareElement({
        element: edge,
        kind: 'edge',
        label: `${labelOf(edge.source)} to ${labelOf(edge.target)}`,
        observed: input.evidence?.edges[edge.id],
        observable: EDGE_OBSERVABLE,
        intent: input.intent[edge.id],
        hasBaseline,
        critical,
        nodeIds: [edge.source, edge.target],
        edgeIds: [edge.id],
        labelOf,
      }),
    );
  }

  // Approved elements that are no longer drawn. They cannot be cited, since the
  // id no longer exists, so the delta carries the id for the approve action.
  const present = new Set([...input.declared.nodes.map((n) => n.id), ...input.declared.edges.map((e) => e.id)]);
  for (const [id, approved] of Object.entries(input.intent)) {
    if (present.has(id)) continue;
    findings.push({
      ruleId: 'unapproved-change',
      severity: 'info',
      title: `${approved.label} was removed from the approved design`,
      detail:
        `The approved baseline still includes this ${approved.kind === 'node' ? 'component' : 'dependency'}. ` +
        `Approve the removal if it was intended.`,
      nodeIds: [],
      edgeIds: [],
      deltas: [{ elementId: id, field: 'exists', declared: false, approved: true }],
      fix: 'approve',
    });
  }

  if (input.evidence) {
    findings.push(...latencyFindings(input, effectiveById, effectiveEdges, labelOf));
    findings.push(...undiagrammedFindings(input.evidence, effectiveById, labelOf));
    findings.push(...staleFindings(input.evidence, input.maxAgeMs));
  }

  return findings;
}

interface CompareInput {
  element: ArchNode | ArchEdge;
  kind: 'node' | 'edge';
  label: string;
  observed: ObservedNode | ObservedEdge | undefined;
  observable: readonly string[];
  intent: ElementIntent | undefined;
  hasBaseline: boolean;
  critical: boolean | undefined;
  nodeIds: string[];
  edgeIds: string[];
  labelOf: (id: string) => string;
}

type DriftClass = 'drift' | 'unapproved-drift' | 'rollout-pending';
type ChangeClass = 'pending' | 'shipped';

/**
 * Three-way comparison of one element: drawn, running, approved.
 *
 * Per field:
 * - running differs from drawn, nothing approved: plain drift.
 * - running differs from drawn and approved, but matches the value approved
 *   before: an approved change that has not rolled out.
 * - running differs from drawn and from anything approved: an accident.
 * - drawn differs from approved: a pending change, or, when the running system
 *   already matches it, a change that shipped without approval.
 */
function compareElement(input: CompareInput): Finding[] {
  const { element, intent } = input;
  const drift = new Map<DriftClass, { deltas: FieldDelta[]; dangerous: boolean }>();
  const changes = new Map<ChangeClass, FieldDelta[]>();

  for (const field of intentFieldsFor(input.kind)) {
    const declared = declaredField(element, field);
    const observed = input.observable.includes(field) ? observedField(input.observed, field) : undefined;
    const approval = intent?.fields[field];
    const delta: FieldDelta = {
      elementId: element.id,
      field,
      declared,
      ...(observed !== undefined ? { observed } : {}),
      ...(approval ? { approved: approval.value } : {}),
    };

    const drifted = observed !== undefined && observed !== declared;
    const changed = approval !== undefined && approval.value !== declared;

    if (drifted) {
      let kind: DriftClass | null;
      if (!approval) kind = 'drift';
      else if (observed === approval.value) kind = null; // Drawn moved, reality did not: a pending change.
      else if (!changed && 'previous' in approval && observed === approval.previous) kind = 'rollout-pending';
      else kind = 'unapproved-drift';

      if (kind) {
        const bucket = drift.get(kind) ?? { deltas: [], dangerous: false };
        bucket.deltas.push(delta);
        bucket.dangerous ||= isDangerous(field, declared, observed);
        drift.set(kind, bucket);
      }
    }

    if (changed) {
      const kind: ChangeClass = observed !== undefined && observed === declared ? 'shipped' : 'pending';
      changes.set(kind, [...(changes.get(kind) ?? []), delta]);
    }
  }

  const findings: Finding[] = [];
  const cite = { nodeIds: input.nodeIds, edgeIds: input.edgeIds };
  const describe = (deltas: FieldDelta[], pick: (d: FieldDelta) => string): string =>
    deltas.map((d) => `${FIELD_NAMES[d.field] ?? d.field} ${pick(d)}`).join('; ');
  const fmt = (d: FieldDelta, value: FieldValue | undefined): string => formatValue(d.field, value ?? null, input.labelOf);

  const plain = drift.get('drift');
  if (plain) {
    findings.push({
      ruleId: 'observed-drift',
      severity: plain.dangerous ? escalate('warning', input.critical) : 'info',
      title: `${input.label} does not run the way it is drawn`,
      detail:
        `Drawn vs running: ${describe(plain.deltas, (d) => `${fmt(d, d.declared)} vs ${fmt(d, d.observed)}`)}. ` +
        `Findings here use the running values.`,
      ...cite,
      observed: true,
      deltas: plain.deltas,
      fix: 'accept-observed',
    });
  }

  const accident = drift.get('unapproved-drift');
  if (accident) {
    findings.push({
      ruleId: 'observed-drift',
      severity: accident.dangerous ? 'error' : 'warning',
      title: `${input.label} drifted from the approved design`,
      detail:
        `Approved: ${describe(accident.deltas, (d) => fmt(d, d.approved))}. ` +
        `Running: ${describe(accident.deltas, (d) => fmt(d, d.observed))}. ` +
        `Nobody approved this, so treat it as an accident until someone does.`,
      ...cite,
      observed: true,
      deltas: accident.deltas,
      fix: 'accept-observed',
    });
  }

  const rollout = drift.get('rollout-pending');
  if (rollout) {
    findings.push({
      ruleId: 'observed-drift',
      severity: 'info',
      title: `Approved change to ${input.label} is not live yet`,
      detail:
        `Approved: ${describe(rollout.deltas, (d) => fmt(d, d.approved))}. ` +
        `Still running the previous value: ${describe(rollout.deltas, (d) => fmt(d, d.observed))}.`,
      ...cite,
      observed: true,
      deltas: rollout.deltas,
    });
  }

  const shipped = changes.get('shipped');
  if (shipped) {
    findings.push({
      ruleId: 'unapproved-change',
      severity: 'warning',
      title: `Unapproved change to ${input.label} is already live`,
      detail:
        `${capitalise(describe(shipped, (d) => `approved ${fmt(d, d.approved)}, now ${fmt(d, d.declared)}`))}. ` +
        `The running system matches the diagram, but nobody approved the change.`,
      ...cite,
      deltas: shipped,
      fix: 'approve',
    });
  }

  const pending = changes.get('pending');
  if (pending) {
    findings.push({
      ruleId: 'unapproved-change',
      severity: 'info',
      title: `${input.label} changed since it was approved`,
      detail:
        `${capitalise(describe(pending, (d) => `approved ${fmt(d, d.approved)}, drawn ${fmt(d, d.declared)}`))}. ` +
        `Approve it to make this the new baseline.`,
      ...cite,
      deltas: pending,
      fix: 'approve',
    });
  }

  if (!intent && input.hasBaseline) {
    findings.push({
      ruleId: 'unapproved-change',
      severity: 'info',
      title: `${input.label} is not in the approved design`,
      detail: `It was added after the baseline was approved.`,
      ...cite,
      deltas: intentFieldsFor(input.kind).map((field) => ({
        elementId: element.id,
        field,
        declared: declaredField(element, field),
      })),
      fix: 'approve',
    });
  }

  return findings;
}

function latencyFindings(
  input: RealityInput,
  nodes: ReadonlyMap<string, ArchNode>,
  edges: ReadonlyMap<string, ArchEdge>,
  labelOf: (id: string) => string,
): Finding[] {
  const findings: Finding[] = [];
  for (const [edgeId, observed] of Object.entries(input.evidence?.edges ?? {})) {
    const edge = edges.get(edgeId);
    const p99 = observed.p99Ms;
    if (!edge || p99 === undefined || edge.timeoutMs === undefined || p99 < edge.timeoutMs) continue;

    const source = labelOf(edge.source);
    const target = labelOf(edge.target);
    const retries = edge.retries ?? 0;
    const critical = nodes.get(edge.source)?.critical || nodes.get(edge.target)?.critical;

    findings.push({
      ruleId: 'timeout-below-latency',
      severity: retries > 0 ? 'error' : escalate('warning', critical),
      title: `${source} to ${target} times out in normal operation`,
      detail:
        `Observed p99 is ${formatMs(p99)} against a ${formatMs(edge.timeoutMs)} timeout, so at least 1% of ` +
        `healthy calls fail` +
        (retries > 0 ? ` and each one is retried ${retries} ${retries === 1 ? 'time' : 'times'}, adding load to ${target}` : '') +
        `. Raise the timeout above real latency, or fix the latency.`,
      nodeIds: [edge.source, edge.target],
      edgeIds: [edge.id],
      observed: true,
    });
  }
  return findings;
}

function undiagrammedFindings(
  evidence: Evidence,
  nodes: ReadonlyMap<string, ArchNode>,
  labelOf: (id: string) => string,
): Finding[] {
  return evidence.undiagrammed.map((call) => {
    const source = labelOf(call.sourceId);
    const target = labelOf(call.targetId);
    const critical = nodes.get(call.sourceId)?.critical || nodes.get(call.targetId)?.critical;
    return {
      ruleId: 'undiagrammed-dependency',
      severity: escalate('warning', critical),
      title: `${source} calls ${target}, but the diagram does not show it`,
      detail:
        `${call.source} observed this call${call.rps !== undefined ? ` at ${formatRps(call.rps)}` : ''}. ` +
        `Every rule that reasons about ${source}'s dependencies is blind to it until it is drawn.`,
      nodeIds: [call.sourceId, call.targetId],
      edgeIds: [],
      observed: true,
      ...(call.rps !== undefined ? { trafficRps: call.rps } : {}),
    };
  });
}

function staleFindings(evidence: Evidence, maxAgeMs: number): Finding[] {
  return evidence.sources
    .filter((source) => source.stale)
    .map((source) => {
      const covered = source.matchedNodeIds.length + source.matchedEdgeIds.length;
      return {
        ruleId: 'stale-evidence',
        severity: 'info',
        title: Number.isFinite(source.ageMs)
          ? `Observations from ${source.source} are ${formatAge(source.ageMs)} old`
          : `Observations from ${source.source} have no valid timestamp`,
        detail:
          `Anything older than ${formatAge(maxAgeMs)} is not applied, so the ${covered} ` +
          `${covered === 1 ? 'element' : 'elements'} it covers ${covered === 1 ? 'is' : 'are'} validated as drawn. ` +
          `Push fresh observations to keep the diagram honest.`,
        nodeIds: source.matchedNodeIds,
        edgeIds: source.matchedEdgeIds,
      };
    });
}

function observedField(observed: ObservedNode | ObservedEdge | undefined, field: string): FieldValue | undefined {
  if (!observed) return undefined;
  const raw = (observed as Record<string, unknown>)[field];
  if (raw === undefined) return undefined;
  return normalizeField(field, raw);
}

/**
 * Whether the running value is worse than the drawn one.
 *
 * Only the dangerous direction is a warning. Running more instances than drawn
 * means the diagram is out of date; running fewer means the redundancy the
 * rules were credited with does not exist.
 */
function isDangerous(field: string, declared: FieldValue, observed: FieldValue): boolean {
  switch (field) {
    case 'replicas':
      return typeof declared === 'number' && typeof observed === 'number' && observed < declared;
    case 'timeoutMs':
      return typeof declared === 'number' && (observed === null || (typeof observed === 'number' && observed > declared));
    case 'retries':
      return typeof declared === 'number' && typeof observed === 'number' && observed > declared;
    default:
      return declared === true && observed === false;
  }
}

function escalate(base: Severity, critical: boolean | undefined): Severity {
  return critical && base === 'warning' ? 'error' : base;
}

const FIELD_NAMES: Record<string, string> = {
  kind: 'kind',
  replicas: 'instances',
  critical: 'critical path',
  hasReplica: 'replica',
  hasBackup: 'backups',
  hasDlq: 'dead-letter queue',
  ref: 'runtime name',
  source: 'caller',
  target: 'callee',
  timeoutMs: 'timeout',
  retries: 'retries',
  circuitBreaker: 'circuit breaker',
  idempotent: 'idempotent consumer',
};

export function fieldName(field: string): string {
  return FIELD_NAMES[field] ?? field;
}

export function formatValue(field: string, value: FieldValue, labelOf: (id: string) => string = (id) => id): string {
  if (value === null) return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field === 'timeoutMs' && typeof value === 'number') return formatMs(value);
  if ((field === 'source' || field === 'target') && typeof value === 'string') return labelOf(value);
  return String(value);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

export function formatRps(rps: number): string {
  if (rps >= 1000) return `${(rps / 1000).toFixed(rps >= 10_000 ? 0 : 1)}k rps`;
  return `${Number.isInteger(rps) ? rps : rps.toFixed(1)} rps`;
}

export function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} days`;
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
