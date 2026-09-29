import { describe, expect, it } from 'vitest';
import { resolveEvidence, type ObservationSet } from './evidence.js';
import { buildTimeline, diffObservationSets, incidentView, MAX_EVENTS_PER_PUSH, readObservationEvent } from './incident.js';
import { approveElement } from './intent.js';
import type { ArchEdge, ArchGraph, ArchNode } from './types.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({
  id,
  kind: 'service',
  label: id[0]!.toUpperCase() + id.slice(1),
  x: 0,
  y: 0,
  w: 180,
  h: 80,
  replicas: 3,
  ref: id,
  ...extra,
});
const edge = (source: string, target: string, extra: Partial<ArchEdge> = {}): ArchEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  kind: 'sync',
  timeoutMs: 1000,
  ...extra,
});

/** web -> api -> orders -> db, and api -> search (async). */
const GRAPH: ArchGraph = {
  nodes: [node('web'), node('api'), node('orders'), node('db', { kind: 'datastore', replicas: 2 }), node('search')],
  edges: [edge('web', 'api'), edge('api', 'orders'), edge('orders', 'db'), edge('api', 'search', { kind: 'async' })],
};

function view(set: Omit<ObservationSet, 'source' | 'observedAt'>, graph = GRAPH) {
  const evidence = resolveEvidence(graph, [{ source: 'k8s', observedAt: at(1), ...set }], { now: NOW });
  return incidentView(graph, evidence);
}

describe('incidentView', () => {
  it('knows nothing without observations', () => {
    const result = incidentView(GRAPH, null);
    expect(result.noData).toBe(true);
    expect(result.lookFirst).toEqual([]);
    expect(result.byId['api']?.health).toBe('unknown');
  });

  it('calls a component with no ready instances down, and names everything waiting on it', () => {
    const result = view({ nodes: [{ ref: 'db', replicas: 0 }, { ref: 'api', replicas: 3 }] });

    expect(result.byId['db']).toMatchObject({
      health: 'down',
      reasons: ['No ready instances (2 declared)'],
      ready: { observed: 0, declared: 2 },
      affects: ['Api', 'Orders', 'Web'],
    });
    expect(result.byId['api']?.health).toBe('healthy');
    expect(result.byId['search']?.health).toBe('unknown');
    expect(result.lookFirst.map((r) => r.id)).toEqual(['db']);
  });

  it('degrades on missing instances, errors, and latency close to the timeout', () => {
    const result = view({
      nodes: [{ ref: 'orders', replicas: 1, errorRate: 0.08 }],
      edges: [{ source: 'web', target: 'api', p99Ms: 850 }],
    });

    expect(result.byId['orders']).toMatchObject({
      health: 'degraded',
      reasons: ['1 of 3 instances ready', '8% of requests failing'],
    });
    expect(result.byId['web->api']).toMatchObject({
      health: 'degraded',
      reasons: ['p99 850 ms is close to the 1000 ms timeout'],
      affects: ['Web'],
    });
  });

  it('ranks down first, then by how much depends on it', () => {
    const result = view({
      nodes: [
        { ref: 'search', replicas: 0 },
        { ref: 'orders', replicas: 2 },
        { ref: 'db', errorRate: 0.1 },
      ],
    });
    // search is down but nothing waits on it (async); db and orders degrade the whole chain.
    expect(result.lookFirst.map((r) => r.id)).toEqual(['search', 'db', 'orders']);
  });

  it('folds a call that fails only because its target is down into the target', () => {
    const result = view({
      nodes: [{ ref: 'db', replicas: 0 }],
      edges: [{ source: 'orders', target: 'db', errorRate: 1 }],
    });
    expect(result.byId['orders->db']?.health).toBe('down');
    expect(result.lookFirst.map((r) => r.id)).toEqual(['db']);
  });

  it('keeps a slow call as its own entry even when its target is struggling', () => {
    const result = view({
      nodes: [{ ref: 'db', errorRate: 0.2 }],
      edges: [{ source: 'orders', target: 'db', p99Ms: 1500 }],
    });
    expect(result.lookFirst.map((r) => r.id)).toEqual(['db', 'orders->db']);
    expect(result.byId['orders->db']?.reasons).toEqual(['p99 1500 ms is at or past the 1000 ms timeout']);
  });

  it('stays fast at the largest graph the server accepts', () => {
    const nodes = Array.from({ length: 500 }, (_, i) => node(`n${i}`));
    const edges = Array.from({ length: 1500 }, (_, i) => edge(`n${i % 500}`, `n${(i * 7 + 1) % 500}`, { id: `e${i}` }));
    const graph = { nodes, edges };
    const set: ObservationSet = {
      source: 'k8s',
      observedAt: at(1),
      nodes: nodes.map((n, i) => ({ ref: n.id, replicas: i % 10 === 0 ? 0 : 3, rps: i, errorRate: i % 7 === 0 ? 0.2 : 0 })),
      edges: edges.map((e) => ({ source: e.source, target: e.target, p99Ms: 900, rps: 5 })),
    };
    const evidence = resolveEvidence(graph, [set], { now: NOW });

    const started = performance.now();
    const result = incidentView(graph, evidence);
    const elapsed = performance.now() - started;

    expect(result.lookFirst.length).toBeGreaterThan(0);
    // Recomputed on every push and every edit while incident mode is open.
    expect(elapsed).toBeLessThan(250);
  });
});

