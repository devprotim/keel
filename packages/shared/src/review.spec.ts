import { describe, expect, it } from 'vitest';
import { approveElement, type DesignIntent } from './intent.js';
import { formatFieldValue, restoredElement, revertPatch, reviewChanges } from './review.js';
import type { ArchEdge, ArchGraph, ArchNode } from './types.js';

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({
  id,
  kind: 'service',
  label: id.toUpperCase(),
  x: 10,
  y: 20,
  w: 180,
  h: 80,
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
const noTimeout = (e: ArchEdge): ArchEdge => {
  const copy = { ...e };
  delete copy.timeoutMs;
  return copy;
};

function approveAll(graph: ArchGraph): DesignIntent {
  const intent: DesignIntent = {};
  const at = '2026-09-29T00:00:00Z';
  for (const n of graph.nodes) intent[n.id] = approveElement(n, 'node', undefined, { by: 'ada', at });
  for (const e of graph.edges) intent[e.id] = approveElement(e, 'edge', undefined, { by: 'ada', at, label: `${e.source} to ${e.target}` });
  return intent;
}

const BASE: ArchGraph = {
  nodes: [node('api'), node('db', { kind: 'datastore', hasBackup: true })],
  edges: [edge('api->db', 'api', 'db')],
};

describe('reviewChanges', () => {
  it('has nothing to review before anything is approved', () => {
    expect(reviewChanges(BASE, {})).toEqual([]);
  });

  it('has nothing to review when the diagram matches, even after moving and renaming', () => {
    const intent = approveAll(BASE);
    const moved: ArchGraph = { ...BASE, nodes: [node('api', { x: 400, label: 'Gateway API' }), BASE.nodes[1]!] };
    expect(reviewChanges(moved, intent)).toEqual([]);
  });

  it('lists each changed field with its approved and current value', () => {
    const intent = approveAll(BASE);
    const graph: ArchGraph = {
      nodes: [node('api', { replicas: 5 }), node('db', { kind: 'datastore' })],
      edges: [noTimeout(edge('api->db', 'api', 'db', { retries: 3 }))],
    };

    const changes = reviewChanges(graph, intent);
    expect(changes.map((c) => [c.type, c.id, c.fields.map((f) => [f.field, f.approved?.value, f.current])])).toEqual([
      ['changed', 'api', [['replicas', 2, 5]]],
      ['changed', 'db', [['hasBackup', true, false]]],
      ['changed', 'api->db', [['timeoutMs', 500, null], ['retries', 0, 3]]],
    ]);
    expect(changes[0]!.fields[0]!.approved).toMatchObject({ by: 'ada' });
  });

  it('lists removals first, then additions, then changes', () => {
    const intent = approveAll(BASE);
    const graph: ArchGraph = {
      nodes: [node('api', { replicas: 1 }), node('cache', { kind: 'cache' })],
      edges: [edge('api->cache', 'api', 'cache')],
    };

    const changes = reviewChanges(graph, intent);
    expect(changes.map((c) => `${c.type}:${c.id}`)).toEqual([
      'removed:db',
      'removed:api->db',
      'added:cache',
      'added:api->cache',
      'changed:api',
    ]);
    expect(changes.find((c) => c.id === 'api->db')?.label).toBe('API to DB');
    expect(changes.find((c) => c.id === 'api->cache')?.label).toBe('API to CACHE');
  });

  it('can restore a removed edge along with the removed node it needs', () => {
    const intent = approveAll(BASE);
    const graph: ArchGraph = { nodes: [node('api')], edges: [] };
    const removedEdge = reviewChanges(graph, intent).find((c) => c.id === 'api->db');
    expect(removedEdge?.blocked).toBeUndefined();
  });

  it('refuses to restore an edge whose endpoint was never approved', () => {
    const intent = approveAll({ nodes: [node('api')], edges: [edge('api->x', 'api', 'x')] });
    const graph: ArchGraph = { nodes: [node('api')], edges: [] };
    expect(reviewChanges(graph, intent).find((c) => c.id === 'api->x')?.blocked).toMatch(/never approved/);
  });

  it('refuses to revert an edge onto a component that is gone', () => {
    const intent = approveAll(BASE);
    const graph: ArchGraph = {
      nodes: [node('api'), node('db2', { kind: 'datastore' })],
      edges: [edge('api->db', 'api', 'db2')],
    };
    const change = reviewChanges(graph, intent).find((c) => c.id === 'api->db');
    expect(change?.fields).toEqual([expect.objectContaining({ field: 'target', blocked: 'DB is no longer on the diagram.' })]);
    expect(change?.blocked).toBe('DB is no longer on the diagram.');
  });
});

describe('restoredElement', () => {
  it('rebuilds a removed node where it was, with its approved settings', () => {
    const intent = approveAll(BASE);
    expect(restoredElement('db', intent['db']!)).toEqual({
      id: 'db',
      kind: 'datastore',
      label: 'DB',
      x: 10,
      y: 20,
      w: 180,
      h: 80,
      replicas: 2,
      hasBackup: true,
    });
  });

  it('rebuilds a removed edge from its approved fields', () => {
    const intent = approveAll(BASE);
    expect(restoredElement('api->db', intent['api->db']!)).toEqual({
      id: 'api->db',
      source: 'api',
      target: 'db',
      kind: 'sync',
      timeoutMs: 500,
    });
  });

  it('still restores an approval saved before layouts were, at the origin', () => {
    const legacy = { ...approveAll(BASE)['db']! };
    delete legacy.layout;
    expect(restoredElement('db', legacy)).toMatchObject({ x: 0, y: 0, label: 'DB', hasBackup: true });
  });
});

describe('revertPatch', () => {
  it('writes approved values back in the shape the diagram stores them', () => {
    const approved = approveAll({ nodes: [], edges: [noTimeout(edge('e', 'a', 'b'))] })['e']!;
    expect(revertPatch(approved, ['timeoutMs', 'retries', 'circuitBreaker', 'kind'])).toEqual({
      timeoutMs: undefined,
      retries: undefined,
      circuitBreaker: undefined,
      kind: 'sync',
    });
  });
});

describe('formatFieldValue', () => {
  it('reads values the way the inspector shows them', () => {
    expect(formatFieldValue('timeoutMs', 500)).toBe('500 ms');
    expect(formatFieldValue('timeoutMs', null)).toBe('no timeout');
    expect(formatFieldValue('hasBackup', true)).toBe('yes');
    expect(formatFieldValue('target', 'db', (id) => id.toUpperCase())).toBe('DB');
  });
});
