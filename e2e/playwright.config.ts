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

  webServer: {
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
    },
  },
});
