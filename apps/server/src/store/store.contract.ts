import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DocStore } from './store.ts';

/**
 * The behaviour every DocStore must have, run against each implementation.
 *
 * This is what "tests run against the real in-memory implementation of the same
 * contract" means: MemoryDocStore and PostgresDocStore pass the same suite, so
 * a test that passes on one is evidence about the other.
 */
export function describeDocStoreContract(name: string, create: () => Promise<DocStore>): void {
  describe(`DocStore contract: ${name}`, () => {
    let store: DocStore;

    beforeEach(async () => {
      store = await create();
    });

    afterEach(async () => {
      await store.close();
    });

    it('loads an unknown room as empty', async () => {
      expect(await store.load('nobody-here')).toEqual({ snapshot: null, updates: [] });
      expect(await store.exists('nobody-here')).toBe(false);
    });

    it('returns appended updates in order, byte for byte', async () => {
      await store.appendUpdate('r1', new Uint8Array([1, 2, 3]));
      await store.appendUpdate('r1', new Uint8Array([4]));
      await store.appendUpdate('r1', new Uint8Array([5, 6]));

      const loaded = await store.load('r1');
      expect(loaded.snapshot).toBeNull();
      expect(loaded.updates.map((u) => [...u])).toEqual([[1, 2, 3], [4], [5, 6]]);
      expect(await store.exists('r1')).toBe(true);
    });

    it('keeps rooms apart', async () => {
      await store.appendUpdate('r1', new Uint8Array([1]));
      await store.appendUpdate('r2', new Uint8Array([2]));

      expect((await store.load('r1')).updates.map((u) => [...u])).toEqual([[1]]);
      expect((await store.load('r2')).updates.map((u) => [...u])).toEqual([[2]]);
    });

    it('compacts a real document into a snapshot and keeps appending on top', async () => {
      const doc = new Y.Doc();
      const updates: Uint8Array[] = [];
      doc.on('update', (update: Uint8Array) => updates.push(update));

      doc.getMap('nodes').set('a', 'first');
      doc.getMap('nodes').set('b', 'second');
      for (const update of updates.splice(0)) await store.appendUpdate('r1', update);

      await store.compact('r1', Y.encodeStateAsUpdate(doc));
      const compacted = await store.load('r1');
      expect(compacted.snapshot).not.toBeNull();
      expect(compacted.updates).toEqual([]);

      doc.getMap('nodes').set('c', 'after compaction');
      doc.getMap('nodes').delete('a');
      for (const update of updates.splice(0)) await store.appendUpdate('r1', update);

      expect(rebuild(await store.load('r1'))).toEqual({ b: 'second', c: 'after compaction' });
      doc.destroy();
    });

    it('treats a room that has only ever been compacted as existing', async () => {
      const doc = new Y.Doc();
      doc.getMap('nodes').set('a', 1);
      await store.compact('r1', Y.encodeStateAsUpdate(doc));

      expect(await store.exists('r1')).toBe(true);
      expect(rebuild(await store.load('r1'))).toEqual({ a: 1 });
      doc.destroy();
    });

    it('deletes a room outright and remembers that it did', async () => {
      const doc = new Y.Doc();
      doc.getMap('nodes').set('a', 1);
      await store.appendUpdate('doomed', Y.encodeStateAsUpdate(doc));
      await store.compact('doomed', Y.encodeStateAsUpdate(doc));
      await store.appendUpdate('doomed', Y.encodeStateAsUpdate(doc));
      doc.destroy();
      expect(await store.isDeleted('doomed')).toBe(false);

      await store.delete('doomed');
      expect(await store.load('doomed')).toEqual({ snapshot: null, updates: [] });
      expect(await store.exists('doomed')).toBe(false);
      expect(await store.isDeleted('doomed')).toBe(true);
      expect((await store.list()).map((r) => r.roomId)).not.toContain('doomed');
    });

    it('lists rooms newest first', async () => {
      await store.appendUpdate('older', new Uint8Array([1]));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.appendUpdate('newer', new Uint8Array([1]));

      const listed = await store.list();
      expect(listed.map((r) => r.roomId)).toEqual(['newer', 'older']);
      expect(listed[0]?.updatedAt).toBeInstanceOf(Date);
    });
  });
}

/** Replay a stored room into a fresh document and read back its node map. */
export function rebuild({ snapshot, updates }: { snapshot: Uint8Array | null; updates: Uint8Array[] }): unknown {
  const doc = new Y.Doc();
  if (snapshot) Y.applyUpdate(doc, snapshot);
  for (const update of updates) Y.applyUpdate(doc, update);
  const nodes = doc.getMap('nodes').toJSON();
  doc.destroy();
  return nodes;
}
