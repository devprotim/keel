import { expect, test, type Page } from '@playwright/test';
import { Board, newRoomId } from './board.js';

/**
 * Tuning, end to end: people label findings, rooms raise, lower or mute
 * rules, the numbers show which rules are noisy, and names production reports
 * that no box carries come with a one-click fix.
 */

const findings = (page: Page) => page.locator('keel-findings');
const group = (page: Page, title: string) => findings(page).locator('.finding-group', { hasText: title });
const tab = (page: Page, name: RegExp) => findings(page).getByRole('tab', { name });

test('a finding labelled noise is dismissed for everyone, counted, and can come back', async ({ browser }) => {
  const roomId = newRoomId();
  const alice = new Board(await (await browser.newContext()).newPage());
  const bob = new Board(await (await browser.newContext()).newPage());
  await alice.open(roomId);
  await alice.loadExample();
  await bob.open(roomId);
  await bob.expectCounts(11, 12);
  await alice.reviewPill.click();
  await bob.reviewPill.click();

  const title = 'Catalog DB has no replication';
  await expect(group(alice.page, title)).toHaveCount(1);
  await alice.page.screenshot({ path: test.info().outputPath('findings.png') });
  await group(alice.page, title).getByRole('button', { name: 'Noise' }).click();

  await expect(group(alice.page, title)).toHaveCount(0);
  await expect(group(bob.page, title)).toHaveCount(0);
  await expect(findings(bob.page).getByRole('button', { name: /Dismissed as noise/ })).toContainText('1');

  // Confirming another one marks it for everyone too.
  const confirmed = group(alice.page, 'Checkout calls Pricing engine with no timeout');
  await confirmed.getByRole('button', { name: 'Real' }).click();
  await expect(group(bob.page, 'Checkout calls Pricing engine with no timeout')).toContainText('CONFIRMED');

  // The labels add up per rule.
  await tab(alice.page, /Rules/).click();
  const durability = alice.page.getByRole('list', { name: 'Rules' }).getByRole('listitem').filter({ hasText: 'Datastore without replication or backups' });
  await expect(durability).toContainText('1 noise, 0 real (100% noise)');
  await expect(durability).toContainText('1 firing');

  await tab(alice.page, /Findings/).click();
  await findings(alice.page).getByRole('button', { name: /Dismissed as noise/ }).click();
  await findings(alice.page).getByRole('list', { name: 'Dismissed as noise' }).getByRole('button', { name: 'Restore' }).click();
  await expect(group(bob.page, title)).toHaveCount(1);
});

test('a room can lower or mute a rule, and it measures how often rules fire', async ({ page }) => {
  const board = new Board(page);
  await board.open(newRoomId());
  await board.loadExample();
  await board.reviewPill.click();

  await expect(group(page, 'Catalog DB has no replication')).toContainText('error');

  await tab(page, /Rules/).click();
  const rules = page.getByRole('list', { name: 'Rules' });
  await rules.getByRole('combobox', { name: 'Severity for Datastore without replication or backups' }).selectOption('info');
  await rules.getByRole('checkbox', { name: 'Mute Single point of failure' }).check();

  // History is kept once the room settles, so each rule shows how often it fired.
  await expect(rules.getByRole('listitem').filter({ hasText: 'Synchronous call without a timeout' })).toContainText(
    /Fired \d+ times? this week/,
    { timeout: 10_000 },
  );

  await page.screenshot({ path: test.info().outputPath('rules.png') });
  await tab(page, /Findings/).click();
  await expect(group(page, 'Catalog DB has no replication')).toContainText('info');
  await expect(findings(page).locator('.finding-group', { hasText: 'runs 1 instance' })).toHaveCount(0);

  // Settings are edits like any other: one undo brings the rule back.
  await page.getByTitle('Undo (Cmd/Ctrl+Z)').click();
  await expect(findings(page).locator('.finding-group', { hasText: 'runs 1 instance' }).first()).toBeVisible();
});

test('names production reports that no box carries come with a suggested fix', async ({ page, request }) => {
  const board = new Board(page);
  const roomId = newRoomId();
  await board.open(roomId);
  await board.loadExample();
  await board.placeNode('cache', { x: 1300, y: 760 });
  await board.expectCounts(12, 12);
  await board.page.keyboard.press('Escape');

  const response = await request.post(`/api/rooms/${roomId}/observations`, {
    data: {
      source: 'kubernetes',
      observedAt: new Date().toISOString(),
      nodes: [
        { ref: 'new-cache', replicas: 2 },
        { ref: 'payments-db', replicas: 1 },
      ],
    },
  });
  expect(response.status()).toBe(202);

  await board.reviewPill.click();
  const reality = findings(page).locator('.reality');
  await expect(reality).toContainText('Not on the diagram: new-cache, payments-db');

  await reality.getByRole('button', { name: 'Link to New cache' }).click();
  await reality.getByRole('button', { name: 'Add as datastore' }).click();

  await board.expectCounts(13, 12);
  await expect(board.nodeList.filter({ hasText: 'Payments db' })).toHaveText('Payments db, datastore, 1 instance');
  await expect(reality).not.toContainText('Not on the diagram');
  // Linked, so the observed count now lands on the box.
  await expect(board.nodeList.filter({ hasText: 'New cache' })).toBeVisible();
  await expect(findings(page).locator('.source')).toContainText('2 matched');
});
