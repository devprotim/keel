import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production shape of Keel: one Fastify
 * process serving the API, the collaboration socket and the built Angular app
 * from the same origin, exactly as render.yaml deploys it. The dev server
 * setup (Angular on :4200 pointing at :8787) is a different topology with a
 * different app-config.ts branch, so testing it would not say much about what
 * actually ships.
 *
 * The server is started without `--env-file`, so a developer's local .env
 * (AI keys, OAuth credentials) never leaks into a run. Tests that need AI
 * review mock `/api/review` at the network layer instead.
 */
const PORT = Number(process.env.E2E_PORT ?? 8790);
const baseURL = `http://localhost:${PORT}`;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
/** Shared with tests/session.ts, which signs cookies the server will accept. */
export const E2E_SESSION_SECRET = 'e2e-session-secret-at-least-32-characters';
/** Shared with tests/billing.spec.ts, which signs webhooks the server will accept. */
export const E2E_STRIPE_WEBHOOK_SECRET = 'whsec_e2e';
export const FAKE_STRIPE_PORT = Number(process.env.FAKE_STRIPE_PORT ?? 8791);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The production build registers ngsw. Most tests don't care about it and a
    // cached app shell would make runs order-dependent, so it is blocked by
    // default; pwa.spec.ts opts back in to test the worker itself.
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],

  webServer: [
    {
      command: 'node fake-stripe.mjs',
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      url: `http://127.0.0.1:${FAKE_STRIPE_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      env: { FAKE_STRIPE_PORT: String(FAKE_STRIPE_PORT) },
    },
    {
      command: [
        'pnpm --filter @keel/shared build',
        'pnpm --filter @keel/web build',
        'cd apps/server && node --experimental-strip-types src/index.ts',
      ].join(' && '),
      cwd: repoRoot,
      url: `${baseURL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'production',
        PORT: String(PORT),
        HOST: '127.0.0.1',
        PUBLIC_URL: baseURL,
        CORS_ORIGINS: baseURL,
        // Short enough that persistence.spec.ts can watch a room get evicted and
        // then rebuilt from storage without the suite crawling.
        PERSIST_DEBOUNCE_MS: '100',
        ROOM_IDLE_MS: '500',
        // Far above anything the other specs draw, low enough that security.spec.ts
        // can cross it by typing.
        ROOM_MAX_BYTES: String(256 * 1024),
        // Every test shares one client address, which no real deployment does.
        RATE_LIMIT_ACCESS_PER_MIN: '100000',
        RATE_LIMIT_ACCESS_READ_PER_MIN: '100000',
        RATE_LIMIT_ALERTS_PER_MIN: '100000',
        RATE_LIMIT_OBSERVATIONS_PER_MIN: '100000',
        // Sign-in enabled with placeholder credentials so workspaces.spec.ts can
        // mint real session cookies (tests/session.ts). No test ever follows the
        // redirect to GitHub.
        GITHUB_CLIENT_ID: 'e2e-client-id',
        GITHUB_CLIENT_SECRET: 'e2e-client-secret',
        SESSION_SECRET: E2E_SESSION_SECRET,
        // Billing on, against the fake Stripe server above, so billing.spec.ts can go
        // through Checkout and the webhook without leaving the machine.
        STRIPE_SECRET_KEY: 'sk_test_e2e',
        STRIPE_WEBHOOK_SECRET: E2E_STRIPE_WEBHOOK_SECRET,
        STRIPE_PRICE_TEAM: 'price_team_e2e',
        STRIPE_API_URL: `http://127.0.0.1:${FAKE_STRIPE_PORT}`,
      },
    },
  ],
});
