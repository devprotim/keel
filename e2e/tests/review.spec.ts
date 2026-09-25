import { expect, test } from '@playwright/test';
import { Board, newRoomId } from './board.ts';

test('without an AI key the review explains it is not configured', async ({ page }) => {
  const board = new Board(page);
  await board.open(newRoomId());
  await board.loadExample();

  await board.reviewPill.click();
  await page.getByRole('button', { name: 'Run AI review' }).click();
  await expect(page.getByText('Review is not configured on the server.')).toBeVisible();
});

test('AI findings render in their own section and reveal what they cite', async ({ page }) => {
  // The real provider is paid and non-deterministic; the contract under test
  // here is the client's handling of a grounded response, not the model.
  await page.route('**/api/review/models', (route) =>
    route.fulfill({ json: { provider: 'anthropic', defaultModel: 'test-model', models: ['test-model'] } }),
  );
  // The client appends ?model=, which a plain glob would not match.
  await page.route(/\/api\/review(\?|$)/, (route) =>
    route.fulfill({
      json: {
        findings: [
          {
            ruleId: 'model',
            severity: 'warning',
            title: 'Checkout dual-writes orders and events',
            detail: 'A crash between the DB write and the publish loses the event.',
            nodeIds: ['n_checkout'],
            edgeIds: [],
          },
        ],
        fingerprint: 'mock',
        cached: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        provider: 'anthropic',
        model: 'test-model',
      },
    }),
  );

  const board = new Board(page);
  await board.open(newRoomId());
  await board.loadExample();

  await board.reviewPill.click();
  await page.getByRole('button', { name: 'Run AI review' }).click();

  const aiFinding = page.locator('keel-findings button.finding.model');
  await expect(page.getByRole('heading', { name: /AI review/ })).toBeVisible();
  await expect(aiFinding).toHaveText(/Checkout dual-writes orders and events/);

  await aiFinding.click();
  await expect(board.field('Name')).toHaveValue('Checkout');
});
