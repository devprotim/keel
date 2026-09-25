import { describe, expect, it } from 'vitest';
import { resolveEvidence, type ObservationSet } from './evidence.js';
import { createEdge, createNode } from './factory.js';
import { approveElement, hasUnapprovedChanges, type DesignIntent } from './intent.js';
import type { ArchEdge, ArchGraph, ArchNode } from './types.js';
import { validate } from './validate.js';

function node(id: string, overrides: Partial<ArchNode> = {}): ArchNode {
  return { ...createNode(overrides.kind ?? 'service', 0, 0), id, label: id, ref: id, ...overrides };
}

function edge(source: string, target: string, overrides: Partial<ArchEdge> = {}): ArchEdge {
  return { ...createEdge(source, target), id: `${source}->${target}`, ...overrides };
}

const NOW = Date.parse('2026-09-25T12:00:00Z');
const FRESH = '2026-09-25T11:55:00Z';

function observed(partial: Partial<ObservationSet>): ObservationSet {
  return { source: 'kubernetes', observedAt: FRESH, nodes: [], edges: [], ...partial };
}

/** A tidy design: redundancy, timeouts, backups all declared. */
const GRAPH: ArchGraph = {
  nodes: [
    node('api', { kind: 'gateway', replicas: 2 }),
    node('orders', { replicas: 3 }),
    node('db', { kind: 'datastore', replicas: 2, hasReplica: true, hasBackup: true }),
  ],
  edges: [edge('api', 'orders', { timeoutMs: 500, retries: 3 }), edge('orders', 'db', { timeoutMs: 500 })],
};

function approveAll(graph: ArchGraph, by = 'ada', at = '2026-09-01T00:00:00Z', previous: DesignIntent = {}): DesignIntent {
  const intent: DesignIntent = { ...previous };
  for (const n of graph.nodes) intent[n.id] = approveElement(n, 'node', intent[n.id], { by, at });
  for (const e of graph.edges) intent[e.id] = approveElement(e, 'edge', intent[e.id], { by, at });
  return intent;
}

const ruleIds = (report: ReturnType<typeof validate>): string[] => report.findings.map((f) => f.ruleId);

describe('without observations', () => {
  it('behaves exactly as before', () => {
    const report = validate(GRAPH);
    expect(report.evidence).toBeUndefined();
    expect(report.findings.every((f) => f.observed === undefined && f.trafficRps === undefined)).toBe(true);
  });
});

describe('gap 1: wrong numbers are caught', () => {
  it('flags a timeout that is really longer than drawn', () => {
    const report = validate(GRAPH, {
      now: NOW,
      observations: [observed({ edges: [{ source: 'orders', target: 'db', timeoutMs: 4000 }] })],
    });

    const drift = report.findings.find((f) => f.ruleId === 'observed-drift');
    expect(drift).toMatchObject({ severity: 'warning', edgeIds: ['orders->db'], observed: true });
    expect(drift?.detail).toContain('timeout 500ms vs 4s');
    expect(drift?.deltas).toEqual([{ elementId: 'orders->db', field: 'timeoutMs', declared: 500, observed: 4000 }]);
  });

  it('flags a timeout below real latency, as an error when retries amplify it', () => {
    const report = validate(GRAPH, {
      now: NOW,
      observations: [observed({ edges: [{ source: 'api', target: 'orders', p99Ms: 1200 }] })],
    });

    expect(report.findings.find((f) => f.ruleId === 'timeout-below-latency')).toMatchObject({
      severity: 'error',
      edgeIds: ['api->orders'],
    });
  });

  it('treats an observed missing timeout as the real flaw it is', () => {
    const report = validate(GRAPH, {
      now: NOW,
      observations: [observed({ edges: [{ source: 'orders', target: 'db', timeoutMs: null }] })],
    });

    const missing = report.findings.find((f) => f.ruleId === 'sync-missing-timeout');
    expect(missing).toMatchObject({ edgeIds: ['orders->db'], observed: true });
  });

  it('keeps benign drift quiet', () => {
    const report = validate(GRAPH, {
      now: NOW,
      observations: [observed({ nodes: [{ ref: 'orders', replicas: 6 }] })],
    });
    expect(report.findings.find((f) => f.ruleId === 'observed-drift')?.severity).toBe('info');
  });
});

