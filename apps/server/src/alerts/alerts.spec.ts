import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { MemoryDocStore } from '../store/store.ts';
import type { AlertConfig } from './config.ts';
import type { AlertEvent } from './notifiers.ts';
import { MemoryAlertStore, type Channel } from './store.ts';

/**
 * The whole path a real page takes: a diagram in storage, a collector pushing
 * observations over HTTP, the worker noticing, and a notification leaving.
 */
let app: FastifyInstance;
let docs: MemoryDocStore;
let alerts: MemoryAlertStore;
let sent: { channel: Channel; event: AlertEvent }[];

const ROOM = 'room-prod';
const SLACK = 'https://hooks.slack.com/services/T000/B000/secretsecret';

/** Write a two-node diagram into storage the way the client's GraphDoc would. */
async function seedDiagram(): Promise<void> {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  doc.transact(() => {
    for (const [id, replicas] of [['api', 3], ['orders', 3]] as const) {
      const node = new Y.Map<unknown>();
      for (const [k, v] of Object.entries({ id, kind: 'service', label: id, x: 0, y: 0, w: 180, h: 80, replicas, ref: id })) node.set(k, v);
      doc.getMap('nodes').set(id, node);
    }
    const edge = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ id: 'e1', source: 'api', target: 'orders', kind: 'sync', timeoutMs: 500 })) edge.set(k, v);
    doc.getMap('edges').set('e1', edge);

    // Approved at 3 replicas, so running 1 is an accident rather than a rollout.
    const approved = new Y.Map<unknown>();
    approved.set('_kind', 'node');
    approved.set('_label', 'orders');
    approved.set('replicas', { value: 3, by: 'dev', at: '2026-09-01T00:00:00Z' });
    doc.getMap('intent').set('orders', approved);
  });
  for (const update of updates) await docs.appendUpdate(ROOM, update);
}

beforeEach(async () => {
  docs = new MemoryDocStore();
  await docs.create(ROOM);
  alerts = new MemoryAlertStore();
  sent = [];
  app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', PERSIST_DEBOUNCE_MS: '5', ALERT_DEBOUNCE_MS: '1', PUBLIC_URL: 'https://keel.test' }),
    store: docs,
    alertStore: alerts,
    alertSend: (channel, _config, event) => {
      sent.push({ channel, event });
      return Promise.resolve();
    },
  });
  await app.ready();
  await seedDiagram();
});

afterEach(async () => {
  await app.close();
});

const push = (replicas: number) =>
  app.inject({
    method: 'POST',
    url: `/api/rooms/${ROOM}/observations`,
    payload: { source: 'kubernetes', observedAt: new Date().toISOString(), nodes: [{ ref: 'orders', replicas }] },
  });

const configure = (body: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/rooms/${ROOM}/alerts`, payload: body });

/** Until the worker's debounced evaluation has run. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

describe('drift alerts', () => {
  it('posts to Slack when production drifts from the approved design', async () => {
    expect((await configure({ slack: { webhookUrl: SLACK } })).statusCode).toBe(200);
    await push(1);
    await until(() => sent.length > 0);

    expect(sent[0]?.channel).toBe('slack');
    expect(sent[0]?.event).toMatchObject({ action: 'trigger', roomUrl: `https://keel.test/${ROOM}` });
    expect(sent[0]?.event.alert.ruleId).toBe('observed-drift');

    // A second push reporting the same drift is the same alert: nothing new is sent.
    const before = sent.length;
    await push(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent.length).toBe(before);
  });

  it('stays quiet about a finding the room labelled noise, or a rule it muted', async () => {
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    doc.getMap('labels').set('observed-drift|orders|', { verdict: 'noise', ruleId: 'observed-drift', by: 'dev', at: '2026-09-29T00:00:00Z' });
    doc.getMap('ruleSettings').set('spof-single-instance', { muted: true });
    for (const update of updates) await docs.appendUpdate(ROOM, update);

    await configure({ slack: { webhookUrl: SLACK } });
    await push(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sent.map((s) => s.event.alert.ruleId)).toEqual([]);
  });

  it('resolves once production matches again', async () => {
    await configure({ slack: { webhookUrl: SLACK }, resolveAfterMinutes: 0 });
    await push(1);
    await until(() => sent.some((s) => s.event.action === 'trigger'));
    await push(3);
    await until(() => sent.some((s) => s.event.action === 'resolve'));
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${ROOM}/alerts` })).json()).toMatchObject({ open: [] });
  });

  it('never hands a stored credential back, and keeps it across a partial update', async () => {
    await configure({ slack: { webhookUrl: SLACK }, pagerduty: { routingKey: 'k'.repeat(32) } });
    const updated = await configure({ slack: { minSeverity: 'error' } });
    expect(updated.statusCode).toBe(200);

    const body = (await app.inject({ method: 'GET', url: `/api/rooms/${ROOM}/alerts` })).body;
    expect(body).not.toContain('secretsecret');
    expect(body).not.toContain('k'.repeat(32));

    const stored = (await alerts.getConfig(ROOM)) as AlertConfig;
    expect(stored.slack).toEqual({ webhookUrl: SLACK, minSeverity: 'error' });
    expect(stored.pagerduty?.routingKey).toBe('k'.repeat(32));
  });

  it('refuses a webhook that is not Slack, so the worker cannot be aimed elsewhere', async () => {
    const response = await configure({ slack: { webhookUrl: 'http://169.254.169.254/latest/meta-data' } });
    expect(response.statusCode).toBe(400);
    expect(await alerts.getConfig(ROOM)).toBeNull();
  });

  it('removes a channel with null, and alerting entirely with DELETE', async () => {
    await configure({ slack: { webhookUrl: SLACK }, pagerduty: { routingKey: 'k'.repeat(32) } });
    await configure({ slack: null });
    expect((await alerts.getConfig(ROOM))?.slack).toBeUndefined();

    expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${ROOM}/alerts` })).statusCode).toBe(204);
    expect(await alerts.getConfig(ROOM)).toBeNull();
  });

  it('sends a test notification to each channel on request', async () => {
    await configure({ slack: { webhookUrl: SLACK }, pagerduty: { routingKey: 'k'.repeat(32) } });
    const response = await app.inject({ method: 'POST', url: `/api/rooms/${ROOM}/alerts/test` });
    expect(response.json()).toEqual({ results: { slack: { ok: true }, pagerduty: { ok: true } } });
    expect(sent.map((s) => `${s.channel}:${s.event.action}`)).toEqual(['slack:trigger', 'pagerduty:trigger', 'pagerduty:resolve']);
  });
});
