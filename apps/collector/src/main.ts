import { Collector } from './collector.ts';
import { loadConfig } from './config.ts';
import { KeelClient } from './keel-client.ts';
import { inClusterOptions, KubeClient } from './kubernetes.ts';

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let kube: KubeClient | null = null;
if (config.kubernetes.enabled) {
  const options = config.kubernetes.apiUrl
    ? { apiUrl: config.kubernetes.apiUrl, namespaces: config.kubernetes.namespaces }
    : inClusterOptions(process.env, config.kubernetes.namespaces);
  // loadConfig has already refused a Kubernetes source with neither.
  if (options) kube = new KubeClient(options);
}

const collector = new Collector({ config, keel: new KeelClient(config.keelUrl, { token: config.ingestToken }), kube, log });
await collector.start();
log(`reporting to ${config.keelUrl} rooms ${config.roomIds.join(', ')} every ${config.pushIntervalMs / 1000}s`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal} received, stopping`);
    void collector.stop().then(() => process.exit(0));
  });
}
