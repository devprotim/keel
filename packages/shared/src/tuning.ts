import type { Evidence } from './evidence.js';
import { REALITY_CHECKS } from './reality.js';
import { RULES } from './rules.js';
import type { ArchGraph, ArchNode, Finding, NodeKind, Severity } from './types.js';

/**
 * Tuning: keeping findings trusted.
 *
 * A check that fires on things nobody will fix trains people to ignore the
 * panel, and then the finding that matters is ignored with the rest. Three
 * levers, all stored in the room so every collaborator (and the server's
 * alerting) sees the same tuned result:
 *
 * - **Rule settings**: a room can raise, lower or mute a rule.
 * - **Labels**: anyone can mark a finding real or noise. Noise is dismissed
 *   (listed, not counted), and the labels are the data for deciding what
 *   counts as noise across rooms, which is a human call (PROJECT_PLAN task 10).
 * - **History**: when each finding opened and resolved, so a rule's firing
 *   rate and how long its findings stay open can be measured, not guessed.
 */

export interface RuleSetting {
  /** Replaces the rule's own severity for every finding it raises here. */
  severity?: Severity;
  /** Muted rules do not run at all. */
  muted?: boolean;
}

/** Keyed by rule id. */
export type RuleSettings = Record<string, RuleSetting>;

export type Verdict = 'real' | 'noise';

export interface FindingLabel {
  verdict: Verdict;
  /** Kept with the label, so a rule's labels still count after its findings are fixed. */
  ruleId: string;
  by: string;
  at: string;
}

/** Keyed by `findingKey`. */
export type FindingLabels = Record<string, FindingLabel>;

/**
 * A finding's identity: its rule and what it cites, never its wording, which
 * embeds labels and numbers that change between runs. Matches the alert and
 * CI keys, so a finding is the same finding everywhere.
 */
export function findingKey(finding: Pick<Finding, 'ruleId' | 'nodeIds' | 'edgeIds'>): string {
  return `${finding.ruleId}|${[...finding.nodeIds].sort().join(',')}|${[...finding.edgeIds].sort().join(',')}`;
}

/** Every check a room can tune: the 13 rules and the reality checks. */
export const TUNABLE_CHECKS: readonly { id: string; name: string; rationale: string; reality: boolean }[] = [
  ...RULES.map((rule) => ({ id: rule.id, name: rule.name, rationale: rule.rationale, reality: false })),
  ...REALITY_CHECKS.map((check) => ({ ...check, reality: true })),
];

export function mutedRuleIds(settings: RuleSettings | undefined): string[] {
  return Object.entries(settings ?? {})
    .filter(([, setting]) => setting.muted)
    .map(([id]) => id);
}

// --- History ------------------------------------------------------------------

/** One finding's life in a room. */
export interface FindingRecord {
  ruleId: string;
  /** When it last started firing. */
  openedAt: string;
  /** When it last stopped, or absent while it is firing. */
  resolvedAt?: string;
  /** How many separate times it has started firing. */
  occurrences: number;
}

/** Keyed by `findingKey`. */
export type FindingHistory = Record<string, FindingRecord>;

/** Records a room keeps. Resolved ones older than `HISTORY_RETENTION_MS` go first. */
export const MAX_HISTORY = 1000;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The writes that bring the history in line with what fires now: open what
 * started, resolve what stopped. Returns only changed records (and keys to
 * drop), so a caller writing into a shared document touches nothing that did
 * not move.
 */