describe('gap 2: stale declarations cannot hide problems', () => {
  it('fires retry-storm when the box says 3 but production runs 1', () => {
    const declaredOnly = validate(GRAPH, { now: NOW });
    expect(ruleIds(declaredOnly)).not.toContain('retry-storm');

    const report = validate(GRAPH, {
      now: NOW,
      observations: [observed({ nodes: [{ ref: 'orders', replicas: 1 }] })],
    });

    expect(report.findings.find((f) => f.ruleId === 'retry-storm')).toMatchObject({ observed: true });
    expect(report.findings.find((f) => f.ruleId === 'spof-single-instance')).toMatchObject({ observed: true });
  });

  it('matches observations by ref, not by label', () => {
    const graph: ArchGraph = { nodes: [node('n_1', { label: 'Orders', ref: 'orders-svc', replicas: 3 })], edges: [] };
    const evidence = resolveEvidence(graph, [observed({ nodes: [{ ref: 'orders-svc', replicas: 1 }, { ref: 'ghost', replicas: 2 }] })], { now: NOW });
    expect(evidence.nodes['n_1']).toEqual({ replicas: 1 });
    expect(evidence.sources[0]?.unmatchedRefs).toEqual(['ghost']);
  });

  it('stops applying observations past the freshness window, and says so', () => {
    const report = validate(GRAPH, {
      now: NOW,
      observations: [observed({ observedAt: '2026-09-20T00:00:00Z', nodes: [{ ref: 'orders', replicas: 1 }] })],
    });

    expect(ruleIds(report)).not.toContain('retry-storm');
    expect(report.findings.find((f) => f.ruleId === 'stale-evidence')).toMatchObject({ nodeIds: ['orders'] });
  });

  it('lets the freshest source win per field', () => {
    const evidence = resolveEvidence(
      GRAPH,
      [
        observed({ source: 'b', observedAt: '2026-09-25T11:59:00Z', nodes: [{ ref: 'orders', replicas: 4 }] }),
        observed({ source: 'a', observedAt: '2026-09-25T11:00:00Z', nodes: [{ ref: 'orders', replicas: 1, rps: 10 }] }),
      ],
      { now: NOW },
    );
    expect(evidence.nodes['orders']).toEqual({ replicas: 4, rps: 10 });
  });
});

describe('gap 3: traffic decides what matters', () => {
  const graph: ArchGraph = {
    nodes: [
      node('checkout'),
      node('legacy'),
      node('payments', { kind: 'external' }),
      node('fax', { kind: 'external' }),
    ],
    edges: [edge('checkout', 'payments', { timeoutMs: 1000 }), edge('legacy', 'fax', { timeoutMs: 1000 })],
  };
  const traffic = observed({
    source: 'otel',
    edges: [
      { source: 'checkout', target: 'payments', rps: 900 },
      { source: 'legacy', target: 'fax', rps: 0 },
    ],
    nodes: [
      { ref: 'checkout', rps: 900 },
      { ref: 'legacy', rps: 0 },
    ],
  });

  it('escalates the hot path and demotes the dead one', () => {
    const report = validate(graph, { now: NOW, observations: [traffic] });
    const breaker = report.findings.filter((f) => f.ruleId === 'external-no-circuit-breaker');

    expect(breaker.find((f) => f.edgeIds[0] === 'checkout->payments')).toMatchObject({ severity: 'error', trafficRps: 900 });
    expect(breaker.find((f) => f.edgeIds[0] === 'legacy->fax')).toMatchObject({ severity: 'info', trafficRps: 0 });
  });

  it('orders busy findings ahead of dead ones within a severity', () => {
    const report = validate(graph, { now: NOW, observations: [traffic] });
    const infos = report.findings.filter((f) => f.severity === 'info' && f.trafficRps !== undefined);
    expect(infos.at(-1)?.trafficRps).toBe(0);
  });

  it('never demotes a component the author marked critical, such as a failover path', () => {
    const failover: ArchGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'legacy' ? { ...n, critical: true } : n)),
    };
    const report = validate(failover, { now: NOW, observations: [traffic] });
    const dead = report.findings.find((f) => f.ruleId === 'external-no-circuit-breaker' && f.edgeIds[0] === 'legacy->fax');
    expect(dead?.severity).toBe('error');
  });
});

describe('gap 4: the running system keeps the diagram current', () => {
  it('reports a call production makes that nobody drew', () => {
    const report = validate(GRAPH, {
      now: NOW,
      observations: [observed({ edges: [{ source: 'api', target: 'db', rps: 40 }] })],
    });
    expect(report.findings.find((f) => f.ruleId === 'undiagrammed-dependency')).toMatchObject({
      nodeIds: ['api', 'db'],
      trafficRps: 40,
    });
  });

  it('ignores an observed pair that carries no traffic', () => {
    const report = validate(GRAPH, {
      now: NOW,
      observations: [observed({ edges: [{ source: 'api', target: 'db', rps: 0 }] })],
    });
    expect(ruleIds(report)).not.toContain('undiagrammed-dependency');
  });
});

