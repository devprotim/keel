import { createEdge, createNode } from '@keel/shared';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { GraphDoc } from './graph-doc';

/** Exchange updates in both directions, as a connected pair of peers would. */
function sync(a: GraphDoc, b: GraphDoc): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
}

const node = (id: string, overrides: Partial<ReturnType<typeof createNode>> = {}) => ({
  ...createNode('service', 0, 0),
  id,
  label: id,
  ...overrides,
});

const edge = (id: string, source: string, target: string) => ({
  ...createEdge(source, target),
  id,
});

describe('GraphDoc', () => {
  it('round-trips a node', () => {
    const doc = new GraphDoc();
    doc.addNode(node('a', { label: 'Orders', tech: 'Fastify', replicas: 3 }));

    const [read] = doc.toGraph().nodes;
    expect(read).toMatchObject({ id: 'a', label: 'Orders', tech: 'Fastify', replicas: 3 });
  });

  it('omits optional fields that were never set', () => {
    const doc = new GraphDoc();
    doc.addNode(node('a'));

    expect(doc.toGraph().nodes[0]).not.toHaveProperty('tech');
  });

  it('clears a property when patched with undefined', () => {
    // How the inspector removes an optional value such as a timeout.
    const doc = new GraphDoc();
    doc.addEdge({ ...edge('e', 'a', 'b'), timeoutMs: 500 });
    doc.updateEdge('e', { timeoutMs: undefined });

    expect(doc.toGraph().edges[0]).not.toHaveProperty('timeoutMs');
  });

  it('returns a stable order regardless of insertion order', () => {
    const first = new GraphDoc();
    first.addNode(node('z'));
    first.addNode(node('a'));

    expect(first.toGraph().nodes.map((n) => n.id)).toEqual(['a', 'z']);
  });

  it('skips a malformed record rather than failing the whole read', () => {
    // Simulates data written by an older build or a peer on a different version.
    const doc = new GraphDoc();
    doc.addNode(node('good'));
    doc.transact(() => {
      const junk = new Y.Map<unknown>();
      junk.set('id', 'bad');
      junk.set('kind', 'not-a-real-kind');
      doc.nodes.set('bad', junk);
    });

    expect(doc.toGraph().nodes.map((n) => n.id)).toEqual(['good']);
  });

  it('substitutes defaults for missing optional geometry', () => {
    const doc = new GraphDoc();
    doc.transact(() => {
      const sparse = new Y.Map<unknown>();
      sparse.set('id', 'sparse');
      sparse.set('kind', 'service');
      doc.nodes.set('sparse', sparse);
    });

    expect(doc.toGraph().nodes[0]).toMatchObject({ label: 'Untitled', x: 0, y: 0, replicas: 1 });
  });

  it('removes attached edges when a node is deleted', () => {
    const doc = new GraphDoc();
    doc.addNode(node('a'));
    doc.addNode(node('b'));
    doc.addEdge(edge('e', 'a', 'b'));

    doc.removeNodes(['a']);

    const graph = doc.toGraph();
    expect(graph.nodes.map((n) => n.id)).toEqual(['b']);
    expect(graph.edges).toEqual([]);
  });

  it('deletes a mixed selection of nodes and edges', () => {
    const doc = new GraphDoc();
    doc.addNode(node('a'));
    doc.addNode(node('b'));
    doc.addNode(node('c'));
    doc.addEdge(edge('e1', 'a', 'b'));
    doc.addEdge(edge('e2', 'b', 'c'));

    doc.removeSelection(['a', 'e2']);

    const graph = doc.toGraph();
    expect(graph.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(graph.edges).toEqual([]);
  });

  it('moves a whole selection in one transaction', () => {
    const doc = new GraphDoc();
    doc.addNode(node('a'));
    doc.addNode(node('b'));

    let transactions = 0;
    doc.doc.on('afterTransaction', () => {
      transactions += 1;
    });

    doc.moveNodes([
      { id: 'a', x: 10, y: 20 },
      { id: 'b', x: 30, y: 40 },
    ]);

    // One broadcast and one undo step for the whole drag, not one per node.
    expect(transactions).toBe(1);
    expect(doc.toGraph().nodes.map((n) => n.x)).toEqual([10, 30]);
  });

  it('notifies observers of local and remote changes', () => {
    const alice = new GraphDoc();
    const bob = new GraphDoc();
    let calls = 0;
    const stop = alice.observe(() => {
      calls += 1;
    });

    alice.addNode(node('a'));
    expect(calls).toBe(1);

    bob.addNode(node('b'));
    sync(alice, bob);
    expect(calls).toBe(2);

    stop();
    alice.addNode(node('c'));
    expect(calls).toBe(2);
  });
});

describe('GraphDoc concurrent editing', () => {
  it('merges a rename and a move of the same node', () => {
    // The scenario that justifies a Y.Map per node. With a plain object per node
    // one of these two edits would be silently discarded.
    const alice = new GraphDoc();
    alice.addNode(node('a', { label: 'Orders', x: 0, y: 0 }));

    const bob = new GraphDoc();
    sync(alice, bob);

    alice.updateNode('a', { label: 'Order Service' });
    bob.moveNodes([{ id: 'a', x: 500, y: 300 }]);
    sync(alice, bob);

    for (const peer of [alice, bob]) {
      expect(peer.toGraph().nodes[0]).toMatchObject({
        label: 'Order Service',
        x: 500,
        y: 300,
      });
    }
  });

  it('keeps both nodes when two peers add at once', () => {
    const alice = new GraphDoc();
    const bob = new GraphDoc();
    sync(alice, bob);

    alice.addNode(node('from-alice'));
    bob.addNode(node('from-bob'));
    sync(alice, bob);

    expect(alice.toGraph().nodes.map((n) => n.id)).toEqual(['from-alice', 'from-bob']);
    expect(bob.toGraph()).toEqual(alice.toGraph());
  });

  it('converges when both peers edit the same field', () => {
    const alice = new GraphDoc();
    alice.addNode(node('a'));
    const bob = new GraphDoc();
    sync(alice, bob);

    alice.updateNode('a', { label: 'Alice version' });
    bob.updateNode('a', { label: 'Bob version' });
    sync(alice, bob);

    // One of them wins; which one does not matter. What matters is that both
    // peers agree, rather than diverging permanently.
    expect(alice.toGraph()).toEqual(bob.toGraph());
    expect(['Alice version', 'Bob version']).toContain(alice.toGraph().nodes[0]!.label);
  });

  it('survives one peer deleting a node the other is connecting to', () => {
    const alice = new GraphDoc();
    alice.addNode(node('a'));
    alice.addNode(node('b'));
    const bob = new GraphDoc();
    sync(alice, bob);

    alice.removeNodes(['b']);
    bob.addEdge(edge('e', 'a', 'b'));
    sync(alice, bob);

    // The edge outlives its target. Rendering and validation both tolerate this,
    // which is why they were written to skip dangling edges rather than throw.
    expect(alice.toGraph()).toEqual(bob.toGraph());
    expect(alice.toGraph().nodes.map((n) => n.id)).toEqual(['a']);
  });
});

describe('GraphDoc undo', () => {
  it('undoes the local edit', () => {
    const doc = new GraphDoc();
    const undo = doc.createUndoManager(0);
    doc.addNode(node('a'));

    undo.undo();
    expect(doc.toGraph().nodes).toEqual([]);

    undo.redo();
    expect(doc.toGraph().nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('never undoes a collaborator’s change', () => {
    // The most disorienting bug in a shared editor: pressing Ctrl+Z and watching
    // someone else's work vanish. trackedOrigins is what prevents it.
    const alice = new GraphDoc();
    const undo = alice.createUndoManager(0);
    const bob = new GraphDoc();

    alice.addNode(node('from-alice'));
    bob.addNode(node('from-bob'));
    sync(alice, bob);

    undo.undo();

    expect(alice.toGraph().nodes.map((n) => n.id)).toEqual(['from-bob']);
  });

  it('has nothing to undo when only remote edits have arrived', () => {
    const alice = new GraphDoc();
    const undo = alice.createUndoManager(0);
    const bob = new GraphDoc();

    bob.addNode(node('from-bob'));
    sync(alice, bob);

    expect(undo.canUndo()).toBe(false);
    undo.undo();
    expect(alice.toGraph().nodes.map((n) => n.id)).toEqual(['from-bob']);
  });

  it('restores a node and its edges as a single step', () => {
    const doc = new GraphDoc();
    const undo = doc.createUndoManager(0);
    doc.addNode(node('a'));
    doc.addNode(node('b'));
    doc.addEdge(edge('e', 'a', 'b'));
    undo.stopCapturing();

    doc.removeNodes(['a']);
    expect(doc.toGraph().edges).toEqual([]);

    undo.undo();

    // One transaction in, one undo step out. The cascade must not require three
    // presses of Ctrl+Z to reverse.
    const graph = doc.toGraph();
    expect(graph.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(graph.edges.map((e) => e.id)).toEqual(['e']);
  });

  it('coalesces a drag into one undo step', () => {
    const doc = new GraphDoc();
    const undo = doc.createUndoManager();
    doc.addNode(node('a'));
    undo.stopCapturing();

    // A drag emits a move per animation frame; undoing it must not require one
    // press per frame.
    for (let i = 1; i <= 20; i++) doc.moveNodes([{ id: 'a', x: i * 5, y: 0 }]);
    undo.undo();

    expect(doc.toGraph().nodes[0]!.x).toBe(0);
  });
});

describe('GraphDoc undo, faithful to the real network path', () => {
  /**
   * y-websocket applies remote updates with the *provider instance* as the
   * transaction origin, not null. The earlier tests sync with a null origin, so
   * they would still pass if trackedOrigins were subtly wrong about objects.
   * This stands in a provider-shaped object to close that gap.
   */
  class FakeProvider {}

  function syncViaProvider(from: GraphDoc, to: GraphDoc, origin: unknown): void {
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), origin);
  }

  it('does not track updates arriving with a provider origin', () => {
    const alice = new GraphDoc();
    const undo = alice.createUndoManager(0);
    const bob = new GraphDoc();

    bob.addNode(node('from-bob'));
    syncViaProvider(bob, alice, new FakeProvider());

    expect(undo.canUndo()).toBe(false);
  });

  it('undoes only the local edit when both peers edited different nodes', () => {
    const provider = new FakeProvider();
    const alice = new GraphDoc();
    const undo = alice.createUndoManager(0);
    const bob = new GraphDoc();

    alice.addNode(node('n1', { x: 0 }));
    alice.addNode(node('n2', { x: 0 }));
    syncViaProvider(alice, bob, provider);
    undo.stopCapturing();

    alice.moveNodes([{ id: 'n1', x: 100, y: 0 }]);
    bob.moveNodes([{ id: 'n2', x: 900, y: 0 }]);
    syncViaProvider(bob, alice, provider);

    undo.undo();

    const byId = new Map(alice.toGraph().nodes.map((n) => [n.id, n]));
    expect(byId.get('n1')!.x).toBe(0); // Alice's own move, reverted.
    expect(byId.get('n2')!.x).toBe(900); // Bob's move, untouched.
  });

  it('reverses exactly one own action when a peer overwrote the same field', () => {
    // The case most likely to look like "undo hit everyone": both people drag
    // the same box.
    //
    // Yjs pops stack items until one produces a visible change, so without
    // ignoreRemoteMapChanges this single undo would find Alice's move already
    // superseded, fall through to the item before it, and delete the node she
    // created. This asserts the safe behaviour: one step, node intact.
    const provider = new FakeProvider();
    const alice = new GraphDoc();
    const undo = alice.createUndoManager(0);
    const bob = new GraphDoc();

    alice.addNode(node('shared', { x: 0 }));
    syncViaProvider(alice, bob, provider);
    undo.stopCapturing();

    alice.moveNodes([{ id: 'shared', x: 100, y: 0 }]);
    syncViaProvider(alice, bob, provider);
    bob.moveNodes([{ id: 'shared', x: 500, y: 0 }]);
    syncViaProvider(bob, alice, provider);

    undo.undo();

    const nodes = alice.toGraph().nodes;
    expect(nodes).toHaveLength(1); // The node Alice created must survive.
    expect(nodes[0]!.x).toBe(0); // Her move is reversed, one step only.
    expect(undo.undoStack).toHaveLength(1); // Exactly one item consumed.
  });

  it('propagates the undo itself to peers, which is not the same as undoing their work', () => {
    // An undo is an ordinary edit and syncs like one. Watching a box snap back
    // in the other window is correct behaviour, not a scoping failure.
    const provider = new FakeProvider();
    const alice = new GraphDoc();
    const undo = alice.createUndoManager(0);
    const bob = new GraphDoc();

    alice.addNode(node('n1', { x: 0 }));
    syncViaProvider(alice, bob, provider);
    undo.stopCapturing();

    alice.moveNodes([{ id: 'n1', x: 250, y: 0 }]);
    syncViaProvider(alice, bob, provider);
    expect(bob.toGraph().nodes[0]!.x).toBe(250);

    undo.undo();
    syncViaProvider(alice, bob, provider);

    expect(bob.toGraph().nodes[0]!.x).toBe(0);
  });
});

describe('GraphDoc evidence and intent', () => {
  const at = '2026-09-25T12:00:00Z';

  it('stores one observation set per source and replaces it on the next push', () => {
    const doc = new GraphDoc();
    doc.setObservations({ source: 'k8s', observedAt: at, nodes: [{ ref: 'a', replicas: 1 }] });
    doc.setObservations({ source: 'k8s', observedAt: at, nodes: [{ ref: 'a', replicas: 2 }] });
    doc.setObservations({ source: 'otel', observedAt: at, edges: [{ source: 'a', target: 'b', rps: 5 }] });

    const sets = doc.toObservations();
    expect(sets.map((s) => s.source)).toEqual(['k8s', 'otel']);
    expect(sets[0]?.nodes).toEqual([{ ref: 'a', replicas: 2 }]);

    doc.removeObservations('k8s');
    expect(doc.toObservations().map((s) => s.source)).toEqual(['otel']);
  });

  it('skips a malformed observation set written by someone else', () => {
    const doc = new GraphDoc();
    doc.observations.set('junk', { nope: true });
    doc.observations.set('half', { source: 'half', observedAt: at, nodes: [{ replicas: 1 }, { ref: 'ok' }] });
    expect(doc.toObservations()).toEqual([{ source: 'half', observedAt: at, nodes: [{ ref: 'ok' }], edges: [] }]);
  });

  it('approves the diagram as a baseline, and a removal drops it from the baseline', () => {
    const doc = new GraphDoc();
    doc.addNode(node('a', { replicas: 3 }));
    doc.addNode(node('b'));
    doc.addEdge({ ...edge('e', 'a', 'b'), timeoutMs: 500 });
    doc.approveAll('ada', at);

    const intent = doc.toIntent();
    expect(Object.keys(intent).sort()).toEqual(['a', 'b', 'e']);
    expect(intent['a']?.fields['replicas']).toEqual({ value: 3, by: 'ada', at });
    expect(intent['e']).toMatchObject({ kind: 'edge', label: 'a to b' });

    doc.removeSelection(['b']);
    doc.approveAll('grace', at);
    expect(Object.keys(doc.toIntent()).sort()).toEqual(['a']);
  });

  it('merges two people approving different components concurrently', () => {
    const alice = new GraphDoc();
    alice.addNode(node('a'));
    alice.addNode(node('b'));
    const bob = new GraphDoc();
    sync(alice, bob);

    alice.approve(['a'], 'alice', at);
    bob.approve(['b'], 'bob', at);
    sync(alice, bob);

    expect(alice.toIntent()['a']?.fields['kind']?.by).toBe('alice');
    expect(alice.toIntent()['b']?.fields['kind']?.by).toBe('bob');
  });

  it('accepts an observed value into both the diagram and the baseline, as one undo step', () => {
    const doc = new GraphDoc();
    doc.addNode(node('a', { replicas: 3 }));
    doc.addEdge({ ...edge('e', 'a', 'a'), timeoutMs: 500 });
    doc.approveAll('ada', at);
    const undo = doc.createUndoManager(0);

    doc.acceptObserved(
      [
        { elementId: 'a', field: 'replicas', declared: 3, observed: 1 },
        { elementId: 'e', field: 'timeoutMs', declared: 500, observed: null },
      ],
      'grace',
      at,
    );

    const graph = doc.toGraph();
    expect(graph.nodes[0]?.replicas).toBe(1);
    expect(graph.edges[0]).not.toHaveProperty('timeoutMs');
    expect(doc.toIntent()['a']?.fields['replicas']).toEqual({ value: 1, previous: 3, by: 'grace', at });
    expect(doc.toIntent()['e']?.fields['timeoutMs']).toMatchObject({ value: null, previous: 500 });

    undo.undo();
    expect(doc.toGraph().nodes[0]?.replicas).toBe(3);
    expect(doc.toIntent()['a']?.fields['replicas']).toEqual({ value: 3, by: 'ada', at });
  });

  it('imports a diagram and its baseline as one undo step', () => {
    const doc = new GraphDoc();
    const undo = doc.createUndoManager(0);
    const a = node('a', { replicas: 2 });
    doc.importDiagram(
      { nodes: [a, node('b')], edges: [edge('e', 'a', 'b')] },
      { a: { kind: 'node', label: 'a', fields: { replicas: { value: 2, by: 'ada', at } } } },
    );

    expect(doc.toGraph().nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(doc.toGraph().edges).toHaveLength(1);
    expect(doc.toIntent()['a']?.fields['replicas']).toEqual({ value: 2, by: 'ada', at });

    undo.undo();
    expect(doc.toGraph()).toEqual({ nodes: [], edges: [] });
    expect(doc.toIntent()).toEqual({});
  });

  it('round-trips a node ref', () => {
    const doc = new GraphDoc();
    doc.addNode(node('a', { ref: 'orders-svc' }));
    expect(doc.toGraph().nodes[0]?.ref).toBe('orders-svc');
  });
});

describe('GraphDoc review', () => {
  const at = '2026-09-29T12:00:00Z';

  /** a -> b -> c, approved, with a timeout on each edge. */
  function approvedChain(): GraphDoc {
    const doc = new GraphDoc();
    doc.addNode(node('a', { replicas: 3, x: 40, y: 60 }));
    doc.addNode(node('b', { kind: 'datastore', hasBackup: true, x: 300, y: 60 }));
    doc.addNode(node('c', { x: 560, y: 60 }));
    doc.addEdge({ ...edge('ab', 'a', 'b'), timeoutMs: 500 });
    doc.addEdge({ ...edge('bc', 'b', 'c'), timeoutMs: 800 });
    doc.approveAll('ada', at);
    return doc;
  }

  it('approves one field and leaves the others pending', () => {
    const doc = approvedChain();
    doc.updateNode('a', { replicas: 1, critical: true });

    doc.approve(['a'], 'grace', at, ['replicas']);

    const approved = doc.toIntent()['a']!;
    expect(approved.fields['replicas']).toEqual({ value: 1, previous: 3, by: 'grace', at });
    expect(approved.fields['critical']).toMatchObject({ value: false, by: 'ada' });
  });

  it('rejects one field, putting only that one back', () => {
    const doc = approvedChain();
    doc.updateNode('a', { replicas: 1, critical: true });

    doc.reject([{ id: 'a', fields: ['replicas'] }]);

    expect(doc.toGraph().nodes.find((n) => n.id === 'a')).toMatchObject({ replicas: 3, critical: true });
  });

  it('rejects every unapproved field when none is named, clearing what was cleared', () => {
    const doc = approvedChain();
    doc.updateNode('b', { hasBackup: undefined });
    doc.updateEdge('ab', { timeoutMs: undefined, retries: 4, circuitBreaker: true });

    doc.reject([{ id: 'b' }, { id: 'ab' }]);

    const graph = doc.toGraph();
    expect(graph.nodes.find((n) => n.id === 'b')?.hasBackup).toBe(true);
    const ab = graph.edges.find((e) => e.id === 'ab')!;
    expect(ab.timeoutMs).toBe(500);
    expect(ab).not.toHaveProperty('retries');
    expect(ab).not.toHaveProperty('circuitBreaker');
  });

  it('rejects an addition by deleting it, with its edges', () => {
    const doc = approvedChain();
    doc.addNode(node('d'));
    doc.addEdge(edge('cd', 'c', 'd'));

    doc.reject([{ id: 'd' }]);

    expect(doc.toGraph().nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(doc.toGraph().edges.map((e) => e.id)).toEqual(['ab', 'bc']);
  });

  it('rejects a deleted node by rebuilding it where it was, with the edges the delete took', () => {
    const doc = approvedChain();
    doc.removeSelection(['b']);
    expect(doc.toGraph().edges).toEqual([]);

    doc.reject([{ id: 'b' }]);

    const graph = doc.toGraph();
    expect(graph.nodes.find((n) => n.id === 'b')).toMatchObject({ kind: 'datastore', hasBackup: true, x: 300, y: 60, label: 'b' });
    expect(graph.edges.map((e) => [e.id, e.timeoutMs])).toEqual([
      ['ab', 500],
      ['bc', 800],
    ]);
  });

  it('rejects a deleted edge by bringing back the deleted node it needs', () => {
    const doc = approvedChain();
    doc.removeSelection(['c']);

    doc.reject([{ id: 'bc' }]);

    expect(doc.toGraph().nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(doc.toGraph().edges.map((e) => e.id)).toEqual(['ab', 'bc']);
  });

  it('approves a node removal together with the removals of its edges', () => {
    const doc = approvedChain();
    doc.removeSelection(['b']);

    doc.approve(['b'], 'grace', at);

    expect(Object.keys(doc.toIntent()).sort()).toEqual(['a', 'c']);
  });

  it('rejects as one undo step', () => {
    const doc = approvedChain();
    doc.removeSelection(['b']);
    const undo = doc.createUndoManager(0);

    doc.reject([{ id: 'b' }]);
    undo.undo();

    expect(doc.toGraph().nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(doc.toGraph().edges).toEqual([]);
  });

  it('never points an edge at a component that is gone', () => {
    const doc = approvedChain();
    doc.addNode(node('b2', { kind: 'datastore' }));
    doc.updateEdge('ab', { target: 'b2' });
    doc.removeSelection(['b']);

    doc.reject([{ id: 'ab', fields: ['target'] }]);

    expect(doc.toGraph().edges.find((e) => e.id === 'ab')?.target).toBe('b2');
  });

  it('keeps where an element was drawn at approval, for a later restore', () => {
    const doc = approvedChain();
    expect(doc.toIntent()['b']?.layout).toMatchObject({ label: 'b', x: 300, y: 60 });
  });
});

describe('GraphDoc events', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it('logs what a pushed observation set changed, like the server does', () => {
    const doc = new GraphDoc();
    doc.setObservations({ source: 'k8s', observedAt: at(2), nodes: [{ ref: 'a', replicas: 3 }] });
    doc.setObservations({ source: 'k8s', observedAt: at(1), nodes: [{ ref: 'a', replicas: 1 }] });

    expect(doc.toEvents().map((e) => [e.kind, e.field, e.from, e.to])).toEqual([
      ['source', 'present', false, true],
      ['node', 'replicas', 3, 1],
    ]);
  });

  it('returns the same log object until the log changes', () => {
    const doc = new GraphDoc();
    doc.setObservations({ source: 'k8s', observedAt: at(1), nodes: [] });
    const first = doc.toEvents();
    doc.addNode(node('a'));
    expect(doc.toEvents()).toBe(first);
    doc.setObservations({ source: 'otel', observedAt: at(0), nodes: [] });
    expect(doc.toEvents()).not.toBe(first);
  });

  it('drops events past the retention window', () => {
    const doc = new GraphDoc();
    doc.events.push([{ at: at(60 * 24 * 8), source: 'k8s', kind: 'node', ref: 'a', field: 'replicas', from: 1, to: 2 }]);
    doc.setObservations({ source: 'k8s', observedAt: at(0), nodes: [] });
    expect(doc.toEvents().map((e) => e.kind)).toEqual(['source']);
  });
});

describe('GraphDoc tuning', () => {
  const at = '2026-09-29T12:00:00Z';

  it('undoes a label or a rule setting like any other edit', () => {
    const doc = new GraphDoc();
    const undo = doc.createUndoManager(0);
    doc.setLabel('spof|a|', { verdict: 'noise', ruleId: 'spof', by: 'ada', at });
    doc.setRuleSetting('orphan-node', { muted: true });
    expect(doc.toLabels()).toEqual({ 'spof|a|': { verdict: 'noise', ruleId: 'spof', by: 'ada', at } });
    expect(doc.toRuleSettings()).toEqual({ 'orphan-node': { muted: true } });

    undo.undo();
    expect(doc.toRuleSettings()).toEqual({});
    undo.undo();
    expect(doc.toLabels()).toEqual({});
  });

  it('keeps finding history out of anyone’s undo stack', () => {
    const doc = new GraphDoc();
    const undo = doc.createUndoManager(0);
    doc.writeFindingHistory({ set: { 'spof|a|': { ruleId: 'spof', openedAt: at, occurrences: 1 } }, drop: [] });
    expect(undo.canUndo()).toBe(false);
    expect(doc.toFindingHistory()).toEqual({ 'spof|a|': { ruleId: 'spof', openedAt: at, occurrences: 1 } });
  });

  it('clears a rule setting that no longer says anything', () => {
    const doc = new GraphDoc();
    doc.setRuleSetting('orphan-node', { severity: 'info' });
    doc.setRuleSetting('orphan-node', {});
    expect(doc.ruleSettings.has('orphan-node')).toBe(false);
  });
});
