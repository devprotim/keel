import { describe, expect, it } from 'vitest';
import { loadConfig, sourceName } from './config.ts';

const base = { KEEL_URL: 'https://keel.test', KEEL_ROOMS: 'prod-arch', KUBERNETES_SERVICE_HOST: '10.0.0.1' };

describe('loadConfig', () => {
  it('has working defaults inside a pod', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ roomIds: ['prod-arch'], pushIntervalMs: 30_000, kubernetes: { enabled: true }, otlp: { port: 4318 } });
  });

  it('lists every problem at once', () => {
    expect(() => loadConfig({ KEEL_ROOMS: '../etc', KEEL_OTLP_SAMPLE_RATIO: '2' })).toThrow(
      /KEEL_URL is required[\s\S]*not a valid room id[\s\S]*KEEL_OTLP_SAMPLE_RATIO[\s\S]*not a pod/,
    );
  });

  it('names sources per cluster when asked', () => {
    expect(sourceName('otel', loadConfig({ ...base, KEEL_CLUSTER: 'eu-west' }).cluster)).toBe('otel:eu-west');
    expect(sourceName('kubernetes', null)).toBe('kubernetes');
  });
});
