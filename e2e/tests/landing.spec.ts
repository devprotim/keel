import { expect, test } from '@playwright/test';
import { Board } from './board.ts';

test('the landing page starts a fresh room without asking for an account', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/flags its own outages/);

  await page.getByRole('button', { name: 'Start a new diagram' }).click();
  await expect(page).toHaveURL(/\/[0-9a-f]{12}$/);

  const board = new Board(page);
  await board.expectLive();
  await board.expectCounts(0, 0);
  await expect(page.getByText('Nothing on the canvas yet')).toBeVisible();
});

test('each visit to the landing CTA mints a different room', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a new diagram' }).click();
  const first = page.url();

  await page.goto('/');
  await page.getByRole('button', { name: 'Start a new diagram' }).click();
  await expect(page).not.toHaveURL(first);
});

test('an unknown nested path falls back to the landing page', async ({ page }) => {
  await page.goto('/not/a/room');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Start a new diagram' })).toBeVisible();
});
