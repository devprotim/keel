import { serializeDiagram, type ArchEdge, type ArchNode } from '@keel/shared';
import { describe, expect, it } from 'vitest';
import { checkDiagrams, findingKey } from './check.ts';
import { COMMENT_MARKER, renderReport } from './markdown.ts';

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({
  id,
  kind: 'service',
  label: id,
  x: 0,
  y: 0,
  w: 100,
  h: 60,
  replicas: 2,
  ...extra,
});
const edge = (id: string, source: string, target: string, extra: Partial<ArchEdge> = {}): ArchEdge => ({
  id,
  source,
  target,
  kind: 'sync',
  timeoutMs: 500,
  ...extra,
});

/** A healthy pair: two replicas each, one bounded call. */
const healthy = serializeDiagram({ nodes: [node('api'), node('orders')], edges: [edge('e1', 'api', 'orders')] });
/** The same, with the call's timeout removed: exactly one new problem. */
const regressed = serializeDiagram({
  nodes: [node('api'), node('orders')],
  edges: [edge('e1', 'api', 'orders', { timeoutMs: undefined })],
});

const report = (base: string | null | undefined, head: string, failOn: 'error' | 'warning' | 'never' = 'warning') =>
  checkDiagrams([{ path: 'arch.keel.json', head, ...(base !== undefined ? { base } : {}) }], {
    failOn,
    failScope: 'new',
  });

describe('checkDiagrams', () => {
  it('reports a finding this change introduces, and fails on it', () => {
    const result = report(healthy, regressed);
    const [diagram] = result.diagrams;
    expect(diagram?.introduced.map((f) => f.ruleId)).toContain('sync-missing-timeout');
    expect(diagram?.resolved).toEqual([]);
    expect(result.failed).toBe(true);
  });

  it('reports the same finding as resolved when the change fixes it', () => {
    const result = report(regressed, healthy);
    expect(result.diagrams[0]?.resolved.map((f) => f.ruleId)).toContain('sync-missing-timeout');
    expect(result.diagrams[0]?.introduced).toEqual([]);
    expect(result.failed).toBe(false);
  });

  it('does not fail on problems that were already there', () => {
    const result = report(regressed, regressed);
    expect(result.diagrams[0]?.findings.length).toBeGreaterThan(0);
    expect(result.diagrams[0]?.introduced).toEqual([]);
    expect(result.failed).toBe(false);
  });

  it('keeps a finding the same across a rename', () => {
    const renamed = regressed.replace('"label": "orders"', '"label": "Orders API"');
    expect(report(regressed, renamed).diagrams[0]?.introduced).toEqual([]);
  });

  it('counts everything as new in a new file', () => {
    const result = report(null, regressed);
    expect(result.diagrams[0]?.introduced.length).toBe(result.diagrams[0]?.findings.length);
    expect(result.failed).toBe(true);
  });

  it('fails closed when the base cannot be read', () => {
    const result = report(undefined, regressed);
    expect(result.diagrams[0]?.compared).toBe(false);
    expect(result.failed).toBe(true);
  });

  it('never fails in report-only mode', () => {
    expect(report(healthy, regressed, 'never').failed).toBe(false);
  });

  it('fails, with reasons, on a file that is not a diagram', () => {
    const result = report(healthy, '{"nodes": "nope"}', 'never');
    expect(result.failed).toBe(true);
    expect(result.diagrams[0]?.errors?.length).toBeGreaterThan(0);
  });

  it('points each finding at the line of the element it cites', () => {
    const finding = report(healthy, regressed).diagrams[0]?.introduced.find((f) => f.ruleId === 'sync-missing-timeout');
    const lines = regressed.split('\n');
    expect(finding?.line).toBeDefined();
    const cited = finding?.edgeIds[0] ?? finding?.nodeIds[0];
    expect(lines[(finding?.line ?? 0) - 1]).toContain(`"id": "${cited}"`);
  });

  it('flags a change to a runtime field the baseline did not approve', () => {
    const intent = {
      orders: {
        kind: 'node' as const,
        label: 'orders',
        fields: { replicas: { value: 2, by: 'dev', at: '2026-09-01T00:00:00Z' } },
      },
    };
    const edges = [edge('e1', 'api', 'orders')];
    const approved = serializeDiagram({ nodes: [node('api'), node('orders')], edges }, intent);
    const scaledUp = serializeDiagram({ nodes: [node('api'), node('orders', { replicas: 3 })], edges }, intent);

    const ids = report(approved, scaledUp).diagrams[0]?.introduced.map((f) => f.ruleId);
    expect(ids).toContain('unapproved-change');
  });
});

describe('findingKey', () => {
  it('ignores the order ids are cited in', () => {
    const base = { ruleId: 'r', severity: 'error' as const, title: '', detail: '', nodeIds: ['a', 'b'], edgeIds: [] };
    expect(findingKey(base)).toBe(findingKey({ ...base, nodeIds: ['b', 'a'] }));
  });
});

describe('renderReport', () => {
  it('starts with the marker the comment upsert looks for', () => {
    const body = renderReport(report(healthy, regressed), { failOn: 'warning', failScope: 'new' });
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('New in this change');
    expect(body).toContain('sync-missing-timeout');
  });

  it('escapes diagram text so it cannot break the table or inject markup', () => {
    const hostile = serializeDiagram({
      nodes: [node('api', { label: 'a|b<img src=x>' }), node('orders')],
      edges: [edge('e1', 'api', 'orders', { timeoutMs: undefined })],
    });
    const body = renderReport(report(null, hostile), { failOn: 'never', failScope: 'new' });
    expect(body).not.toContain('<img');
    expect(body).toContain('a\\|b&lt;img');
  });
});
