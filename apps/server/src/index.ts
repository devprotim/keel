import pg from 'pg';
import { buildApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { MemoryAccessStore, PostgresAccessStore, type AccessStore } from './access/store.ts';
import { MemoryAlertStore, PostgresAlertStore, type AlertStore } from './alerts/store.ts';
import { PostgresDocStore } from './store/postgres-store.ts';
import { fromPgPool } from './store/sql.ts';
import { MemoryDocStore, type DocStore } from './store/store.ts';

const config = loadConfig();
const { store, alertStore, accessStore } = await openStores(config);
const app = await buildApp({ config, store, alertStore, accessStore });

if (store.kind === 'memory' && config.NODE_ENV === 'production') {
  app.log.warn('DATABASE_URL is not set: rooms are kept in memory and will be lost on restart');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, flushing rooms`);
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

/**
 * Postgres when configured, memory otherwise. A configured database that is
 * unreachable or fails to migrate stops the boot here, before the port opens,
 * rather than accepting edits it cannot keep.
 */
interface Stores {
  store: DocStore;
  alertStore: AlertStore;
  accessStore: AccessStore;
}

async function openStores(config: Config): Promise<Stores> {
  if (!config.DATABASE_URL) {
    return { store: new MemoryDocStore(), alertStore: new MemoryAlertStore(), accessStore: new MemoryAccessStore() };
  }

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
  // An idle client losing its connection emits on the pool; unhandled, that
  // event crashes the process. The pool replaces the client on next checkout.
  pool.on('error', (error) => console.error('postgres pool error', error));
  const db = fromPgPool(pool);
  // One pool for both; the doc store owns it and ends it on close.
  return {
    store: await PostgresDocStore.open(db),
    alertStore: new PostgresAlertStore(db),
    accessStore: new PostgresAccessStore(db),
  };
}
