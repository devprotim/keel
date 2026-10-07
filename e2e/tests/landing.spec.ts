import { expect, test } from '@playwright/test';
import { Board } from './board.ts';

test('the landing page starts a fresh room without asking for an account', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/checks itself against production/);

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

test('a typed room id is not found rather than a new room anyone could guess', async ({ page }) => {
  await page.goto('/foo-typed');
  await expect(page.getByRole('alert')).toContainText('No diagram here');
  await expect(page.locator('.presence .status')).not.toHaveText('Live');

  // Nothing was made by visiting it, on the socket or the API.
  const access = await page.request.get('/api/rooms/foo-typed/access');
  expect(await access.json()).toMatchObject({ missing: true });

  await page.getByRole('link', { name: 'Start a new diagram' }).click();
  await page.getByRole('button', { name: 'Start a new diagram' }).click();
  await new Board(page).expectLive();
});

test('?pitch= previews another message on the real page', async ({ page }) => {
  await page.goto('/?pitch=incident');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('When it breaks, know where to look and what changed');
  await page.goto('/');
  await page.screenshot({ path: test.info().outputPath('landing.png'), fullPage: true });
  await page.goto('/?pitch=nonsense');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/checks itself against production/);
});

test('the example opens with production reporting in, telling one story end to end', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'See it on an example' }).click();
  await expect(page).toHaveURL(/\/[0-9a-f]{12}$/);

  const board = new Board(page);
  await board.expectLive();
  await board.expectCounts(11, 12);

  // Findings: the scale-down reads as an accident against the approved design.
  await board.reviewPill.click();
  await expect(page.locator('keel-findings .reality')).toContainText('Matches the approved design.');
  await expect(page.locator('keel-findings')).toContainText('Catalog drifted from the approved design');

  // Incident mode: it ranks the damage and shows what started it.
  await page.getByRole('button', { name: 'Incident', exact: true }).click();
  const lookFirst = page.getByRole('list', { name: 'Look here first' });
  await expect(lookFirst.getByRole('listitem').first()).toContainText('Catalog');
  await expect(lookFirst).toContainText('1 of 3 instances ready');
  await expect(page.getByRole('list', { name: 'Recent changes' })).toContainText('Catalog: Instances 3 → 1');
  await expect(page.getByRole('list', { name: 'Calls not on the diagram' })).toContainText('Checkout to Catalog');
  await page.screenshot({ path: test.info().outputPath('demo.png') });
});

test('navigating moves focus to the new page instead of leaving it behind', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a new diagram' }).click();
  await expect(page).toHaveURL(/\/[0-9a-f]{12}$/);
  await expect(page.getByRole('application')).toBeFocused();

  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
});
