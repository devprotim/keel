/**
 * Collector configuration, from the environment. Parsed once at start; a bad
 * value stops the process instead of surfacing as silence an hour later.
 */
export interface CollectorConfig {
  keelUrl: string;
  roomIds: string[];
  /** An ingest token, required when the rooms are in a workspace. One token is per room, so this suits one room. */
  ingestToken: string | null;
  /** Appended to each source name, so two clusters report as two sources. */
  cluster: string | null;
  pushIntervalMs: number;

  kubernetes: {
    enabled: boolean;
    /** Explicit API URL (e.g. `kubectl proxy`'s); otherwise in-cluster. */
    apiUrl: string | null;
    namespaces: string[];
  };

  otlp: {
    enabled: boolean;
    port: number;
    host: string;
    sampleRatio: number;
    pairTimeoutMs: number;
    idleRetentionMs: number;
    maxBodyBytes: number;
  };
}

const ROOM_ID = /^[a-zA-Z0-9_-]{3,64}$/;
const SOURCE_SUFFIX = /^[a-zA-Z0-9_.-]{1,40}$/;

export function loadConfig(env: NodeJS.ProcessEnv): CollectorConfig {
  const problems: string[] = [];
  const read = (key: string) => env[key]?.trim() || undefined;

  const keelUrl = read('KEEL_URL');
  if (!keelUrl) problems.push('KEEL_URL is required (e.g. https://keel.example.com)');
  else if (!URL.canParse(keelUrl)) problems.push('KEEL_URL must be an absolute URL');

  const roomIds = list(read('KEEL_ROOMS'));
  if (roomIds.length === 0) problems.push('KEEL_ROOMS is required: one or more room ids, comma-separated');
  for (const id of roomIds) if (!ROOM_ID.test(id)) problems.push(`KEEL_ROOMS: "${id}" is not a valid room id`);

  const cluster = read('KEEL_CLUSTER') ?? null;
  if (cluster && !SOURCE_SUFFIX.test(cluster)) problems.push('KEEL_CLUSTER may contain only letters, numbers and _ . -');

  const number = (key: string, fallback: number, check: (n: number) => boolean, rule: string): number => {
    const raw = read(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || !check(value)) {
      problems.push(`${key} must be ${rule}`);
      return fallback;
    }
    return value;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const raw = read(key);
    if (raw === undefined) return fallback;
    if (raw !== 'true' && raw !== 'false') problems.push(`${key} must be true or false`);
    return raw === 'true';
  };

  const positive = (n: number) => n > 0;
  const config: CollectorConfig = {
    keelUrl: keelUrl ?? '',
    roomIds,
    ingestToken: read('KEEL_INGEST_TOKEN') ?? null,
    cluster,
    pushIntervalMs: number('KEEL_PUSH_INTERVAL_SECONDS', 30, positive, 'a positive number') * 1000,
    kubernetes: {
      enabled: flag('KEEL_KUBERNETES', true),
      apiUrl: read('KEEL_KUBERNETES_API_URL') ?? null,
      namespaces: list(read('KEEL_KUBERNETES_NAMESPACES')),
    },
    otlp: {
      enabled: flag('KEEL_OTLP', true),
      port: number('KEEL_OTLP_PORT', 4318, (n) => Number.isInteger(n) && n > 0 && n < 65536, 'a port number'),
      host: read('KEEL_OTLP_HOST') ?? '0.0.0.0',
      sampleRatio: number('KEEL_OTLP_SAMPLE_RATIO', 1, (n) => n > 0 && n <= 1, 'in (0, 1]'),
      pairTimeoutMs: number('KEEL_OTLP_PAIR_TIMEOUT_SECONDS', 10, positive, 'a positive number') * 1000,
      idleRetentionMs: number('KEEL_OTLP_IDLE_RETENTION_SECONDS', 600, positive, 'a positive number') * 1000,
      maxBodyBytes: number('KEEL_OTLP_MAX_BODY_BYTES', 8 * 1024 * 1024, positive, 'a positive number'),
    },
  };

  if (config.ingestToken && roomIds.length > 1) {
    problems.push('KEEL_INGEST_TOKEN is issued for one room; run one collector per private room, or use link rooms');
  }
  if (!config.kubernetes.enabled && !config.otlp.enabled) problems.push('Both sources are disabled; nothing to collect');
  if (config.kubernetes.enabled && !config.kubernetes.apiUrl && !env['KUBERNETES_SERVICE_HOST']) {
    problems.push('KEEL_KUBERNETES is on but this is not a pod: set KEEL_KUBERNETES_API_URL (e.g. http://127.0.0.1:8001 from `kubectl proxy`) or KEEL_KUBERNETES=false');
  }

  if (problems.length > 0) throw new Error(`Invalid collector configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return config;
}

export function sourceName(base: 'kubernetes' | 'otel', cluster: string | null): string {
  return cluster ? `${base}:${cluster}` : base;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
