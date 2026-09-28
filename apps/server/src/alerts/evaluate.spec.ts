import type { Finding } from '@keel/shared';
import { describe, expect, it } from 'vitest';
import { AlertConfigSchema, type AlertConfig } from './config.ts';
import { alertKey, dedupKey, evaluateAlerts } from './evaluate.ts';
import type { AlertEvent } from './notifiers.ts';
import type { Channel, RoomAlertState } from './store.ts';

const config = (overrides: Partial<AlertConfig> = {}): AlertConfig =>
  AlertConfigSchema.parse({
    slack: { webhookUrl: 'https://hooks.slack.com/services/T0/B0/xyz' },
    pagerduty: { routingKey: 'a'.repeat(32) },
    ...overrides,
  });

const drift = (severity: Finding['severity'], nodeIds = ['orders']): Finding => ({
  ruleId: 'observed-drift',
  severity,
  title: 'Orders drifted from the approved design',
  detail: 'Approved: 3 replicas. Running: 1.',
  nodeIds,
  edgeIds: [],
  observed: true,
});

function recorder(failing: Channel[] = []) {
  const events: { channel: Channel; event: AlertEvent }[] = [];
  const send = (channel: Channel, _config: AlertConfig, event: AlertEvent) => {
    if (failing.includes(channel)) return Promise.reject(new Error(`${channel} responded 500`));
    events.push({ channel, event });
    return Promise.resolve();
  };
  return { events, send };
}

const T0 = Date.parse('2026-09-28T03:00:00Z');
const minutes = (n: number) => n * 60_000;

async function step(findings: Finding[], state: RoomAlertState, now: number, cfg = config(), failing: Channel[] = []) {
  const { events, send } = recorder(failing);
  const result = await evaluateAlerts({ roomId: 'room-1', roomUrl: 'https://keel.test/room-1', config: cfg, findings, state, now, send });
  return { ...result, events };
}

describe('evaluateAlerts', () => {
  it('opens an alert once and sends it only where its severity meets the threshold', async () => {
    const first = await step([drift('warning')], {}, T0);
    // Slack takes warnings by default; PagerDuty only errors.
    expect(first.events.map((e) => `${e.channel}:${e.event.action}`)).toEqual(['slack:trigger']);

    const again = await step([drift('warning')], first.state, T0 + minutes(1));
    expect(again.events).toEqual([]);
  });

  it('pages when an open alert worsens past the pager threshold, without re-posting to Slack', async () => {
    const first = await step([drift('warning')], {}, T0);
    const worse = await step([drift('error')], first.state, T0 + minutes(1));
    expect(worse.events.map((e) => `${e.channel}:${e.event.action}`)).toEqual(['pagerduty:trigger']);
    expect(worse.events[0]?.event.dedupKey).toBe(dedupKey('room-1', alertKey(drift('error'))));
  });

  it('waits out the resolve window before resolving, so a flapping value does not flap the incident', async () => {
    const open = await step([drift('error')], {}, T0);
    const gone = await step([], open.state, T0 + minutes(5));
    expect(gone.events).toEqual([]);
    expect(Object.keys(gone.state)).toHaveLength(1);

    const back = await step([drift('error')], gone.state, T0 + minutes(6));
    expect(back.events).toEqual([]);

    const resolved = await step([], back.state, T0 + minutes(17));
    expect(resolved.events.map((e) => `${e.channel}:${e.event.action}`).sort()).toEqual(['pagerduty:resolve', 'slack:resolve']);
    expect(resolved.state).toEqual({});
  });

  it('retries a failed delivery on the next evaluation, and only on that channel', async () => {
    const first = await step([drift('error')], {}, T0, config(), ['pagerduty']);
    expect(first.events.map((e) => e.channel)).toEqual(['slack']);
    expect(first.failed.map((f) => f.channel)).toEqual(['pagerduty']);

    const retry = await step([drift('error')], first.state, T0 + minutes(1));
    expect(retry.events.map((e) => e.channel)).toEqual(['pagerduty']);
  });

  it('keeps an alert open until its resolve is actually delivered', async () => {
    const open = await step([drift('error')], {}, T0);
    const failedResolve = await step([], open.state, T0 + minutes(20), config(), ['slack']);
    expect(Object.values(failedResolve.state)[0]?.delivered).toEqual(['slack']);

    const retried = await step([], failedResolve.state, T0 + minutes(21));
    expect(retried.events.map((e) => `${e.channel}:${e.event.action}`)).toEqual(['slack:resolve']);
    expect(retried.state).toEqual({});
  });

  it('treats a renamed component as the same alert', async () => {
    const first = await step([drift('warning')], {}, T0);
    const renamed = await step([{ ...drift('warning'), title: 'Orders API drifted' }], first.state, T0 + minutes(1));
    expect(renamed.events).toEqual([]);
  });

  it('only alerts on what the room chose: not design-time changes by default, and rule findings only when observed', async () => {
    const unapproved: Finding = { ...drift('error'), ruleId: 'unapproved-change', observed: false };
    const drawnSpof: Finding = { ...drift('error'), ruleId: 'spof-single-instance', observed: false };
    const observedSpof: Finding = { ...drawnSpof, nodeIds: ['billing'], observed: true };

    const result = await step([unapproved, drawnSpof, observedSpof], {}, T0);
    expect(Object.values(result.state).map((a) => a.ruleId)).toEqual(['spof-single-instance']);
    expect(Object.values(result.state)[0]?.nodeIds).toEqual(['billing']);
  });

  it('forgets an alert that was below every threshold once it is gone', async () => {
    const quiet = await step([drift('info')], {}, T0);
    expect(quiet.events).toEqual([]);
    const later = await step([], quiet.state, T0 + minutes(11));
    expect(later.state).toEqual({});
  });
});

describe('dedupKey', () => {
  it('does not contain the room id, which is a capability', () => {
    expect(dedupKey('secret-room', 'k')).not.toContain('secret-room');
    expect(dedupKey('secret-room', 'k')).toBe(dedupKey('secret-room', 'k'));
  });
});
