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

  /** Absent means the in-memory store, which is fine for dev and tests. */
  DATABASE_URL: z.string().url().optional(),

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
});

export type Config = Readonly<z.infer<typeof schema>> & { corsOrigins: readonly string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }

  return {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
