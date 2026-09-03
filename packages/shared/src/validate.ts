import { graphFingerprint, indexGraph } from './graph.js';
import { RULES } from './rules.js';
import type { ArchGraph, Finding, Rule, Severity } from './types.js';

export interface ValidationReport {
  findings: Finding[];
  counts: Record<Severity, number>;
  /**
   * 0 to 100. Not a benchmark, just a legible summary of how many problems the
   * design carries relative to its size, so the number does not simply fall as
   * the diagram grows.
   */
  score: number;
  /** Fingerprint of the graph this report describes, for caching. */
  fingerprint: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const SEVERITY_WEIGHT: Record<Severity, number> = { error: 3, warning: 1, info: 0 };

export interface ValidateOptions {
  /** Rule ids the author has muted. Muted rules are not run at all. */
  disabledRuleIds?: readonly string[];
  /** Override the rule set. Used by tests to isolate a single rule. */
  rules?: readonly Rule[];
}

/**
 * Run every enabled rule over the graph.
 *
 * Rules are independent and side-effect free, so a rule that throws is contained
 * rather than allowed to take down the whole panel. In a collaborative canvas the
 * graph can be transiently malformed (a node deleted while an edge still points
 * at it), and a blank validation panel is a far worse failure than one missing
 * rule.
 */
export function validate(graph: ArchGraph, options: ValidateOptions = {}): ValidationReport {
  const disabled = new Set(options.disabledRuleIds ?? []);
  const rules = (options.rules ?? RULES).filter((rule) => !disabled.has(rule.id));
  const index = indexGraph(graph);

  const findings: Finding[] = [];
  for (const rule of rules) {
    try {
      findings.push(...rule.run(graph, index));
    } catch (error) {
      findings.push({
        ruleId: rule.id,
        severity: 'info',
        title: `Rule "${rule.name}" could not run`,
        detail: error instanceof Error ? error.message : String(error),
        nodeIds: [],
        edgeIds: [],
      });
    }
  }

  findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.ruleId.localeCompare(b.ruleId) || a.title.localeCompare(b.title);
  });

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  return { findings, counts, score: score(graph, findings), fingerprint: graphFingerprint(graph) };
}

/**
 * Penalty per unit of graph, mapped to 0..100.
 *
 * Normalising by size is the point: a 40-node system with six warnings is in
 * better shape than a 4-node one with the same six, and an absolute count would
 * claim the opposite. An empty graph scores 100 rather than dividing by zero.
 */
function score(graph: ArchGraph, findings: readonly Finding[]): number {
  const size = graph.nodes.length + graph.edges.length;
  if (size === 0) return 100;

  const penalty = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  // The divisor is tuned so roughly one error per three elements lands near zero.
  const normalised = penalty / size;
  return Math.max(0, Math.min(100, Math.round(100 - normalised * 100)));
}

/** Findings that reference a given node, for canvas highlighting. */
export function findingsForNode(report: ValidationReport, nodeId: string): Finding[] {
  return report.findings.filter((f) => f.nodeIds.includes(nodeId));
}

/** Findings that reference a given edge, for canvas highlighting. */
export function findingsForEdge(report: ValidationReport, edgeId: string): Finding[] {
  return report.findings.filter((f) => f.edgeIds.includes(edgeId));
}

/** Worst severity attached to a node, or null. Drives the badge colour. */
export function worstSeverityForNode(report: ValidationReport, nodeId: string): Severity | null {
  let worst: Severity | null = null;
  for (const finding of report.findings) {
    if (!finding.nodeIds.includes(nodeId)) continue;
    if (worst === null || SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[worst]) {
      worst = finding.severity;
    }
  }
  return worst;
}