describe('gap 5: intent separates approved changes from accidents', () => {
  const baseline = approveAll(GRAPH);
  const scaledDown = observed({ nodes: [{ ref: 'orders', replicas: 1 }] });

  it('calls drift from an approved design an accident', () => {
    const report = validate(GRAPH, { now: NOW, intent: baseline, observations: [scaledDown] });
    const drift = report.findings.find((f) => f.ruleId === 'observed-drift');
    expect(drift).toMatchObject({ severity: 'error', title: 'orders drifted from the approved design' });
    expect(drift?.deltas?.[0]).toMatchObject({ declared: 3, observed: 1, approved: 3 });
  });

  it('calls it a pending rollout once the change is approved', () => {
    // Someone approves scaling orders from 1 to 3; production still runs 1.
    const before = { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === 'orders' ? { ...n, replicas: 1 } : n)) };
    const intent = approveAll(GRAPH, 'grace', '2026-09-20T00:00:00Z', approveAll(before));

    const report = validate(GRAPH, { now: NOW, intent, observations: [scaledDown] });
    const drift = report.findings.find((f) => f.ruleId === 'observed-drift');
    expect(drift).toMatchObject({ severity: 'info', title: 'Approved change to orders is not live yet' });
  });

  it('flags an edit to the diagram that nobody approved', () => {
    const edited = { ...GRAPH, edges: GRAPH.edges.map((e) => (e.id === 'orders->db' ? { ...e, timeoutMs: 9000 } : e)) };
    const report = validate(edited, { now: NOW, intent: baseline });
    expect(report.findings.find((f) => f.ruleId === 'unapproved-change')).toMatchObject({
      severity: 'info',
      edgeIds: ['orders->db'],
    });
  });

  it('warns when an unapproved change is already live', () => {
    const edited = { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === 'orders' ? { ...n, replicas: 1 } : n)) };
    const report = validate(edited, { now: NOW, intent: baseline, observations: [scaledDown] });
    const change = report.findings.find((f) => f.ruleId === 'unapproved-change');
    expect(change).toMatchObject({ severity: 'warning', title: 'Unapproved change to orders is already live' });
    expect(report.findings.some((f) => f.ruleId === 'observed-drift')).toBe(false);
  });

  it('reports additions and removals against the baseline', () => {
    const changed: ArchGraph = {
      nodes: [...GRAPH.nodes.filter((n) => n.id !== 'api'), node('cache', { kind: 'cache' })],
      edges: GRAPH.edges.filter((e) => e.source !== 'api'),
    };
    const titles = validate(changed, { now: NOW, intent: baseline })
      .findings.filter((f) => f.ruleId === 'unapproved-change')
      .map((f) => f.title);

    expect(titles).toContain('cache is not in the approved design');
    expect(titles).toContain('api was removed from the approved design');
  });

  it('is silent when nothing has been approved yet, and once everything is', () => {
    expect(ruleIds(validate(GRAPH, { now: NOW }))).not.toContain('unapproved-change');
    expect(ruleIds(validate(GRAPH, { now: NOW, intent: baseline }))).not.toContain('unapproved-change');
    expect(hasUnapprovedChanges(GRAPH, baseline)).toBe(false);
    expect(hasUnapprovedChanges(GRAPH, {})).toBe(true);
  });

  it('does not treat a cleared checkbox as a change', () => {
    const intent = approveAll(GRAPH);
    const cleared = { ...GRAPH, nodes: GRAPH.nodes.map((n) => ({ ...n, critical: false })) };
    expect(hasUnapprovedChanges(cleared, intent)).toBe(false);
  });

  it('keeps the previous value only when an approval changes something', () => {
    const first = approveElement(node('a', { replicas: 1 }), 'node', undefined, { by: 'ada', at: 't1' });
    const second = approveElement(node('a', { replicas: 3 }), 'node', first, { by: 'grace', at: 't2' });
    const again = approveElement(node('a', { replicas: 3 }), 'node', second, { by: 'lin', at: 't3' });

    expect(second.fields['replicas']).toEqual({ value: 3, previous: 1, by: 'grace', at: 't2' });
    expect(again.fields['replicas']).toEqual(second.fields['replicas']);
  });
});

it('can mute reality checks by id like any rule', () => {
  const report = validate(GRAPH, {
    now: NOW,
    disabledRuleIds: ['observed-drift'],
    observations: [observed({ nodes: [{ ref: 'orders', replicas: 1 }] })],
  });
  expect(ruleIds(report)).not.toContain('observed-drift');
});
