import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDocStore } from '../store/store.ts';
import { Room } from './room.ts';
import { TestClient } from './test-client.ts';

const OPTIONS = { persistDebounceMs: 0, compactAfterUpdates: 1000 };

/** Let queued microtasks and zero-delay timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Room', () => {
  let store: MemoryDocStore;

  beforeEach(() => {
    store = new MemoryDocStore();
  });

  it('syncs an edit from one client to another', async () => {
    const room = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(room);
    const bob = TestClient.connect(room);

    alice.nodes.set('n1', { label: 'Orders API' });

    expect(bob.nodes.get('n1')).toEqual({ label: 'Orders API' });
    await room.destroy();
  });

  it('converges when two clients edit at the same time', async () => {
    const room = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(room);
    const bob = TestClient.connect(room);

    alice.nodes.set('n1', { label: 'from alice' });
    bob.nodes.set('n2', { label: 'from bob' });

    // Neither edit wins; a CRDT keeps both, and every peer agrees on the result.
    for (const client of [alice, bob]) {
      expect(client.nodes.get('n1')).toEqual({ label: 'from alice' });
      expect(client.nodes.get('n2')).toEqual({ label: 'from bob' });
    }
    expect(alice.nodes.toJSON()).toEqual(bob.nodes.toJSON());
    await room.destroy();
  });

  it('gives a late joiner the full document', async () => {
    const room = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(room);
    alice.nodes.set('n1', { label: 'existing' });

    const bob = TestClient.connect(room);

    expect(bob.nodes.get('n1')).toEqual({ label: 'existing' });
    await room.destroy();
  });

  it('propagates presence between clients', async () => {
    const room = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(room);
    const bob = TestClient.connect(room);

    alice.awareness.setLocalState({ name: 'Alice', cursor: { x: 10, y: 20 } });

    const seen = bob.peerStates().get(alice.doc.clientID);
    expect(seen).toMatchObject({ name: 'Alice' });
    await room.destroy();
  });

  it('retracts presence when a client disconnects', async () => {
    const room = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(room);
    const bob = TestClient.connect(room);
    alice.awareness.setLocalState({ name: 'Alice' });

    expect(bob.peerStates().has(alice.doc.clientID)).toBe(true);

    alice.disconnect();

    // The classic bug this guards: a departed collaborator's cursor frozen on
    // everyone else's canvas forever.
    expect(bob.peerStates().has(alice.doc.clientID)).toBe(false);
    await room.destroy();
  });

  it('does not send a client its own edits back', async () => {
    const room = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(room);

    let framesToAlice = 0;
    const originalSend = alice.socket.send.bind(alice.socket);
    Object.defineProperty(alice.socket, 'send', {
      value: (data: Uint8Array) => {
        framesToAlice += 1;
        originalSend(data);
      },
    });

    alice.nodes.set('n1', { label: 'mine' });

    expect(framesToAlice).toBe(0);
    await room.destroy();
  });

  it('survives a malformed frame from one client', async () => {
    const room = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(room);
    const bob = TestClient.connect(room);

    expect(() => room.handleMessage(alice.socket, new Uint8Array([0, 255, 255, 255]))).not.toThrow();

    // The room keeps working for everyone else.
    bob.nodes.set('n1', { label: 'still working' });
    expect(alice.nodes.get('n1')).toEqual({ label: 'still working' });
    await room.destroy();
  });

  it('ignores a frame on an unknown channel rather than dropping the client', async () => {
    const room = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(room);

    room.handleMessage(alice.socket, new Uint8Array([99, 1, 2, 3]));

    expect(alice.socket.open).toBe(true);
    await room.destroy();
  });
});

describe('Room persistence', () => {
  let store: MemoryDocStore;

  beforeEach(() => {
    store = new MemoryDocStore();
  });

  it('restores a document after every client has left', async () => {
    const first = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(first);
    alice.nodes.set('n1', { label: 'persisted' });
    await first.destroy();

    const reopened = await Room.open('r1', store, OPTIONS);
    const bob = TestClient.connect(reopened);

    expect(bob.nodes.get('n1')).toEqual({ label: 'persisted' });
    await reopened.destroy();
  });

  it('does not re-persist history when loading', async () => {
    const first = await Room.open('r1', store, OPTIONS);
    const alice = TestClient.connect(first);
    alice.nodes.set('n1', { label: 'a' });
    await first.destroy();

    const before = (await store.load('r1')).updates.length;

    // Opening and closing without edits must not grow the log; otherwise every
    // page load would permanently inflate the document's storage.
    const second = await Room.open('r1', store, OPTIONS);
    await second.destroy();

    expect((await store.load('r1')).updates.length).toBe(before);
  });

  it('compacts the update log into a snapshot', async () => {
    const room = await Room.open('r1', store, { persistDebounceMs: 0, compactAfterUpdates: 3 });
    const alice = TestClient.connect(room);

    for (let i = 0; i < 5; i++) {
      alice.nodes.set(`n${i}`, { label: `node ${i}` });
      await settle();
      await room.flush();
    }

    const stored = await store.load('r1');
    expect(stored.snapshot).not.toBeNull();
    expect(stored.updates.length).toBeLessThan(5);
    await room.destroy();
  });

  it('keeps pending updates when a write fails, so nothing is lost', async () => {
    const failing = new MemoryDocStore();
    let shouldFail = true;
    failing.appendUpdate = async () => {
      if (shouldFail) throw new Error('database is down');
    };

    const room = await Room.open('r1', failing, OPTIONS);
    const alice = TestClient.connect(room);
    alice.nodes.set('n1', { label: 'important' });

    await expect(room.flush()).rejects.toThrow('database is down');

    // The next flush must retry the same work rather than skip it.
    const written: Uint8Array[] = [];
    shouldFail = false;
    failing.appendUpdate = async (_room, update) => {
      written.push(update);
    };

    await room.flush();
    expect(written).toHaveLength(1);
    await room.destroy();
  });
});
