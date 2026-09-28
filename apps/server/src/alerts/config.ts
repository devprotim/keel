import { REALITY_CHECKS, type Finding, type Severity } from '@keel/shared';
import { z } from 'zod';

/**
 * Where a room's alerts go, and which findings count.
 *
 * Stored server-side, never in the room document: a Slack webhook URL or a
 * PagerDuty routing key is a credential for posting to someone's channel or
 * paging their on-call, and the room document is readable by everyone with the
 * link. The API only ever hands them back masked.
 */

const SeveritySchema = z.enum(['error', 'warning', 'info']);

/**
 * Only Slack's own webhook host. Accepting any URL would turn the alert
 * worker into a way to make this server send requests anywhere (SSRF).
 */
const SlackWebhookSchema = z
  .string()
  .max(500)
  .regex(/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/, 'must be a https://hooks.slack.com/services/... incoming webhook URL');

/** Events API v2 integration keys are 32 characters. */
const RoutingKeySchema = z.string().regex(/^[A-Za-z0-9]{32}$/, 'must be a 32-character Events API v2 integration key');

/** Checks that can alert. Rule findings alert only when observed evidence is what raised them. */
export const ALERTABLE_CHECKS = [...REALITY_CHECKS.map((c) => c.id), 'observed-rules'] as const;

/**
 * The defaults are a starting point, not a policy. unapproved-change is off
 * because it fires on a diagram edit, not on production changing. Which
 * findings deserve a page is the team's call.
 */
export const DEFAULT_CHECKS: readonly string[] = ALERTABLE_CHECKS.filter((id) => id !== 'unapproved-change');

export const AlertConfigSchema = z
  .object({
    slack: z.object({ webhookUrl: SlackWebhookSchema, minSeverity: SeveritySchema.default('warning') }).optional(),
    pagerduty: z.object({ routingKey: RoutingKeySchema, minSeverity: SeveritySchema.default('error') }).optional(),
    checks: z
      .array(z.enum(ALERTABLE_CHECKS as unknown as [string, ...string[]]))
      .max(ALERTABLE_CHECKS.length)
      .default([...DEFAULT_CHECKS]),
    /**
     * A finding must stay gone this long before it is resolved. Without it, a
     * value hovering around a threshold opens and closes an incident on every
     * push.
     */
    resolveAfterMinutes: z.number().int().min(0).max(24 * 60).default(10),
  })
  .refine((config) => config.slack || config.pagerduty, 'configure at least one of slack or pagerduty');

export type AlertConfig = z.infer<typeof AlertConfigSchema>;

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function atLeast(severity: Severity, minimum: Severity): boolean {
  return RANK[severity] <= RANK[minimum];
}

/** True if this finding is one the room has chosen to be alerted about. */
export function isAlertable(finding: Finding, config: AlertConfig): boolean {
  if (config.checks.includes(finding.ruleId)) return true;
  return finding.observed === true && config.checks.includes('observed-rules');
}

/** What GET returns: enough to recognise the destination, not enough to use it. */
export function maskedConfig(config: AlertConfig): unknown {
  return {
    ...(config.slack
      ? { slack: { webhookUrl: `https://hooks.slack.com/services/…${config.slack.webhookUrl.slice(-4)}`, minSeverity: config.slack.minSeverity } }
      : {}),
    ...(config.pagerduty
      ? { pagerduty: { routingKey: `…${config.pagerduty.routingKey.slice(-4)}`, minSeverity: config.pagerduty.minSeverity } }
      : {}),
    checks: config.checks,
    resolveAfterMinutes: config.resolveAfterMinutes,
  };
}
