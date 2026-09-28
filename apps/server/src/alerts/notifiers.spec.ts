import { describe, expect, it } from 'vitest';
import { AlertConfigSchema } from './config.ts';
import { createSender, type AlertEvent } from './notifiers.ts';

const config = AlertConfigSchema.parse({
  slack: { webhookUrl: 'https://hooks.slack.com/services/T0/B0/xyz' },
  pagerduty: { routingKey: 'b'.repeat(32) },
});

const event = (action: AlertEvent['action']): AlertEvent => ({
  action,
  dedupKey: 'keel-abc',
  roomUrl: 'https://keel.test/room-1',
  alert: {
    ruleId: 'timeout-below-latency',
    severity: 'error',
    title: 'Checkout times out calling <Pricing> before it usually answers',
    detail: 'Timeout 200ms, observed p99 900ms.',
    nodeIds: ['checkout', 'pricing'],
    edgeIds: ['e1'],
    firstSeenAt: '2026-09-28T03:00:00.000Z',
    lastSeenAt: '2026-09-28T03:00:00.000Z',
    delivered: [],
  },
});

function capture(status = 202) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
    return Promise.resolve(new Response('internal error at https://hooks.slack.com/services/T0/B0/xyz', { status }));
  }) as typeof globalThis.fetch;
  return { requests, send: createSender(fetch) };
}

describe('PagerDuty', () => {
  it('triggers with a dedup key, a critical severity for errors, and a link back', async () => {
    const { requests, send } = capture();
    await send('pagerduty', config, event('trigger'));
    expect(requests[0]?.url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(requests[0]?.body).toMatchObject({
      routing_key: 'b'.repeat(32),
      event_action: 'trigger',
      dedup_key: 'keel-abc',
      payload: { severity: 'critical', source: 'keel', class: 'timeout-below-latency' },
      links: [{ href: 'https://keel.test/room-1', text: 'Open in Keel' }],
    });
  });

  it('resolves by dedup key alone', async () => {
    const { requests, send } = capture();
    await send('pagerduty', config, event('resolve'));
    expect(requests[0]?.body).toEqual({ routing_key: 'b'.repeat(32), event_action: 'resolve', dedup_key: 'keel-abc' });
  });
});

describe('Slack', () => {
  it('posts to the configured webhook, escaping diagram text', async () => {
    const { requests, send } = capture(200);
    await send('slack', config, event('trigger'));
    expect(requests[0]?.url).toBe('https://hooks.slack.com/services/T0/B0/xyz');
    const blocks = JSON.stringify(requests[0]?.body['blocks']);
    expect(blocks).toContain('&lt;Pricing&gt;');
    expect(blocks).toContain('<https://keel.test/room-1|Open in Keel>');
  });
});

describe('failures', () => {
  it('reports the status without echoing the response, which may contain the webhook', async () => {
    const { send } = capture(500);
    const error = await send('slack', config, event('trigger')).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('slack responded 500');
  });
});

describe('config validation', () => {
  it.each([
    ['a webhook on another host (SSRF)', { slack: { webhookUrl: 'https://evil.example/services/x' } }],
    ['a plain-http webhook', { slack: { webhookUrl: 'http://hooks.slack.com/services/x' } }],
    ['a malformed routing key', { pagerduty: { routingKey: 'short' } }],
    ['no channel at all', {}],
    ['an unknown check', { slack: { webhookUrl: 'https://hooks.slack.com/services/x' }, checks: ['everything'] }],
  ])('rejects %s', (_name, input) => {
    expect(AlertConfigSchema.safeParse(input).success).toBe(false);
  });
});
