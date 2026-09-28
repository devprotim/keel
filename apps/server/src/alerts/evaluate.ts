import { createHash } from 'node:crypto';
import type { Finding } from '@keel/shared';
import { atLeast, isAlertable, type AlertConfig } from './config.ts';
import type { AlertEvent, Send } from './notifiers.ts';
import type { AlertState, Channel, RoomAlertState } from './store.ts';

/**
 * An alert's identity: the rule and what it cites, not its wording. A title
 * that quotes a label or a latency would otherwise open a new alert on every
 * rename or every push.
 */
export function alertKey(finding: Pick<Finding, 'ruleId' | 'nodeIds' | 'edgeIds'>): string {
  return [finding.ruleId, [...finding.nodeIds].sort().join(','), [...finding.edgeIds].sort().join(',')].join('|');
}

/** Stable per room and alert, and free of the room id itself, which is a capability. */
export function dedupKey(roomId: string, key: string): string {
  return `keel-${createHash('sha256').update(`${roomId}\u0000${key}`).digest('hex').slice(0, 32)}`;
}

export interface EvaluateInput {
  roomId: string;
  roomUrl: string;
  config: AlertConfig;
  findings: readonly Finding[];
  state: RoomAlertState;
  now: number;
  send: Send;
}

export interface EvaluateResult {
  state: RoomAlertState;
  sent: { channel: Channel; action: AlertEvent['action']; key: string }[];
  failed: { channel: Channel; action: AlertEvent['action']; key: string; error: string }[];
}

/**
 * One evaluation: fold the current findings into the open alerts and deliver
 * whatever changed.
 *
 * - A new alertable finding opens an alert, delivered to every channel whose
 *   threshold it meets.
 * - An open alert that is still firing is not re-sent, but if it has worsened
 *   past a channel's threshold (a warning that became an error), that channel
 *   hears about it now.
 * - An alert whose finding has been gone for `resolveAfterMinutes` is resolved
 *   on every channel that was told about it, then forgotten.
 *
 * A delivery that fails leaves the alert as it was for that channel, so the
 * next evaluation retries it. Nothing is ever marked delivered that was not.
 */
export async function evaluateAlerts(input: EvaluateInput): Promise<EvaluateResult> {
  const { config, now, send } = input;
  const at = new Date(now).toISOString();
  const state: RoomAlertState = structuredClone(input.state);
  const sent: EvaluateResult['sent'] = [];
  const failed: EvaluateResult['failed'] = [];

  const firing = new Set<string>();
  for (const finding of input.findings) {
    if (!isAlertable(finding, config)) continue;
    const key = alertKey(finding);
    firing.add(key);
    const existing = state[key];
    state[key] = {
      ruleId: finding.ruleId,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      nodeIds: [...finding.nodeIds],
      edgeIds: [...finding.edgeIds],
      firstSeenAt: existing?.firstSeenAt ?? at,
      lastSeenAt: at,
      delivered: existing?.delivered ?? [],
    };
  }

  const channels: { channel: Channel; minSeverity: AlertState['severity'] }[] = [
    ...(config.slack ? [{ channel: 'slack' as const, minSeverity: config.slack.minSeverity }] : []),
    ...(config.pagerduty ? [{ channel: 'pagerduty' as const, minSeverity: config.pagerduty.minSeverity }] : []),
  ];

  const deliver = async (key: string, alert: AlertState, channel: Channel, action: AlertEvent['action']) => {
    try {
      await send(channel, config, { action, dedupKey: dedupKey(input.roomId, key), alert, roomUrl: input.roomUrl });
      sent.push({ channel, action, key });
      return true;
    } catch (error) {
      failed.push({ channel, action, key, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const resolveAfterMs = config.resolveAfterMinutes * 60_000;

  for (const [key, alert] of Object.entries(state)) {
    if (firing.has(key)) {
      for (const { channel, minSeverity } of channels) {
        if (alert.delivered.includes(channel) || !atLeast(alert.severity, minSeverity)) continue;
        if (await deliver(key, alert, channel, 'trigger')) alert.delivered.push(channel);
      }
      continue;
    }

    if (now - Date.parse(alert.lastSeenAt) < resolveAfterMs) continue;

    // Resolve only where it was announced. A channel removed from the config
    // since then can't be told; its record is dropped with the alert.
    const configured = new Set(channels.map((c) => c.channel));
    for (const channel of [...alert.delivered]) {
      if (!configured.has(channel)) {
        alert.delivered = alert.delivered.filter((c) => c !== channel);
        continue;
      }
      if (await deliver(key, alert, channel, 'resolve')) alert.delivered = alert.delivered.filter((c) => c !== channel);
    }
    if (alert.delivered.length === 0) delete state[key];
  }

  return { state, sent, failed };
}
