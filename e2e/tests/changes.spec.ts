import { expect, test, type Page } from '@playwright/test';
import { Board, newRoomId } from './board.js';

/**
 * Review mode: the Changes tab of the review dock lists what changed since the
 * design was approved, and each change is approved or rejected on its own.
 */

async function approveExample(board: Board): Promise<void> {
  await board.loadExample();
  await board.reviewPill.click();
  await board.page.locator('keel-findings .reality').getByRole('button', { name: 'Approve design' }).click();
  await expect(board.page.locator('keel-findings .reality')).toContainText('Matches the approved design.');
}

/** Select a component through a finding that cites only it, since the canvas can't be clicked by name. */
async function selectThroughFinding(page: Page, title: string): Promise<void> {
  const findings = page.locator('keel-findings');
  await findings.getByRole('tab', { name: /Findings/ }).click();
  await findings.locator('.finding-group', { hasText: title }).locator('button.finding').click();
}

const changesTab = (page: Page) => page.locator('keel-findings').getByRole('tab', { name: /Changes/ });
const changeList = (page: Page) => page.getByRole('list', { name: 'Changes since approval' });
const change = (page: Page, label: string) => changeList(page).locator(':scope > li', { hasText: label });

test('each changed field is approved or reverted on its own', async ({ page }) => {
  const board = new Board(page);
  await board.open(newRoomId());
  await approveExample(board);

  await changesTab(page).click();
  await expect(page.locator('keel-changes')).toContainText('Matches the approved design.');

  await selectThroughFinding(page, 'Catalog DB has no replication');
  await board.field('Instances').fill('3');
  await board.inspector.getByLabel('On the critical path').check();

  await changesTab(page).click();
  await expect(changesTab(page)).toContainText('1');
  const catalogDb = change(page, 'Catalog DB');
  await expect(catalogDb).toContainText('Component changed');
  await expect(catalogDb.locator('.field', { hasText: 'Instances' })).toContainText(/1\s*→\s*3/);
  await expect(catalogDb.locator('.field', { hasText: 'Critical path' })).toContainText(/no\s*→\s*yes/);
  await expect(catalogDb).toContainText(/Approved by/);

  // Review mode says on the canvas mirror what its colours say.
  await expect(board.nodeList.filter({ hasText: 'Catalog DB' })).toContainText('changed since approval');
  await page.screenshot({ path: test.info().outputPath('changed.png') });

  await catalogDb.getByRole('button', { name: 'Approve Instances on Catalog DB' }).click();
  await expect(catalogDb.locator('.field')).toHaveCount(1);
  await catalogDb.getByRole('button', { name: 'Revert Catalog DB' }).click();

  await expect(page.locator('keel-changes')).toContainText('Matches the approved design.');
  await expect(board.nodeList.filter({ hasText: 'Catalog DB' })).toHaveText('Catalog DB, datastore, 3 instances');
  await expect(board.inspector.getByLabel('On the critical path')).not.toBeChecked();

  // Reverting is an edit like any other, so it undoes.
  await page.getByTitle('Undo (Cmd/Ctrl+Z)').click();
  await expect(change(page, 'Catalog DB')).toContainText('Critical path');
});

test('a deleted component comes back with its dependencies, and an addition can be removed', async ({ page }) => {
  const board = new Board(page);
  await board.open(newRoomId());
  await approveExample(board);

  await selectThroughFinding(page, 'Catalog DB has no replication');
  await board.canvas.focus();
  await page.keyboard.press('Delete');
  await board.expectCounts(10, 10);

  await board.placeNode('cache', { x: 1300, y: 760 });
  await board.expectCounts(11, 10);

  await changesTab(page).click();
  await expect(changeList(page).locator(':scope > li')).toHaveCount(4);
  await expect(change(page, 'Catalog DB').first()).toContainText('Component removed');
  await expect(change(page, 'Catalog to Catalog DB')).toContainText('Dependency removed');
  await expect(change(page, 'Search indexer to Catalog DB')).toContainText('Dependency removed');
  const added = changeList(page).locator(':scope > li.added');
  await expect(added).toContainText('Component added');
  await expect(added).toContainText('cache');
  await page.screenshot({ path: test.info().outputPath('removed.png') });

  await added.getByRole('button', { name: /^Remove / }).click();
  await board.expectCounts(10, 10);

  await change(page, 'Catalog DB').first().getByRole('button', { name: 'Restore Catalog DB' }).click();
  await board.expectCounts(11, 12);
  await expect(page.locator('keel-changes')).toContainText('Matches the approved design.');
  await expect(board.nodeList.filter({ hasText: 'Catalog DB' })).toHaveText('Catalog DB, datastore, 1 instance');
});

test('a removal can be approved, and a collaborator sees the review live', async ({ browser }) => {
  const roomId = newRoomId();
  const alice = new Board(await (await browser.newContext()).newPage());
  const bob = new Board(await (await browser.newContext()).newPage());
  await alice.open(roomId);
  await approveExample(alice);
  await bob.open(roomId);
  await bob.expectCounts(11, 12);

  await selectThroughFinding(alice.page, 'Catalog DB has no replication');
  await alice.canvas.focus();
  await alice.page.keyboard.press('Delete');

  await bob.reviewPill.click();
  await changesTab(bob.page).click();
  await expect(changeList(bob.page).locator(':scope > li')).toHaveCount(3);

  await changesTab(alice.page).click();
  await change(alice.page, 'Catalog DB').first().getByRole('button', { name: 'Approve removal Catalog DB' }).click();

  // Approving the component's removal approves the dependencies it took with it.
  await expect(bob.page.locator('keel-changes')).toContainText('Matches the approved design.');
  await bob.expectCounts(10, 10);
});
