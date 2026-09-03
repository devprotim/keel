import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from './factory.js';
import { RULES } from './rules.js';
import { validate, worstSeverityForNode } from './validate.js';
import type { ArchEdge, ArchGraph, ArchNode, Rule } from './types.js';

function node(id: string, overrides: Partial<ArchNode> = {}): ArchNode {
  return { ...createNode(overrides.kind ?? 'service', 0, 0), id, label: id, ...overrides };
}

function edge(source: string, target: string, overrides: Partial<ArchEdge> = {}): ArchEdge {
  return { ...createEdge(source, target), id: `${source}->${target}`, ...overrides };
}

/** Run one rule in isolation so a finding cannot be attributed to the wrong rule. */
function only(ruleId: string, graph: ArchGraph) {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`no such rule: ${ruleId}`);
  return validate(graph, { rules: [rule] }).findings;
}

/** A well-formed baseline: everything a rule could ask for is already set. */
const HEALTHY: ArchGraph = {
  nodes: [
    node('api', { kind: 'gateway', replicas: 2 }),
    node('orders', { replicas: 3 }),
    node('db', { kind: 'datastore', replicas: 2, hasReplica: true, hasBackup: true }),
  ],
  edges: [
    edge('api', 'orders', { timeoutMs: 2000, retries: 1 }),
    edge('orders', 'db', { timeoutMs: 500 }),
  ],
};

describe('validate', () => {
  it('reports nothing on a healthy design', () => {
    expect(validate(HEALTHY).findings).toEqual([]);
  });

  it('scores a healthy design at 100 and an empty one at 100', () => {
    expect(validate(HEALTHY).score).toBe(100);
    expect(validate({ nodes: [], edges: [] }).score).toBe(100);
  });

  it('orders findings by severity, errors first', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b'), node('orphan')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    };
    const severities = validate(graph).findings.map((f) => f.severity);

    expect(severities[0]).toBe('error');
    expect(severities.at(-1)).toBe('info');
  });

  it('respects disabled rules', () => {
    const graph: ArchGraph = { nodes: [node('lonely')], edges: [] };

    expect(validate(graph).findings).toHaveLength(1);
    expect(validate(graph, { disabledRuleIds: ['orphan-node'] }).findings).toEqual([]);
  });

  it('contains a throwing rule rather than losing the whole report', () => {
    const exploding: Rule = {
      id: 'boom',
      name: 'Exploding rule',
      rationale: 'test fixture',
      run() {
        throw new Error('kaboom');
      },
    };
    const report = validate(HEALTHY, { rules: [exploding, ...RULES] });

    expect(report.findings.some((f) => f.ruleId === 'boom' && f.detail === 'kaboom')).toBe(true);
    // The real rules still ran.
    expect(report.counts.error).toBe(0);
  });

  it('normalises score by graph size so a big system is not punished for being big', () => {
    const small: ArchGraph = { nodes: [node('a'), node('b')], edges: [edge('a', 'b')] };
    const big: ArchGraph = {
      nodes: Array.from({ length: 20 }, (_, i) => node(`n${i}`, { replicas: 2 })),
      edges: Array.from({ length: 19 }, (_, i) => edge(`n${i}`, `n${i + 1}`)),
    };

    // Both have every sync edge missing a timeout, but the larger graph carries
    // proportionally the same problem and should not score dramatically worse.
    expect(validate(big).score).toBeGreaterThan(validate(small).score - 20);
  });
});

describe('spof-single-instance', () => {
  it('flags a single-instance node with dependents', () => {
    const graph: ArchGraph = {
      nodes: [node('a', { replicas: 2 }), node('b', { replicas: 1 })],
      edges: [edge('a', 'b')],
    };
    const findings = only('spof-single-instance', graph);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.nodeIds).toContain('b');
  });

  it('escalates to error when more than one component depends on it', () => {
    const graph: ArchGraph = {
      nodes: [node('a', { replicas: 2 }), node('b', { replicas: 2 }), node('c', { replicas: 1 })],
      edges: [edge('a', 'c'), edge('b', 'c')],
    };
    expect(only('spof-single-instance', graph)[0]!.severity).toBe('error');
  });

  it('does not flag a replicated node', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b', { replicas: 3 })],
      edges: [edge('a', 'b')],
    };
    expect(only('spof-single-instance', graph)).toEqual([]);
  });

  it('does not flag third-party systems, which are not ours to scale', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('stripe', { kind: 'external', replicas: 1 })],
      edges: [edge('a', 'stripe')],
    };
    expect(only('spof-single-instance', graph)).toEqual([]);
  });

  it('does not flag a single instance nobody calls synchronously', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('worker', { replicas: 1 })],
      edges: [edge('a', 'worker', { kind: 'async' })],
    };
    expect(only('spof-single-instance', graph)).toEqual([]);
  });
});

