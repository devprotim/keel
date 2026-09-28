import { z } from 'zod';

/**
 * Environment is parsed once, at boot, and the process refuses to start if it is
 * wrong. A server that boots with a missing database URL and then fails on the
 * first real request is strictly worse than one that never came up.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:4200'),

  /**
   * Absent means the in-memory store, which is fine for dev and tests but
   * loses every room on restart. Set, the server migrates the schema at boot
   * and refuses to start if it cannot.
   */
  DATABASE_URL: z.string().url().optional(),

  /** Connections held open to Postgres. Rooms batch writes, so few are needed. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  /**
   * Review credentials. Whichever is present selects the provider; if both are
   * set, Anthropic wins. Absent keys disable the review endpoint only, leaving
   * the canvas and the deterministic rules fully functional.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),

  /** Override the default model for whichever provider is selected. */
  REVIEW_MODEL: z.string().min(1).optional(),

  /** How long a room stays resident with no connections before it is evicted. */
  ROOM_IDLE_MS: z.coerce.number().int().positive().default(60_000),

  /** Debounce window for flushing document updates to storage. */
  PERSIST_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2_000),

  /** Update count after which the room is compacted into a fresh snapshot. */
  COMPACT_AFTER_UPDATES: z.coerce.number().int().positive().default(200),

  /**
   * Trust X-Forwarded-For from the proxy in front of this process. Required
   * behind Render's (or any) load balancer, or every client shares the
   * proxy's address and one busy user rate-limits everyone. Never set it
   * without a proxy: clients could then spoof their address to dodge limits.
   */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Per-client-address request budgets, per minute. Review forwards to a paid
   * API, so its budget is small; the others bound how fast one client can
   * make the server do work or create rooms.
   */
  RATE_LIMIT_REVIEW_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_OBSERVATIONS_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_VALIDATE_PER_MIN: z.coerce.number().int().positive().default(300),

  /**
   * Collaboration socket bounds. The frame cap is well above a 500-node
   * import; the message rate is well above a drag plus cursor movement at
   * 60fps; the room cap bounds what every collaborator has to download.
   */
  WS_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  WS_MESSAGES_PER_SECOND: z.coerce.number().int().positive().default(200),
  ROOM_MAX_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),

  /**
   * Drift alerting. Every configured room is re-evaluated this often, which is
   * what catches a collector going quiet; a push to a room is evaluated after
   * the debounce.
   */
  ALERT_SWEEP_SECONDS: z.coerce.number().positive().default(300),
  ALERT_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2_000),
  RATE_LIMIT_ALERTS_PER_MIN: z.coerce.number().int().positive().default(30),

  /**
   * Comma-separated models the review endpoint may call. Unset, any model the
   * key can list is allowed. Either way the configured default always is.
   */
  REVIEW_ALLOWED_MODELS: z.string().optional(),

  /**
   * OAuth login. Each provider is enabled independently by setting both of its
   * vars; leaving a pair unset disables only that provider's login route. This
   * is identity-only: rooms stay open to anyone with the link either way.
   */
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  /** Signs the session cookie. Required once any OAuth provider is enabled. */
  SESSION_SECRET: z.string().min(32).optional(),

  /** Base URL used to build OAuth callback URIs; can't be derived from a request behind a proxy. */
  PUBLIC_URL: z.string().url().default('http://localhost:8787'),
});

export type Config = Readonly<z.infer<typeof schema>> & {
  corsOrigins: readonly string[];
  reviewAllowedModels: readonly string[] | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }

  const data = parsed.data;
  const oauthIssues: string[] = [];
  if (data.GITHUB_CLIENT_ID && !data.GITHUB_CLIENT_SECRET) oauthIssues.push('GITHUB_CLIENT_SECRET is required when GITHUB_CLIENT_ID is set');
  if (data.GITHUB_CLIENT_SECRET && !data.GITHUB_CLIENT_ID) oauthIssues.push('GITHUB_CLIENT_ID is required when GITHUB_CLIENT_SECRET is set');
  if (data.GOOGLE_CLIENT_ID && !data.GOOGLE_CLIENT_SECRET) oauthIssues.push('GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set');
  if (data.GOOGLE_CLIENT_SECRET && !data.GOOGLE_CLIENT_ID) oauthIssues.push('GOOGLE_CLIENT_ID is required when GOOGLE_CLIENT_SECRET is set');
  const anyOAuthProvider =
    (data.GITHUB_CLIENT_ID && data.GITHUB_CLIENT_SECRET) || (data.GOOGLE_CLIENT_ID && data.GOOGLE_CLIENT_SECRET);
  if (anyOAuthProvider && !data.SESSION_SECRET) oauthIssues.push('SESSION_SECRET is required once a login provider is enabled');
  if (oauthIssues.length > 0) {
    throw new Error(`Invalid environment configuration:\n${oauthIssues.map((m) => `  ${m}`).join('\n')}`);
  }

  return {
    ...parsed.data,
    corsOrigins: splitList(parsed.data.CORS_ORIGINS),
    reviewAllowedModels: parsed.data.REVIEW_ALLOWED_MODELS ? splitList(parsed.data.REVIEW_ALLOWED_MODELS) : null,
  };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
