import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../store/migrations.ts';
import { fromPGlite } from '../store/pglite.ts';
import { AlertConfigSchema } from './config.ts';
import { MemoryAlertStore, PostgresAlertStore, type AlertStore, type RoomAlertState } from './store.ts';

const shared = new PGlite();
afterAll(() => shared.close());
let schemas = 0;

const stores: [string, () => Promise<AlertStore>][] = [
  ['memory', () => Promise.resolve(new MemoryAlertStore())],
  [
    'postgres (PGlite)',
    async () => {
      const schema = `alerts_${++schemas}`;
      await shared.query(`CREATE SCHEMA ${schema}`);
      await shared.query(`SET search_path TO ${schema}`);
      const db = fromPGlite(shared);
      await migrate(db);
      return new PostgresAlertStore(db);
    },
  ],
];

const config = AlertConfigSchema.parse({ slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/c' } });
const state: RoomAlertState = {
  'observed-drift|orders|': {
    ruleId: 'observed-drift',
    severity: 'error',
    title: 't',
    detail: 'd',
    nodeIds: ['orders'],
    edgeIds: [],
    firstSeenAt: '2026-09-28T03:00:00.000Z',
    lastSeenAt: '2026-09-28T03:05:00.000Z',
    delivered: ['slack'],
  },
};

describe.each(stores)('AlertStore contract: %s', (_name, create) => {
  let store: AlertStore;
  beforeEach(async () => {
    store = await create();
  });

  it('round-trips a config and lists the room as configured', async () => {
    expect(await store.getConfig('room-1')).toBeNull();
    await store.putConfig('room-1', config);
    expect(await store.getConfig('room-1')).toEqual(config);
    expect(await store.listConfiguredRooms()).toEqual(['room-1']);
  });

  it('replaces a config on the second put', async () => {
    await store.putConfig('room-1', config);
    const updated = { ...config, resolveAfterMinutes: 30 };
    await store.putConfig('room-1', updated);
    expect(await store.getConfig('room-1')).toEqual(updated);
  });

  it('round-trips open alerts, and forgets them with the config', async () => {
    await store.putConfig('room-1', config);
    await store.saveState('room-1', state);
    expect(await store.getState('room-1')).toEqual(state);

    await store.deleteConfig('room-1');
    expect(await store.getConfig('room-1')).toBeNull();
    expect(await store.getState('room-1')).toEqual({});
    expect(await store.listConfiguredRooms()).toEqual([]);
  });

  it('hands back copies, so a caller mutating a result cannot change what is stored', async () => {
    await store.putConfig('room-1', config);
    await store.saveState('room-1', state);
    const read = await store.getState('room-1');
    read['observed-drift|orders|']!.delivered.push('pagerduty');
    expect((await store.getState('room-1'))['observed-drift|orders|']?.delivered).toEqual(['slack']);
  });
});