describe('sync-missing-timeout', () => {
  it('flags a sync edge with no timeout', () => {
    const graph: ArchGraph = { nodes: [node('a'), node('b')], edges: [edge('a', 'b')] };
    expect(only('sync-missing-timeout', graph)).toHaveLength(1);
  });

  it('ignores async edges, which do not block the caller', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b', { kind: 'async' })],
    };
    expect(only('sync-missing-timeout', graph)).toEqual([]);
  });

  it('escalates when either end is on the critical path', () => {
    const graph: ArchGraph = {
      nodes: [node('a', { critical: true }), node('b')],
      edges: [edge('a', 'b')],
    };
    expect(only('sync-missing-timeout', graph)[0]!.severity).toBe('error');
  });
});

describe('retry-without-timeout', () => {
  it('is an error, because the retry can never fire', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b', { retries: 3 })],
    };
    const findings = only('retry-without-timeout', graph);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
  });

  it('is satisfied once a timeout bounds the attempt', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b', { retries: 3, timeoutMs: 1000 })],
    };
    expect(only('retry-without-timeout', graph)).toEqual([]);
  });
});

describe('sync-cycle', () => {
  it('reports every edge in the ring so the canvas can highlight the whole loop', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
    };
    const findings = only('sync-cycle', graph);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.edgeIds.sort()).toEqual(['a->b', 'b->c', 'c->a']);
  });

  it('accepts a sync request answered by an async callback', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b'), edge('b', 'a', { kind: 'async' })],
    };
    expect(only('sync-cycle', graph)).toEqual([]);
  });
});

describe('datastore-durability', () => {
  it('is an error when both replication and backups are missing', () => {
    const graph: ArchGraph = { nodes: [node('db', { kind: 'datastore' })], edges: [] };
    const findings = only('datastore-durability', graph);

    expect(findings[0]!.severity).toBe('error');
  });

  it('still warns when only backups are missing', () => {
    const graph: ArchGraph = {
      nodes: [node('db', { kind: 'datastore', hasReplica: true })],
      edges: [],
    };
    const findings = only('datastore-durability', graph);

    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.detail).toContain('unrecoverable');
  });

  it('is quiet when the store is fully protected', () => {
    const graph: ArchGraph = {
      nodes: [node('db', { kind: 'datastore', hasReplica: true, hasBackup: true })],
      edges: [],
    };
    expect(only('datastore-durability', graph)).toEqual([]);
  });
});

describe('async-not-idempotent', () => {
  it('flags an async consumer that has not claimed idempotency', () => {
    const graph: ArchGraph = {
      nodes: [node('q', { kind: 'queue' }), node('worker')],
      edges: [edge('q', 'worker', { kind: 'async' })],
    };
    expect(only('async-not-idempotent', graph)).toHaveLength(1);
  });

  it('is quiet once the consumer is marked idempotent', () => {
    const graph: ArchGraph = {
      nodes: [node('q', { kind: 'queue' }), node('worker')],
      edges: [edge('q', 'worker', { kind: 'async', idempotent: true })],
    };
    expect(only('async-not-idempotent', graph)).toEqual([]);
  });
});

describe('shared-datastore', () => {
  it('flags a store written by two services', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b'), node('db', { kind: 'datastore' })],
      edges: [edge('a', 'db'), edge('b', 'db')],
    };
    expect(only('shared-datastore', graph)).toHaveLength(1);
  });

  it('does not flag a store with a single owner', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('db', { kind: 'datastore' })],
      edges: [edge('a', 'db')],
    };
    expect(only('shared-datastore', graph)).toEqual([]);
  });
});

describe('sync-chain-depth', () => {
  it('reports from the head of the chain only, not from every hop', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const graph: ArchGraph = {
      nodes: ids.map((id) => node(id)),
      edges: ids.slice(0, -1).map((id, i) => edge(id, ids[i + 1]!)),
    };
    const findings = only('sync-chain-depth', graph);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.nodeIds).toEqual(['a']);
  });

  it('is quiet at or below the threshold', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const graph: ArchGraph = {
      nodes: ids.map((id) => node(id)),
      edges: ids.slice(0, -1).map((id, i) => edge(id, ids[i + 1]!)),
    };
    expect(only('sync-chain-depth', graph)).toEqual([]);
  });
});

describe('retry-storm', () => {
  it('flags heavy retries into a single instance', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b', { replicas: 1 })],
      edges: [edge('a', 'b', { retries: 5, timeoutMs: 100 })],
    };
    expect(only('retry-storm', graph)).toHaveLength(1);
  });

  it('accepts heavy retries into a replicated target', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b', { replicas: 4 })],
      edges: [edge('a', 'b', { retries: 5, timeoutMs: 100 })],
    };
    expect(only('retry-storm', graph)).toEqual([]);
  });
});

describe('worstSeverityForNode', () => {
  it('returns the most severe finding touching the node', () => {
    const graph: ArchGraph = {
      nodes: [node('a'), node('b'), node('c', { replicas: 1 })],
      edges: [edge('a', 'c'), edge('b', 'c')],
    };
    const report = validate(graph);

    expect(worstSeverityForNode(report, 'c')).toBe('error');
  });

  it('returns null for a clean node', () => {
    expect(worstSeverityForNode(validate(HEALTHY), 'orders')).toBeNull();
  });
});
