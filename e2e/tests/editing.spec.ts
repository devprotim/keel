import { expect, test } from '@playwright/test';
import { Board, newRoomId } from './board.ts';

test.beforeEach(async ({ page }) => {
  await new Board(page).open(newRoomId());
});

test('loading the example fills the canvas and surfaces rule findings', async ({ page }) => {
  const board = new Board(page);
  await board.loadExample();

  await expect(page.getByText('Nothing on the canvas yet')).toBeHidden();
  await expect(board.nodeList.filter({ hasText: 'Pricing engine, service, 1 instance' })).toHaveCount(1);
  // The example is built to trip rules (single-instance critical service,
  // missing timeout, no circuit breaker...), so the pill must not read clean.
  await expect(board.reviewPill).not.toContainText('Nothing to review');
});

test('placing a component from the rail selects it and opens the inspector', async ({ page }) => {
  const board = new Board(page);
  await board.placeNode('service', { x: 400, y: 300 });

  await board.expectCounts(1, 0);
  await expect(board.inspector).toBeVisible();
  await expect(board.field('Kind')).toHaveValue('service');
});

test('dragging a component off the rail drops it on the canvas', async ({ page }) => {
  const board = new Board(page);
  const tile = page.getByRole('toolbar', { name: 'Add a component' }).getByRole('button', { name: 'datastore', exact: true });
  await tile.dragTo(board.canvas, { targetPosition: { x: 500, y: 400 } });

  await board.expectCounts(1, 0);
  await expect(board.nodeList.first()).toContainText('datastore');
});

test('renaming in the inspector updates the diagram, and undo walks it back', async ({ page }) => {
  const board = new Board(page);
  await board.placeNode('queue', { x: 400, y: 300 });
  await board.field('Name').fill('Order events');

  await expect(board.nodeList.first()).toHaveText(/^Order events, queue/);

  // Placing and an immediate rename land inside one UndoManager capture window
  // (graph-doc.ts), so a single undo takes back both.
  const undo = page.getByRole('button', { name: '↶' });
  await undo.click();
  await board.expectCounts(0, 0);
  await expect(undo).toBeDisabled();

  await page.getByRole('button', { name: '↷' }).click();
  await expect(board.nodeList.first()).toHaveText(/^Order events, queue/);
});

test('Delete removes the selection and Escape closes the inspector', async ({ page }) => {
  const board = new Board(page);
  await board.placeNode('cache', { x: 300, y: 300 });
  await board.placeNode('job', { x: 700, y: 300 });
  await board.expectCounts(2, 0);

  // The canvas owns keyboard shortcuts, so focus has to be on it.
  await board.canvas.focus();
  await page.keyboard.press('Delete');
  await board.expectCounts(1, 0);
  await expect(board.nodeList.first()).toContainText('cache');

  await board.canvas.click({ position: { x: 300, y: 300 } });
  await expect(board.inspector).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(board.inspector).toBeHidden();
});

test('alt-dragging from one component to another draws a dependency', async ({ page }) => {
  const board = new Board(page);
  const from = { x: 300, y: 300 };
  const to = { x: 700, y: 300 };
  await board.placeNode('service', from);
  await board.placeNode('datastore', to);

  const start = await board.pagePoint(from);
  const end = await board.pagePoint(to);
  await page.keyboard.down('Alt');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');

  await board.expectCounts(2, 1);
});

test('clicking a finding reveals and selects the component it cites', async ({ page }) => {
  const board = new Board(page);
  await board.loadExample();

  await board.reviewPill.click();
  const finding = page.locator('keel-findings button.finding').first();
  await finding.click();

  await expect(board.inspector).toBeVisible();
  await expect(board.inspector.locator('.findings')).toContainText(/issues? here/);
});