describe('diffObservationSets', () => {
  const set = (minutesAgo: number, rest: Omit<ObservationSet, 'source' | 'observedAt'>): ObservationSet => ({
    source: 'k8s',
    observedAt: at(minutesAgo),
    ...rest,
  });

  it('marks a source reporting for the first time', () => {
    expect(diffObservationSets(null, set(0, {}))).toEqual([
      { at: at(0), source: 'k8s', kind: 'source', ref: '', field: 'present', from: false, to: true },
    ]);
  });

  it('records discrete changes, appearances and disappearances, not wobble', () => {
    const before = set(5, {
      nodes: [{ ref: 'api', replicas: 3, rps: 100, errorRate: 0.01 }, { ref: 'old', replicas: 1 }],
      edges: [{ source: 'api', target: 'db', timeoutMs: 500, p99Ms: 40 }],
    });
    const after = set(0, {
      nodes: [{ ref: 'api', replicas: 1, rps: 180, errorRate: 0.2 }, { ref: 'new', replicas: 2 }],
      edges: [{ source: 'api', target: 'db', timeoutMs: null, p99Ms: 90 }],
    });

    const events = diffObservationSets(before, after).map((e) => [e.kind, e.ref, e.field, e.from, e.to]);
    expect(events).toEqual([
      ['node', 'api', 'replicas', 3, 1],
      ['node', 'api', 'errorRate', 0.01, 0.2],
      ['node', 'new', 'present', false, true],
      ['node', 'old', 'present', true, false],
      ['edge', 'api', 'timeoutMs', 500, null],
    ]);
  });

  it('caps what one push can add', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `s${i}`, replicas: 1 }));
    expect(diffObservationSets(set(1, {}), set(0, { nodes: many(200) }))).toHaveLength(MAX_EVENTS_PER_PUSH);
  });

  it('reads back only well-formed stored events', () => {
    expect(readObservationEvent({ at: at(0), source: 'k8s', kind: 'node', ref: 'a', field: 'replicas', from: 3, to: 1 })).toEqual({
      at: at(0),
      source: 'k8s',
      kind: 'node',
      ref: 'a',
      field: 'replicas',
      from: 3,
      to: 1,
    });
    expect(readObservationEvent({ at: at(0), kind: 'node' })).toBeNull();
    expect(readObservationEvent('junk')).toBeNull();
  });
});

describe('buildTimeline', () => {
  it('interleaves what the system did with what was approved, newest first, within the window', () => {
    const approved = approveElement(GRAPH.edges[1]!, 'edge', undefined, { by: 'ada', at: at(300), label: 'Api to Orders' });
    const changed = approveElement({ ...GRAPH.edges[1]!, retries: 0, timeoutMs: 200 }, 'edge', approved, {
      by: 'grace',
      at: at(30),
      label: 'Api to Orders',
    });

    const timeline = buildTimeline(
      GRAPH,
      [
        { at: at(10), source: 'k8s', kind: 'node', ref: 'orders', field: 'replicas', from: 3, to: 1 },
        { at: at(5), source: 'otel', kind: 'edge', ref: 'api', target: 'orders', field: 'errorRate', from: 0, to: 0.3 },
        { at: at(60 * 48), source: 'k8s', kind: 'node', ref: 'db', field: 'replicas', from: 2, to: 1 },
      ],
      { 'api->orders': changed },
      { now: NOW },
    );

    expect(timeline.map((e) => [e.kind, e.text, e.elementId])).toEqual([
      ['observed', 'Api to Orders: errors rose to 30%', 'api->orders'],
      ['observed', 'Orders: Instances 3 → 1', 'orders'],
      ['approved', 'grace approved Api to Orders: Timeout 1000 ms → 200 ms', 'api->orders'],
    ]);
  });
});
