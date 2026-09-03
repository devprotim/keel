import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { MemoryDocStore } from './store/store.ts';

const config = loadConfig();

// Postgres-backed storage is the next step; until then the in-memory store keeps
// a running instance honest about the contract it will have to satisfy.
const store = new MemoryDocStore();
const app = await buildApp({ config, store });

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
