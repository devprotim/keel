import type { AlertConfig } from './config.ts';
import type { AlertState, Channel } from './store.ts';

export interface AlertEvent {
  action: 'trigger' | 'resolve';
  /** Stable across the alert's life, so the receiver can pair a resolve with its trigger. */
  dedupKey: string;
  alert: AlertState;
  /** Opens the room with the cited elements on screen. */
  roomUrl: string;
}

export type Send = (channel: Channel, config: AlertConfig, event: AlertEvent) => Promise<void>;

/**
 * Deliver one alert event to one channel. Throws on failure, and the caller
 * keeps the event pending, so delivery is at-least-once rather than lossy.
 */
export function createSender(fetchImpl: typeof fetch = fetch): Send {
  return async (channel, config, event) => {
    const request = channel === 'slack' ? slackRequest(config, event) : pagerDutyRequest(config, event);
    if (!request) return;
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // Only the status, never the body: an error page could echo the webhook URL.
      throw new Error(`${channel} responded ${response.status}`);
    }
  };
}

const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

/**
 * PagerDuty severities are one notch richer than Keel's. Keel's errors are the
 * findings that cause outages, so they arrive as critical and it is the
 * service's own urgency rules that decide whether that wakes someone.
 */
const PAGERDUTY_SEVERITY = { error: 'critical', warning: 'warning', info: 'info' } as const;

function pagerDutyRequest(config: AlertConfig, event: AlertEvent): { url: string; body: unknown } | null {
  if (!config.pagerduty) return null;
  const { alert } = event;
  return {
    url: PAGERDUTY_EVENTS_URL,
    body: {
      routing_key: config.pagerduty.routingKey,
      event_action: event.action,
      dedup_key: event.dedupKey,
      ...(event.action === 'trigger'
        ? {
            payload: {
              summary: truncate(`Keel: ${alert.title}`, 1024),
              source: 'keel',
              severity: PAGERDUTY_SEVERITY[alert.severity],
              component: alert.nodeIds.join(', ') || undefined,
              class: alert.ruleId,
              custom_details: { detail: alert.detail, rule: alert.ruleId, nodes: alert.nodeIds, edges: alert.edgeIds, firstSeenAt: alert.firstSeenAt },
            },
            links: [{ href: event.roomUrl, text: 'Open in Keel' }],
          }
        : {}),
    },
  };
}

const SLACK_ICON = { error: ':red_circle:', warning: ':large_orange_circle:', info: ':large_blue_circle:' } as const;

function slackRequest(config: AlertConfig, event: AlertEvent): { url: string; body: unknown } | null {
  if (!config.slack) return null;
  const { alert } = event;
  const resolved = event.action === 'resolve';
  const headline = resolved ? `:white_check_mark: Resolved: ${alert.title}` : `${SLACK_ICON[alert.severity]} ${alert.title}`;
  return {
    url: config.slack.webhookUrl,
    body: {
      // Plain text for notifications and clients that don't render blocks.
      text: headline,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(headline)}*${resolved ? '' : `\n${escapeSlack(alert.detail)}`}` } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `\`${alert.ruleId}\` · since ${alert.firstSeenAt} · <${event.roomUrl}|Open in Keel>` }],
        },
      ],
    },
  };
}

/** Slack's mrkdwn treats these three as control characters. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
