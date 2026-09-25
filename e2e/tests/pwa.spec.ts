import { expect, test } from '@playwright/test';

// Opt back in: this file tests the service worker itself.
test.use({ serviceWorkers: 'allow' });

test('the service worker installs without swallowing API requests', async ({ page, context }) => {
  await page.goto('/');
  // registerWhenStable:30000 in app.config.ts; the landing page goes stable
  // quickly, so the worker should appear well within that.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 35_000 }));
  expect(worker.url()).toContain('ngsw-worker.js');

  // Regression for 6389bda: ngsw's navigation fallback used to answer /health
  // and /api/* with index.html once installed.
  await page.reload();
  const health = await page.evaluate(async () => {
    const response = await fetch('/health');
    return { type: response.headers.get('content-type'), body: await response.text() };
  });
  expect(health.type).toContain('application/json');
  expect(JSON.parse(health.body)).toMatchObject({ status: 'ok' });
});
