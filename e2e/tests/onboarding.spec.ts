import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { Board, newRoomId } from './board.js';

/**
 * The first-run checklist ticks itself off as a new user does each thing,
 * including connecting live data with the command it hands them.
 */
test('the checklist follows a first session, and its curl command really connects live data', async ({ page }) => {
  const board = new Board(page);
  const roomId = newRoomId();
  await board.open(roomId);

  const checklist = page.getByRole('region', { name: 'Get started' });
  await expect(checklist).toContainText('0 of 6');
  await expect(checklist).toContainText('Drag from the rail');

  await board.loadExample();
  await expect(checklist).toContainText('2 of 6');

  await board.reviewPill.click();
  await page.locator('keel-findings .finding-group').first().locator('button.finding').click();
  // The checklist shares the inspector's corner and waits for it to close.
  await expect(checklist).toBeHidden();
  await board.inspector.getByRole('button', { name: 'Close' }).click();
  await page.locator('keel-findings .reality').getByRole('button', { name: 'Approve design' }).click();
  await expect(checklist).toContainText('4 of 6');

  // The next step hands over a command; run it exactly as a user would paste it.
  const command = await checklist.locator('pre.command').innerText();
  expect(command).toContain(`/api/rooms/${roomId}/observations`);
  execFileSync('sh', ['-c', command], { stdio: 'pipe' });
  await expect(checklist).toContainText('5 of 6');
  await expect(page.locator('keel-findings .source')).toContainText('manual');

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(checklist).toBeHidden();
});

test('the checklist can be hidden for good', async ({ page }) => {
  const board = new Board(page);
  await board.open(newRoomId());
  await page.getByRole('button', { name: 'Hide the checklist' }).click();
  await expect(page.getByRole('region', { name: 'Get started' })).toBeHidden();

  await board.open(newRoomId());
  await expect(page.getByRole('region', { name: 'Get started' })).toBeHidden();
});
