import { parseDiagram, validate, type ArchGraph, type Finding, type Severity } from '@keel/shared';

/** Which findings fail the check. `never` reports without blocking. */
export type FailOn = Severity | 'never';
/** Whether only findings this change introduces can fail it, or every finding. */
export type FailScope = 'new' | 'all';

export interface DiagramInput {
  path: string;
  /** The file at the head of the change. */
  head: string;
  /**
   * The file at the base of the change: `null` when the file is new, and
   * `undefined` when the base could not be read at all (shallow clone, push
   * event), in which case nothing can be called new or resolved.
   */
  base?: string | null;
}

export interface LocatedFinding extends Finding {
  /** 1-based line in the head file of the first cited element, when found. */
  line?: number;
}

export interface DiagramReport {
  path: string;
  /** Present when the head file could not be read; nothing else is then. */
  errors?: string[];
  nodes: number;
  edges: number;
  score: number;
  findings: LocatedFinding[];
  /** Findings present at head and absent at base. Empty when the base is unknown. */
  introduced: LocatedFinding[];
  /** Findings present at base and gone at head. */
  resolved: Finding[];
  /** False when there was no base to compare against. */
  compared: boolean;
}

export interface CheckReport {
  diagrams: DiagramReport[];
  /** The findings that fail the check under the given policy. */
  blocking: { path: string; finding: LocatedFinding }[];
  failed: boolean;
}

export interface CheckOptions {
  failOn: FailOn;
  failScope: FailScope;
  /** Rule ids to skip, as in the canvas's muted rules. */
  disabledRuleIds?: readonly string[];
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * A finding's identity across two versions of a diagram.
 *
 * Titles quote labels, so renaming a box would make every finding on it look
 * new. Rule plus cited ids is stable across a rename and changes only when the
 * problem genuinely moves.
 */
export function findingKey(finding: Finding): string {
  return [finding.ruleId, [...finding.nodeIds].sort().join(','), [...finding.edgeIds].sort().join(',')].join('|');
}

export function checkDiagrams(inputs: readonly DiagramInput[], options: CheckOptions): CheckReport {
  const diagrams = inputs.map((input) => checkOne(input, options));

  const blocking: CheckReport['blocking'] = [];
  for (const diagram of diagrams) {
    if (options.failOn === 'never') break;
    const threshold = SEVERITY_RANK[options.failOn];
    // Without a base, "new" cannot be established, so every finding counts.
    // Failing open there would let a shallow clone silence the check.
    const pool = options.failScope === 'new' && diagram.compared ? diagram.introduced : diagram.findings;
    for (const finding of pool) {
      if (SEVERITY_RANK[finding.severity] <= threshold) blocking.push({ path: diagram.path, finding });
    }
  }

  const unreadable = diagrams.some((d) => d.errors);
  return { diagrams, blocking, failed: unreadable || blocking.length > 0 };
}

function checkOne(input: DiagramInput, options: CheckOptions): DiagramReport {
  const head = parseDiagram(input.head);
  if (!head.ok) {
    return {
      path: input.path,
      errors: head.errors,
      nodes: 0,
      edges: 0,
      score: 0,
      findings: [],
      introduced: [],
      resolved: [],
      compared: false,
    };
  }

  const disabled = options.disabledRuleIds ?? [];
  const report = validate(head.graph, { intent: head.intent, disabledRuleIds: disabled });
  const findings = report.findings.map((finding) => locate(finding, head.graph, input.head));

  // A base that no longer parses is treated as absent: every current finding
  // is then new, which is the honest reading of "the old file said nothing".
  let baseFindings: Finding[] | null = null;
  if (input.base === null) baseFindings = [];
  else if (input.base !== undefined) {
    const base = parseDiagram(input.base);
    baseFindings = base.ok ? validate(base.graph, { intent: base.intent, disabledRuleIds: disabled }).findings : [];
  }

  const compared = baseFindings !== null;
  const baseKeys = new Set((baseFindings ?? []).map(findingKey));
  const headKeys = new Set(findings.map(findingKey));

  return {
    path: input.path,
    nodes: head.graph.nodes.length,
    edges: head.graph.edges.length,
    score: report.score,
    findings,
    introduced: compared ? findings.filter((f) => !baseKeys.has(findingKey(f))) : [],
    resolved: (baseFindings ?? []).filter((f) => !headKeys.has(findingKey(f))),
    compared,
  };
}

/** Point an annotation at the line where the first cited element is declared. */
function locate(finding: Finding, graph: ArchGraph, text: string): LocatedFinding {
  // An edge is the more specific citation: a missing timeout is on the call,
  // not on either end of it.
  const id = finding.edgeIds[0] ?? finding.nodeIds[0];
  if (id === undefined) return finding;
  const exists = graph.nodes.some((n) => n.id === id) || graph.edges.some((e) => e.id === id);
  if (!exists) return finding;

  const pattern = new RegExp(`"id"\\s*:\\s*${escapeRegExp(JSON.stringify(id))}`);
  const lines = text.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? finding : { ...finding, line: index + 1 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
