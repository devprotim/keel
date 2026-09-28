import pg from 'pg';
import { buildApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { PostgresDocStore } from './store/postgres-store.ts';
import { fromPgPool } from './store/sql.ts';
import { MemoryDocStore, type DocStore } from './store/store.ts';

const config = loadConfig();
const store = await openStore(config);
const app = await buildApp({ config, store });

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
async function openStore(config: Config): Promise<DocStore> {
  if (!config.DATABASE_URL) return new MemoryDocStore();

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
  // An idle client losing its connection emits on the pool; unhandled, that
  // event crashes the process. The pool replaces the client on next checkout.
  pool.on('error', (error) => console.error('postgres pool error', error));
  return PostgresDocStore.open(fromPgPool(pool));
}
