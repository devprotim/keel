import { describe, expect, it } from 'vitest';
import { resolveEvidence } from './evidence.js';
import {
  findingKey,
  HISTORY_RETENTION_MS,
  reconcileHistory,
  ruleStats,
  suggestNodes,
  type FindingHistory,
  type FindingLabels,
} from './tuning.js';
import type { ArchGraph, ArchNode, Finding } from './types.js';
import { validate } from './validate.js';

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({
  id,
  kind: 'service',
  label: id,
  x: 0,
  y: 0,
  w: 180,
  h: 80,
  replicas: 1,
  ...extra,
});

/** One service with one instance calling a datastore with no timeout: three findings. */
const GRAPH: ArchGraph = {
  nodes: [node('api', { replicas: 3 }), node('orders'), node('db', { kind: 'datastore', replicas: 2, hasBackup: true, hasReplica: true })],
  edges: [
    { id: 'api->orders', source: 'api', target: 'orders', kind: 'sync', timeoutMs: 500 },
    { id: 'orders->db', source: 'orders', target: 'db', kind: 'sync' },
  ],
};

const NOW = Date.parse('2026-09-29T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

describe('validate with tuning', () => {
  it('mutes a rule and overrides another one’s severity', () => {
    const plain = validate(GRAPH);
    expect(plain.findings.map((f) => `${f.ruleId}:${f.severity}`)).toContain('sync-missing-timeout:warning');
    expect(plain.findings.map((f) => f.ruleId)).toContain('spof-single-instance');

    const tuned = validate(GRAPH, {
      ruleSettings: { 'spof-single-instance': { muted: true }, 'sync-missing-timeout': { severity: 'info' } },
    });
    expect(tuned.findings.map((f) => f.ruleId)).not.toContain('spof-single-instance');
    expect(tuned.findings.find((f) => f.ruleId === 'sync-missing-timeout')?.severity).toBe('info');
    expect(tuned.score).toBeGreaterThan(plain.score);
  });

  it('dismisses findings labelled noise, and keeps those labelled real, marked', () => {
    const plain = validate(GRAPH);
    const timeout = plain.findings.find((f) => f.ruleId === 'sync-missing-timeout')!;
    const spof = plain.findings.find((f) => f.ruleId === 'spof-single-instance')!;
    const labels: FindingLabels = {
      [findingKey(spof)]: { verdict: 'noise', ruleId: spof.ruleId, by: 'ada', at: iso(0) },
      [findingKey(timeout)]: { verdict: 'real', ruleId: timeout.ruleId, by: 'ada', at: iso(0) },
    };

    const report = validate(GRAPH, { labels });
    expect(report.dismissed.map((f) => f.ruleId)).toEqual(['spof-single-instance']);
    expect(report.findings.map((f) => f.ruleId)).not.toContain('spof-single-instance');
    expect(report.findings.find((f) => f.ruleId === 'sync-missing-timeout')?.verdict).toBe('real');
    expect(report.counts.error + report.counts.warning + report.counts.info).toBe(report.findings.length);
  });
});

describe('reconcileHistory', () => {
  const finding = (ruleId: string, nodeIds: string[]): Finding => ({ ruleId, severity: 'warning', title: '', detail: '', nodeIds, edgeIds: [] });

  it('opens what started firing and resolves what stopped, touching nothing else', () => {
    const steady = finding('a', ['x']);
    const history: FindingHistory = {
      [findingKey(steady)]: { ruleId: 'a', openedAt: iso(HOUR), occurrences: 1 },
      'gone|y|': { ruleId: 'gone', openedAt: iso(2 * HOUR), occurrences: 1 },
    };
    const { set, drop } = reconcileHistory(history, [steady, finding('new', ['z'])], NOW);

    expect(drop).toEqual([]);
    expect(set).toEqual({
      'new|z|': { ruleId: 'new', openedAt: iso(0), occurrences: 1 },
      'gone|y|': { ruleId: 'gone', openedAt: iso(2 * HOUR), occurrences: 1, resolvedAt: iso(0) },
    });
  });

  it('counts a finding that comes back as a new occurrence', () => {
    const back = finding('a', ['x']);
    const history: FindingHistory = { [findingKey(back)]: { ruleId: 'a', openedAt: iso(3 * HOUR), resolvedAt: iso(HOUR), occurrences: 2 } };
    expect(reconcileHistory(history, [back], NOW).set[findingKey(back)]).toEqual({ ruleId: 'a', openedAt: iso(0), occurrences: 3 });
  });

  it('forgets resolved findings past the retention window', () => {
    const history: FindingHistory = { 'old|x|': { ruleId: 'old', openedAt: iso(HISTORY_RETENTION_MS + 2 * HOUR), resolvedAt: iso(HISTORY_RETENTION_MS + HOUR), occurrences: 1 } };
    expect(reconcileHistory(history, [], NOW).drop).toEqual(['old|x|']);
  });
});

describe('ruleStats', () => {
  it('measures firing, labels, noise rate and how long findings stayed open', () => {
    const history: FindingHistory = {
      'spof-single-instance|a|': { ruleId: 'spof-single-instance', openedAt: iso(10 * HOUR), resolvedAt: iso(8 * HOUR), occurrences: 1 },
      'spof-single-instance|b|': { ruleId: 'spof-single-instance', openedAt: iso(5 * HOUR), resolvedAt: iso(HOUR), occurrences: 1 },
      'spof-single-instance|c|': { ruleId: 'spof-single-instance', openedAt: iso(HOUR), occurrences: 1 },
      'spof-single-instance|old|': { ruleId: 'spof-single-instance', openedAt: iso(30 * 24 * HOUR), occurrences: 1 },
    };
    const labels: FindingLabels = {
      'spof-single-instance|a|': { verdict: 'noise', ruleId: 'spof-single-instance', by: 'ada', at: iso(0) },
      'spof-single-instance|b|': { verdict: 'noise', ruleId: 'spof-single-instance', by: 'ada', at: iso(0) },
      'spof-single-instance|c|': { verdict: 'real', ruleId: 'spof-single-instance', by: 'ada', at: iso(0) },
    };
    const firing = validate(GRAPH).findings;

    const spof = ruleStats(firing, labels, history, { 'spof-single-instance': { severity: 'info' } }, { now: NOW }).find(
      (s) => s.id === 'spof-single-instance',
    )!;
    expect(spof).toMatchObject({ firing: 1, fired: 3, real: 1, noise: 2, setting: { severity: 'info' }, medianOpenMs: 2 * HOUR });
    expect(spof.noiseRate).toBeCloseTo(2 / 3);
  });

  it('lists every tunable check, rules and reality checks alike', () => {
    const ids = ruleStats([], {}, {}, {}).map((s) => s.id);
    expect(ids).toHaveLength(18);
    expect(ids).toContain('orphan-node');
    expect(ids).toContain('observed-drift');
  });
});

describe('suggestNodes', () => {
  const graph: ArchGraph = {
    nodes: [node('n1', { label: 'Orders service' }), node('n2', { label: 'Catalog', ref: 'catalog' })],
    edges: [],
  };
  const suggest = (refs: string[]) =>
    suggestNodes(
      graph,
      resolveEvidence(graph, [{ source: 'kubernetes', observedAt: iso(0), nodes: refs.map((ref) => ({ ref, replicas: 1 })) }], { now: NOW }),
    );

  it('links a reported name to the box that plainly means it', () => {
    expect(suggest(['orders-svc'])).toEqual([
      { type: 'link', ref: 'orders-svc', source: 'kubernetes', nodeId: 'n1', nodeLabel: 'Orders service' },
    ]);
  });

  it('suggests adding what production runs and the diagram never drew, with a guessed kind', () => {
    expect(suggest(['payments-db', 'order-events', 'billing'])).toEqual([
      { type: 'add', ref: 'billing', source: 'kubernetes', kind: 'service', label: 'Billing' },
      { type: 'add', ref: 'order-events', source: 'kubernetes', kind: 'queue', label: 'Order events' },
      { type: 'add', ref: 'payments-db', source: 'kubernetes', kind: 'datastore', label: 'Payments db' },
    ]);
  });

  it('never offers a box that already has a runtime name', () => {
    expect(suggest(['catalog-api'])).toEqual([expect.objectContaining({ type: 'add', ref: 'catalog-api' })]);
  });
});
