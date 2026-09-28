import { expect, test } from '@playwright/test';
import { Board, newRoomId } from './board.ts';

test('drift alerts are configured from the board, and a stored webhook is never shown again', async ({ page }) => {
  const board = new Board(page);
  await board.open(newRoomId());

  await page.getByRole('button', { name: 'Alerts' }).click();
  const panel = page.getByRole('dialog', { name: 'Drift alerts' });
  await expect(panel.getByText('Off', { exact: true })).toBeVisible();

  // The server refuses anything that is not a Slack webhook, and says why.
  const webhook = panel.getByRole('textbox', { name: 'Slack incoming webhook URL' });
  await webhook.fill('https://example.com/not-slack');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('alert')).toContainText('hooks.slack.com');

  await webhook.fill('https://hooks.slack.com/services/T000/B000/e2esecretvalue');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('status')).toContainText('Saved');
  await expect(panel.getByText('Slack', { exact: true }).first()).toBeVisible();

  // Reopened, the field is empty and the placeholder shows only the tail.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Alerts' }).click();
  await expect(webhook).toHaveValue('');
  await expect(webhook).toHaveAttribute('placeholder', /…alue$/);
  await expect(page.locator('body')).not.toContainText('e2esecretvalue');

  await panel.getByRole('button', { name: 'Turn off' }).click();
  await expect(panel.getByText('Off', { exact: true })).toBeVisible();
});