export function reconcileHistory(
  history: FindingHistory,
  firing: readonly Finding[],
  now: number,
): { set: FindingHistory; drop: string[] } {
  const at = new Date(now).toISOString();
  const set: FindingHistory = {};
  const current = new Map(firing.map((f) => [findingKey(f), f]));

  for (const [key, finding] of current) {
    const record = history[key];
    if (!record) set[key] = { ruleId: finding.ruleId, openedAt: at, occurrences: 1 };
    else if (record.resolvedAt !== undefined) {
      set[key] = { ruleId: record.ruleId, openedAt: at, occurrences: record.occurrences + 1 };
    }
  }
  for (const [key, record] of Object.entries(history)) {
    if (!current.has(key) && record.resolvedAt === undefined) set[key] = { ...record, resolvedAt: at };
  }

  const resolved = Object.entries({ ...history, ...set })
    .filter(([, r]) => r.resolvedAt !== undefined)
    .sort(([, a], [, b]) => Date.parse(a.resolvedAt!) - Date.parse(b.resolvedAt!));
  const total = Object.keys({ ...history, ...set }).length;
  const drop: string[] = [];
  for (const [key, record] of resolved) {
    const old = now - Date.parse(record.resolvedAt!) > HISTORY_RETENTION_MS;
    if (!old && total - drop.length <= MAX_HISTORY) break;
    drop.push(key);
    delete set[key];
  }
  return { set, drop };
}

// --- Measurement --------------------------------------------------------------

export interface RuleStats {
  id: string;
  name: string;
  rationale: string;
  reality: boolean;
  setting: RuleSetting;
  /** Findings from this rule firing right now, dismissed ones included. */
  firing: number;
  /** Separate times any of its findings started firing in the window. */
  fired: number;
  real: number;
  noise: number;
  /** Share of labelled findings marked noise, when any are labelled. */
  noiseRate?: number;
  /** Median time a finding stayed open before it was resolved, when any were. */
  medianOpenMs?: number;
}

/**
 * Per rule: how often it fires, how people judged it, and how long its
 * findings stay open. A rule that fires constantly, is labelled noise, and
 * whose findings sit open for weeks is the one to lower or mute.
 */
export function ruleStats(
  firing: readonly Finding[],
  labels: FindingLabels,
  history: FindingHistory,
  settings: RuleSettings,
  { now = Date.now(), windowMs = 7 * 24 * 60 * 60 * 1000 }: { now?: number; windowMs?: number } = {},
): RuleStats[] {
  const since = now - windowMs;
  return TUNABLE_CHECKS.map((check) => {
    const stats: RuleStats = {
      ...check,
      setting: settings[check.id] ?? {},
      firing: firing.filter((f) => f.ruleId === check.id).length,
      fired: 0,
      real: 0,
      noise: 0,
    };

    const openFor: number[] = [];
    for (const record of Object.values(history)) {
      if (record.ruleId !== check.id) continue;
      if (Date.parse(record.openedAt) >= since) stats.fired += 1;
      if (record.resolvedAt !== undefined) openFor.push(Date.parse(record.resolvedAt) - Date.parse(record.openedAt));
    }
    for (const label of Object.values(labels)) {
      if (label.ruleId !== check.id) continue;
      stats[label.verdict] += 1;
    }

    if (stats.real + stats.noise > 0) stats.noiseRate = stats.noise / (stats.real + stats.noise);
    const valid = openFor.filter((ms) => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
    if (valid.length > 0) stats.medianOpenMs = valid[Math.floor((valid.length - 1) / 2)]!;
    return stats;
  });
}

// --- Suggested nodes ------------------------------------------------------------

export type NodeSuggestion =
  | { type: 'link'; ref: string; source: string; nodeId: string; nodeLabel: string }
  | { type: 'add'; ref: string; source: string; kind: NodeKind; label: string };

/**
 * What to do about each name the running system reports that no node carries.
 *
 * An unmatched ref is the commonest source of wrong findings: the evidence
 * that would correct a stale number never lands, and a real call shows up as
 * an undiagrammed dependency. Either a box already means that service and
 * just lacks its runtime name (link it), or production runs something the
 * diagram never drew (add it).
 */
export function suggestNodes(graph: ArchGraph, evidence: Evidence | null | undefined): NodeSuggestion[] {
  if (!evidence) return [];
  const suggestions: NodeSuggestion[] = [];
  const claimed = new Set<string>();
  const unlinked = graph.nodes.filter((n) => !n.ref?.trim());

  for (const source of evidence.sources) {
    if (source.stale) continue;
    for (const ref of source.unmatchedRefs) {
      if (suggestions.some((s) => s.ref === ref)) continue;
      const match = bestMatch(ref, unlinked.filter((n) => !claimed.has(n.id)));
      if (match) {
        claimed.add(match.id);
        suggestions.push({ type: 'link', ref, source: source.source, nodeId: match.id, nodeLabel: match.label });
      } else {
        suggestions.push({ type: 'add', ref, source: source.source, kind: guessKind(ref), label: humanize(ref) });
      }
    }
  }
  return suggestions;
}

/** Words that name a role rather than a service, so "orders-svc" and "Orders service" match. */
const FILLER = new Set(['svc', 'service', 'api', 'app', 'server', 'prod', 'production', 'v1', 'v2', 'k8s', 'deployment']);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !FILLER.has(t));
}

