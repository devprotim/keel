import { expect, test, type APIRequestContext } from '@playwright/test';
import { Board, newRoomId } from './board.js';

/**
 * Incident mode, end to end: the running system reports in over HTTP, as the
 * collector does, and the open canvas turns into a live health map with a
 * reading order and a record of what changed.
 */

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

async function push(request: APIRequestContext, roomId: string, set: Record<string, unknown>) {
  const response = await request.post(`/api/rooms/${roomId}/observations`, { data: set });
  expect(response.status()).toBe(202);
}

test('incident mode ranks what is broken and shows what changed just before', async ({ page, request }) => {
  const board = new Board(page);
  const roomId = await newRoomId();
  await board.open(roomId);
  await board.loadExample();

  const incident = page.locator('keel-incident');
  await page.getByRole('button', { name: 'Incident', exact: true }).click();
  await expect(incident).toContainText('No live data in this room.');

  // Healthy five minutes ago...
  await push(request, roomId, {
    source: 'kubernetes',
    observedAt: minutesAgo(5),
    nodes: [
      { ref: 'catalog-db', replicas: 1 },
      { ref: 'catalog', replicas: 3 },
    ],
  });
  // ...then the database lost its only instance and Catalog scaled down.
  await push(request, roomId, {
    source: 'kubernetes',
    observedAt: minutesAgo(1),
    nodes: [
      { ref: 'catalog-db', replicas: 0 },
      { ref: 'catalog', replicas: 1 },
    ],
  });
  await push(request, roomId, {
    source: 'otel',
    observedAt: minutesAgo(0),
    edges: [
      { source: 'api-gateway', target: 'catalog', rps: 120, p99Ms: 1900, errorRate: 0.12 },
      { source: 'catalog', target: 'catalog-db', rps: 80, errorRate: 1 },
    ],
  });

  const lookFirst = page.getByRole('list', { name: 'Look here first' }).getByRole('listitem');
  await expect(lookFirst).toHaveCount(3);
  await expect(lookFirst.nth(0)).toContainText('down');
  await expect(lookFirst.nth(0)).toContainText('Catalog DB');
  await expect(lookFirst.nth(0)).toContainText('No ready instances (1 declared)');
  await expect(lookFirst.nth(0)).toContainText('Depends on it: API gateway, Catalog, Search indexer and 1 more');
  await expect(lookFirst.nth(1)).toContainText('Catalog');
  await expect(lookFirst.nth(1)).toContainText('1 of 3 instances ready');
  await expect(lookFirst.nth(2)).toContainText('API gateway to Catalog');
  await expect(lookFirst.nth(2)).toContainText('12% of calls failing · p99 1900 ms is close to the 2000 ms timeout');

  // The failing call into the dead database is its symptom, not a separate entry.
  await expect(page.getByRole('list', { name: 'Look here first' })).not.toContainText('Catalog to Catalog DB');

  const timeline = page.getByRole('list', { name: 'Recent changes' }).getByRole('listitem');
  await expect(timeline.nth(0)).toContainText('otel started reporting');
  await expect(page.getByRole('list', { name: 'Recent changes' })).toContainText('Catalog DB: Instances 1 → 0');
  await expect(page.getByRole('list', { name: 'Recent changes' })).toContainText('Catalog: Instances 3 → 1');

  // The canvas mirror says what the colours say.
  await expect(board.nodeList.filter({ hasText: 'Catalog DB' })).toContainText('down');
  await expect(board.nodeList.filter({ hasText: 'Pricing engine' })).toContainText('no live data');
  await page.screenshot({ path: test.info().outputPath('incident.png') });

  // Clicking an entry takes you there.
  await lookFirst.nth(0).getByRole('button').click();
  await expect(board.inspector).toContainText('Catalog DB');

  await page.getByRole('button', { name: 'Leave incident mode' }).click();
  await expect(incident).toBeHidden();
  await expect(board.reviewPill).toBeVisible();
  await expect(board.nodeList.filter({ hasText: 'Catalog DB' })).not.toContainText('down');
});

test('the timeline includes approved design changes alongside production ones', async ({ page, request }) => {
  const board = new Board(page);
  const roomId = await newRoomId();
  await board.open(roomId);
  await board.loadExample();

  await board.reviewPill.click();
  await page.locator('keel-findings .reality').getByRole('button', { name: 'Approve design' }).click();
  await page.locator('keel-findings .finding-group', { hasText: 'Catalog DB has no replication' }).locator('button.finding').click();
  await board.field('Instances').fill('2');
  await page.locator('keel-findings').getByRole('tab', { name: /Changes/ }).click();
  await page.getByRole('button', { name: 'Approve Catalog DB' }).click();

  await push(request, roomId, { source: 'kubernetes', observedAt: minutesAgo(0), nodes: [{ ref: 'catalog-db', replicas: 2 }] });

  await page.getByRole('button', { name: 'Incident', exact: true }).click();
  const timeline = page.getByRole('list', { name: 'Recent changes' });
  await expect(timeline).toContainText(/approved Catalog DB: Instances 1 → 2/);
  await expect(timeline).toContainText('kubernetes started reporting');
  await expect(page.getByRole('list', { name: 'Look here first' }).getByRole('listitem')).toHaveCount(0);
  await expect(page.locator('keel-incident')).toContainText('Everything that reports in looks healthy.');
});
