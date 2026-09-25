import { expect, test, type Browser } from '@playwright/test';
import { Board, newRoomId } from './board.ts';

/**
 * Two independent browser contexts are two separate people: separate
 * IndexedDB, separate awareness client ids, separate sockets. Nothing is
 * shared between them except the server, which is the whole point.
 */
async function twoPeople(browser: Browser, roomId: string): Promise<[Board, Board]> {
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
  const alice = new Board(await a.newPage());
  const bob = new Board(await b.newPage());
  await alice.open(roomId);
  await bob.open(roomId);
  return [alice, bob];
}

test.describe('two people in one room', () => {
  let alice: Board;
  let bob: Board;

  test.beforeEach(async ({ browser }) => {
    [alice, bob] = await twoPeople(browser, newRoomId());
  });

  test.afterEach(async () => {
    await alice.page.context().close();
    await bob.page.context().close();
  });

  test('see each other in presence', async () => {
    await expect(alice.page.getByLabel('2 people editing')).toBeVisible();
    await expect(bob.page.getByLabel('2 people editing')).toBeVisible();
  });

  test('see each other’s edits live', async () => {
    await alice.loadExample();
    await bob.expectCounts(11, 12);

    await bob.placeNode('cache', { x: 200, y: 700 });
    await bob.field('Name').fill('Session cache');
    await expect(alice.nodeList.filter({ hasText: 'Session cache, cache' })).toHaveCount(1);
    await alice.expectCounts(12, 12);
  });

  test('concurrent edits to different fields of one component both survive', async () => {
    await alice.placeNode('service', { x: 400, y: 300 });
    await bob.expectCounts(1, 0);
    await bob.canvas.click({ position: { x: 400, y: 300 } });

    // Each node is its own Y.Map, so a rename and an instance-count change
    // made at the same moment merge instead of one overwriting the other.
    await Promise.all([alice.field('Name').fill('Payments'), bob.field('Instances').fill('3')]);

    for (const person of [alice, bob]) {
      await expect(person.nodeList.first()).toHaveText('Payments, service, 3 instances');
    }
  });

  test('undo only reverts your own edits', async () => {
    await alice.placeNode('service', { x: 300, y: 300 });
    await bob.expectCounts(1, 0);
    await bob.placeNode('datastore', { x: 700, y: 300 });
    await alice.expectCounts(2, 0);

    await alice.page.getByRole('button', { name: '↶' }).click();

    for (const person of [alice, bob]) {
      await person.expectCounts(1, 0);
      await expect(person.nodeList.first()).toContainText('datastore');
    }
  });

  test('edits made offline merge when the connection comes back', async () => {
    await alice.loadExample();
    await bob.expectCounts(11, 12);

    await bob.page.context().setOffline(true);
    await expect(bob.page.locator('.presence .status')).toHaveText('Offline · edits saved');

    await bob.placeNode('queue', { x: 200, y: 700 });
    await bob.expectCounts(12, 12);
    await alice.expectCounts(11, 12);

    await bob.page.context().setOffline(false);
    await bob.expectLive();
    await alice.expectCounts(12, 12);
  });
});
