import { describe, expect, it } from 'vitest';
import { parseDiagram, serializeDiagram } from './diagram-file.js';
import { createEdge, createNode } from './factory.js';
import { approveElement } from './intent.js';
import type { ArchGraph } from './types.js';

const graph: ArchGraph = {
  nodes: [
    { ...createNode('service', 0, 0), id: 'api', label: 'API', replicas: 3, ref: 'api-svc', critical: true },
    { ...createNode('datastore', 300, 0), id: 'db', label: 'DB', hasBackup: true, tech: 'Postgres 16' },
  ],
  edges: [{ ...createEdge('api', 'db'), id: 'e1', timeoutMs: 500, retries: 2, circuitBreaker: true }],
};

const parse = (value: unknown) => parseDiagram(JSON.stringify(value));
const errorsOf = (value: unknown): string[] => {
  const result = parse(value);
  if (result.ok) throw new Error('expected the file to be rejected');
  return result.errors;
};

describe('diagram file', () => {
  it('round-trips a graph and its approved baseline exactly', () => {
    const intent = { api: approveElement(graph.nodes[0]!, 'node', undefined, { by: 'ada', at: '2026-09-25T00:00:00Z' }) };
    expect(parseDiagram(serializeDiagram(graph, intent))).toEqual({ ok: true, graph, intent });
  });

  it('accepts a bare graph, as written for /api/validate', () => {
    expect(parse({ nodes: graph.nodes, edges: graph.edges })).toEqual({ ok: true, graph, intent: {} });
  });

  it('fills in presentation defaults a hand-written file leaves out', () => {
    const result = parse({ nodes: [{ id: 'a', kind: 'queue' }], edges: [] });
    expect(result).toMatchObject({ ok: true, graph: { nodes: [{ id: 'a', label: 'Untitled', x: 0, y: 0, replicas: 1 }] } });
  });

  it.each([
    ['not JSON', '{nope', 'not valid JSON'],
    ['another format', JSON.stringify({ format: 'drawio', nodes: [], edges: [] }), 'Unknown format "drawio"'],
    ['a newer version', JSON.stringify({ format: 'keel-diagram', version: 9, nodes: [], edges: [] }), 'version 9'],
    ['no arrays', JSON.stringify({ nodes: {} }), '"nodes" and "edges" arrays'],
  ])('rejects %s', (_name, text, message) => {
    const result = parseDiagram(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(' ')).toContain(message);
  });

  it('names the exact record and field that is wrong', () => {
    expect(
      errorsOf({
        nodes: [
          { id: 'a', kind: 'lambda' },
          { id: 'b', kind: 'service', replicas: -1 },
          { id: 'b', kind: 'service' },
        ],
        edges: [{ id: 'e', source: 'b', target: 'ghost', kind: 'sync', timeoutMs: 'soon' }],
      }),
    ).toEqual([
      'Component 1 ("a") has kind "lambda"; expected one of service, datastore, queue, cache, gateway, job, external.',
      'Component 2 ("b") needs a whole, non-negative "replicas".',
      'Component 3 reuses the id "b".',
      'Dependency 1 ("e") has a "timeoutMs" that is not a number.',
      'Dependency 1 points at "ghost", which is not a component in the file.',
    ]);
  });

  it('does not report an edge to a rejected component as dangling', () => {
    expect(
      errorsOf({ nodes: [{ id: 'a', kind: 'lambda' }], edges: [{ id: 'e', source: 'a', target: 'zz', kind: 'sync' }] }),
    ).toEqual([
      'Component 1 ("a") has kind "lambda"; expected one of service, datastore, queue, cache, gateway, job, external.',
      'Dependency 1 points at "zz", which is not a component in the file.',
    ]);
  });

  it('stops listing after five problems', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: 'nope' }));
    expect(errorsOf({ nodes, edges: [] })).toHaveLength(5);
  });

  it('refuses files past the server graph limits', () => {
    const nodes = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, kind: 'service' }));
    expect(errorsOf({ nodes, edges: [] })[0]).toContain('Too many components (501');
  });

  it('drops approvals for fields that are not tracked, and rejects malformed ones', () => {
    const result = parse({
      ...graph,
      intent: {
        api: { kind: 'node', label: 'API', fields: { x: { value: 1, by: 'a', at: 't' }, replicas: { value: 3, by: 'a', at: 't' } } },
      },
    });
    expect(result.ok && result.intent['api']?.fields).toEqual({ replicas: { value: 3, by: 'a', at: 't' } });

    expect(errorsOf({ ...graph, intent: { api: { kind: 'node', fields: { replicas: { value: {} } } } } })[0]).toContain(
      'malformed "replicas"',
    );
  });
});
