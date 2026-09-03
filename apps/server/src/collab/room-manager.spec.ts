import { describe, expect, it } from 'vitest';
import { MemoryDocStore } from '../store/store.ts';
import { RoomManager } from './room-manager.ts';
import { TestClient } from './test-client.ts';

const options = (overrides: Partial<{ idleMs: number }> = {}) => ({
  persistDebounceMs: 0,
  compactAfterUpdates: 1000,
  idleMs: 20,
  ...overrides,
});

const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RoomManager', () => {
  it('returns the same room for concurrent requests', async () => {
    const manager = new RoomManager(new MemoryDocStore(), options());

    // Two clients arriving in the same tick must not each build their own
    // document; if they did, their edits would never reach each other.
    const [a, b] = await Promise.all([manager.get('r1'), manager.get('r1')]);

    expect(a).toBe(b);
    expect(manager.residentCount).toBe(1);
    await manager.closeAll();
  });

  it('keeps separate rooms independent', async () => {
    const manager = new RoomManager(new MemoryDocStore(), options());
    const first = await manager.get('r1');
    const second = await manager.get('r2');

    expect(first).not.toBe(second);
    expect(manager.residentCount).toBe(2);
    await manager.closeAll();
  });

  it('evicts a room once it has been empty past the idle window', async () => {
    const manager = new RoomManager(new MemoryDocStore(), options({ idleMs: 10 }));
    const room = await manager.get('r1');
    const client = TestClient.connect(room);

    await manager.leave('r1', client.socket);
    expect(manager.residentCount).toBe(1);

    await after(30);
    expect(manager.residentCount).toBe(0);
    await manager.closeAll();
  });

  it('reclaims a room when someone reconnects during the grace period', async () => {
    const manager = new RoomManager(new MemoryDocStore(), options({ idleMs: 50 }));
    const room = await manager.get('r1');
    const first = TestClient.connect(room);
    await manager.leave('r1', first.socket);

    // A page refresh looks exactly like a departure. Reloading the whole
    // document from storage a moment later would be pure waste.
    const reclaimed = await manager.get('r1');
    expect(reclaimed).toBe(room);

    await after(80);
    expect(manager.residentCount).toBe(1);
    await manager.closeAll();
  });

  it('does not cache a failed open', async () => {
    const store = new MemoryDocStore();
    let shouldFail = true;
    store.load = async () => {
      if (shouldFail) throw new Error('storage unavailable');
      return { snapshot: null, updates: [] };
    };

    const manager = new RoomManager(store, options());
    await expect(manager.get('r1')).rejects.toThrow('storage unavailable');

    // A transient storage failure must not poison the room for the lifetime of
    // the process.
    shouldFail = false;
    await expect(manager.get('r1')).resolves.toBeDefined();
    await manager.closeAll();
  });

  it('persists edits when the room is evicted', async () => {
    const store = new MemoryDocStore();
    const manager = new RoomManager(store, options({ idleMs: 10 }));
    const room = await manager.get('r1');
    const client = TestClient.connect(room);
    client.nodes.set('n1', { label: 'written before eviction' });

    await manager.leave('r1', client.socket);
    await after(30);

    expect(await store.exists('r1')).toBe(true);
    await manager.closeAll();
  });

  it('refuses to hand out rooms after shutdown', async () => {
    const manager = new RoomManager(new MemoryDocStore(), options());
    await manager.closeAll();

    await expect(manager.get('r1')).rejects.toThrow('closed');
  });
});
