import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Room } from '../collab/room.ts';
import { TestClient } from '../collab/test-client.ts';
import { MIGRATIONS, migrate } from './migrations.ts';
import { fromPGlite } from './pglite.ts';
import { PostgresDocStore } from './postgres-store.ts';
import { fromPgPool, type SqlDatabase, type SqlExecutor } from './sql.ts';
import { describeDocStoreContract, rebuild } from './store.contract.ts';

/**
 * One PGlite instance for the file, one schema per test. Booting a fresh
 * instance costs about a second; creating a schema costs almost nothing.
 */
const shared = new PGlite();
afterAll(() => shared.close());

let schemas = 0;
async function freshDb(): Promise<SqlDatabase> {
  const schema = `test_${++schemas}`;
  await shared.query(`CREATE SCHEMA ${schema}`);
  await shared.query(`SET search_path TO ${schema}`);
  const db = fromPGlite(shared);
  return { ...db, end: async () => void (await shared.query(`DROP SCHEMA ${schema} CASCADE`)) };
}

describeDocStoreContract('PostgresDocStore on PGlite', async () => PostgresDocStore.open(await freshDb()));

/**
 * The same contract against a real server when one is available. CI provides
 * one; locally, set TEST_DATABASE_URL to run it. Each run gets its own schema
 * so it never touches existing tables.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
describe.runIf(TEST_DATABASE_URL)('against a real Postgres server', () => {
  describeDocStoreContract('PostgresDocStore on node-postgres', async () => {
    const schema = `keel_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();

    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    const db = fromPgPool(pool);
    return PostgresDocStore.open({
      ...db,
      end: async () => {
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
        await db.end();
      },
    });
  });
});

/** A document with real history, as the room would have produced it. */
function edits(): { doc: Y.Doc; drain: () => Uint8Array[] } {
  const doc = new Y.Doc();
  const pending: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => pending.push(update));
  return { doc, drain: () => pending.splice(0) };
}

/** Make the first statement matching `pattern` throw, inside or outside a transaction. */
function failOnce(db: SqlDatabase, pattern: RegExp): SqlDatabase {
  let armed = true;
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    query: (text, params) => {
      if (armed && pattern.test(text)) {
        armed = false;
        return Promise.reject(new Error('connection reset by peer'));
      }
      return executor.query(text, params);
    },
  });
  return { ...db, ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx))) };
}

describe('PostgresDocStore', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const task of cleanup.splice(0)) await task();
  });

  it('applies migrations once, however many times it boots', async () => {
    const db = await freshDb();
    cleanup.push(() => db.end());

    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ id: number }>('SELECT id FROM schema_migrations');
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('keeps the document across a process restart', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'keel-pglite-'));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const { doc, drain } = edits();

    const first = await PostgresDocStore.open(fromPGlite(new PGlite(dataDir)));
    doc.getMap('nodes').set('orders', 'Orders API');
    for (const update of drain()) await first.appendUpdate('room-1', update);
    await first.compact('room-1', Y.encodeStateAsUpdate(doc));
    doc.getMap('nodes').set('billing', 'Billing');
    for (const update of drain()) await first.appendUpdate('room-1', update);
    await first.close();

    const second = await PostgresDocStore.open(fromPGlite(new PGlite(dataDir)));
    cleanup.push(() => second.close());
    expect(rebuild(await second.load('room-1'))).toEqual({ orders: 'Orders API', billing: 'Billing' });
    doc.destroy();
  });

  it('leaves the log intact when compaction fails partway through', async () => {
    const base = await freshDb();
    const store = await PostgresDocStore.open(failOnce(base, /^DELETE FROM room_updates/));
    cleanup.push(() => store.close());
    const { doc, drain } = edits();

    doc.getMap('nodes').set('a', 1);
    doc.getMap('nodes').set('b', 2);
    for (const update of drain()) await store.appendUpdate('r1', update);

    // The snapshot UPDATE has already run when the DELETE fails, so the
    // rollback has to undo it as well as keep the log.
    await expect(store.compact('r1', Y.encodeStateAsUpdate(doc))).rejects.toThrow('connection reset');
    const afterFailure = await store.load('r1');
    expect(afterFailure.snapshot).toBeNull();
    expect(afterFailure.updates).toHaveLength(2);

    await store.compact('r1', Y.encodeStateAsUpdate(doc));
    const afterRetry = await store.load('r1');
    expect(afterRetry.updates).toEqual([]);
    expect(rebuild(afterRetry)).toEqual({ a: 1, b: 2 });
    doc.destroy();
  });

  it('keeps an update appended after the caller encoded its snapshot', async () => {
    const store = await PostgresDocStore.open(await freshDb());
    cleanup.push(() => store.close());
    const mine = edits();
    const theirs = edits();

    mine.doc.getMap('nodes').set('mine', true);
    for (const update of mine.drain()) await store.appendUpdate('r1', update);
    const staleSnapshot = Y.encodeStateAsUpdate(mine.doc);

    // Another writer lands between encoding and compacting.
    theirs.doc.getMap('nodes').set('theirs', true);
    for (const update of theirs.drain()) await store.appendUpdate('r1', update);

    await store.compact('r1', staleSnapshot);
    expect(rebuild(await store.load('r1'))).toEqual({ mine: true, theirs: true });
    mine.doc.destroy();
    theirs.doc.destroy();
  });

  it('loses nothing when a live room hits a failed compaction', async () => {
    const base = await freshDb();
    const store = await PostgresDocStore.open(failOnce(base, /^UPDATE rooms SET snapshot/));
    cleanup.push(() => store.close());

    const room = await Room.open('live', store, { persistDebounceMs: 60_000, compactAfterUpdates: 1 });
    const alice = TestClient.connect(room);
    alice.nodes.set('n1', { label: 'Orders API' });

    // The append succeeds and the compaction fails, so the room retries the
    // batch. Re-appending an update Yjs has already seen is harmless.
    await expect(room.flush()).rejects.toThrow('connection reset');
    alice.nodes.set('n2', { label: 'Billing' });
    await room.flush();
    await room.destroy();

    const reopened = await Room.open('live', store, { persistDebounceMs: 60_000, compactAfterUpdates: 1 });
    const bob = TestClient.connect(reopened);
    expect(bob.nodes.toJSON()).toEqual({ n1: { label: 'Orders API' }, n2: { label: 'Billing' } });
    expect((await store.load('live')).updates).toEqual([]);
    await reopened.destroy();
  });
});
