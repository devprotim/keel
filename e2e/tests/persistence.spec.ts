import { test } from '@playwright/test';
import { Board, newRoomId } from './board.ts';

test('a diagram outlives every tab closing and the room being evicted', async ({ browser }) => {
  const roomId = newRoomId();

  const first = await browser.newContext();
  const author = new Board(await first.newPage());
  await author.open(roomId);
  await author.loadExample();
  await first.close();

  // The config sets ROOM_IDLE_MS=500, so once this passes the server has
  // dropped the in-memory Y.Doc and must rebuild it from the stored update log.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  // A brand-new context has an empty IndexedDB, so the diagram can only have
  // come from the server's store, not y-indexeddb's local copy.
  const second = await browser.newContext();
  const reader = new Board(await second.newPage());
  await reader.open(roomId);
  await reader.expectCounts(11, 12);
  await second.close();
});

test('a reload keeps the diagram', async ({ page }) => {
  const board = new Board(page);
  await board.open(newRoomId());
  await board.placeNode('gateway', { x: 400, y: 300 });
  await board.field('Name').fill('Edge');

  await page.reload();
  await board.expectLive();
  await board.expectCounts(1, 0);
  await board.nodeList.filter({ hasText: 'Edge, gateway' }).waitFor();
});
