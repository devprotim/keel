import { expect, test } from '@playwright/test';
import { Board, newRoomId } from './board.ts';

test('a room refuses to grow past its size cap, and the header says why', async ({ page }) => {
  const board = new Board(page);
  await board.open(newRoomId());
  await board.placeNode('service', { x: 400, y: 300 });

  // Well past the 256 KiB cap the e2e server runs with.
  await board.field('Name').fill('x'.repeat(300 * 1024));

  await expect(page.locator('.presence .status')).toHaveText('Not syncing · diagram too large');
});

test('a foreign page cannot open the collaboration socket', async ({ page, baseURL }) => {
  // Origin is set by the browser and cannot be forged by page script, so the
  // closest honest reproduction is the handshake header a foreign page sends.
  const wsUrl = `${baseURL!.replace(/^http/, 'ws')}/ws/e2e-origin-check`;
  const code = await page.evaluate(async (url) => {
    const ws = new WebSocket(url);
    return new Promise<number>((resolve) => ws.addEventListener('close', (event) => resolve(event.code)));
  }, wsUrl);
  // about:blank's origin is opaque ("null"), which is not this app's origin.
  expect(code).toBe(1008);

  // The app itself, same origin, is let in.
  const board = new Board(page);
  await board.open(newRoomId());
});