/** The unlinked node whose name plainly means this ref, or null when none does. */
function bestMatch(ref: string, candidates: readonly ArchNode[]): ArchNode | null {
  const want = tokens(ref).join('');
  if (!want) return null;
  let best: { node: ArchNode; score: number } | null = null;
  for (const node of candidates) {
    for (const name of [node.label, node.id]) {
      const have = tokens(name).join('');
      if (!have) continue;
      const score = have === want ? 3 : have.includes(want) || want.includes(have) ? 2 : distance(have, want) <= 2 ? 1 : 0;
      if (score > 0 && (!best || score > best.score)) best = { node, score };
    }
  }
  return best?.node ?? null;
}

function guessKind(ref: string): NodeKind {
  const name = ref.toLowerCase();
  if (/(^|[^a-z])(db|database|postgres|pg|mysql|mongo|dynamo|sql)([^a-z]|$)/.test(name)) return 'datastore';
  if (/redis|memcache|cache/.test(name)) return 'cache';
  if (/kafka|queue|rabbit|sqs|nats|pubsub|topic|events?([^a-z]|$)/.test(name)) return 'queue';
  if (/gateway|ingress|proxy|envoy|nginx/.test(name)) return 'gateway';
  if (/job|cron|worker|batch/.test(name)) return 'job';
  return 'service';
}

/** "order-events" to "Order events". */
function humanize(ref: string): string {
  const words = ref.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return ref;
  const text = words.join(' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Levenshtein distance, for catching typos between a ref and a label. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = next;
    }
  }
  return row[b.length]!;
}

// --- Reading from the document ----------------------------------------------------

const SEVERITIES = new Set<string>(['error', 'warning', 'info']);

export function readRuleSetting(value: unknown): RuleSetting | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const setting: RuleSetting = {};
  if (typeof record['severity'] === 'string' && SEVERITIES.has(record['severity'])) {
    setting.severity = record['severity'] as Severity;
  }
  if (record['muted'] === true) setting.muted = true;
  return setting;
}

export function readFindingLabel(value: unknown): FindingLabel | null {
  if (typeof value !== 'object' || value === null) return null;
  const { verdict, ruleId, by, at } = value as Record<string, unknown>;
  if ((verdict !== 'real' && verdict !== 'noise') || typeof ruleId !== 'string') return null;
  return { verdict, ruleId, by: typeof by === 'string' ? by : 'unknown', at: typeof at === 'string' ? at : '' };
}

export function readFindingRecord(value: unknown): FindingRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const { ruleId, openedAt, resolvedAt, occurrences } = value as Record<string, unknown>;
  if (typeof ruleId !== 'string' || typeof openedAt !== 'string') return null;
  const record: FindingRecord = {
    ruleId,
    openedAt,
    occurrences: typeof occurrences === 'number' && occurrences > 0 ? occurrences : 1,
  };
  if (typeof resolvedAt === 'string') record.resolvedAt = resolvedAt;
  return record;
}
