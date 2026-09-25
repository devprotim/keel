import { expect, test, type APIRequestContext } from '@playwright/test';
import { Board, newRoomId } from './board.js';

/**
 * Evidence and intent, end to end: a system outside the browser pushes what it
 * observes into the room over HTTP, and the open canvas re-validates against it
 * live, with no reload.
 */

function push(request: APIRequestContext, roomId: string, set: Record<string, unknown>) {
  return request.post(`/api/rooms/${roomId}/observations`, {
    data: { observedAt: new Date().toISOString(), ...set },
  });
}

test('observations pushed over HTTP catch wrong numbers, and one click fixes the diagram', async ({ page, request }) => {
  const board = new Board(page);
  const roomId = newRoomId();
  await board.open(roomId);
  await board.loadExample();
  await board.reviewPill.click();

  const findings = page.locator('keel-findings');
  await expect(findings.locator('.reality')).toContainText('None. Values are taken as typed.');

  // The diagram says Catalog runs 3 instances and Checkout's DB call times out
  // at 500ms. Production disagrees on both.
  const response = await push(request, roomId, {
    source: 'kubernetes',
    nodes: [{ ref: 'catalog', replicas: 1 }, { ref: 'not-drawn', replicas: 2 }],
    edges: [{ source: 'checkout', target: 'orders-db', timeoutMs: 4000 }],
  });
  expect(response.status()).toBe(202);

  await expect(findings.locator('.source')).toContainText('kubernetes');
  await expect(findings.locator('.source')).toContainText('Not on the diagram: not-drawn');

  // Gap 1: the wrong numbers are flagged.
  const drift = findings.locator('.finding-group', { hasText: 'Catalog does not run the way it is drawn' });
  await expect(drift).toContainText('instances 3 vs 1');
  await expect(findings.locator('.finding-group', { hasText: 'Checkout to Orders DB does not run the way it is drawn' })).toContainText(
    'timeout 500ms vs 4s',
  );

  // Gap 2: the stale declaration no longer hides the single point of failure.
  const spof = findings.locator('.finding-group', { hasText: 'Catalog is a single point of failure' });
  await expect(spof.locator('.finding-badge')).toHaveText('LIVE');

  // Gap 4: one click brings the diagram in line with the running system.
  await drift.getByRole('button', { name: 'Match running system' }).click();
  await expect(drift).toHaveCount(0);
  await expect(board.nodeList.filter({ hasText: 'Catalog, service, 1 instance' })).toHaveCount(1);
});

test('traffic decides which findings matter', async ({ page, request }) => {
  const board = new Board(page);
  const roomId = newRoomId();
  await board.open(roomId);
  await board.loadExample();
  await board.reviewPill.click();

  await push(request, roomId, {
    source: 'otel',
    nodes: [
      { ref: 'checkout', rps: 900 },
      { ref: 'search-indexer', rps: 0 },
    ],
  });

  const findings = page.locator('keel-findings');
  await expect(findings.locator('.finding-traffic', { hasText: '900 rps' }).first()).toBeVisible();

  // The search indexer is observed idle, so findings that cite only it are
  // labelled as such and sorted below the busy ones.
  await expect(findings.locator('.finding-traffic', { hasText: 'no traffic' }).first()).toBeVisible();
});

test('an approved baseline tells an accident apart from an approved change', async ({ page, request }) => {
  const board = new Board(page);
  const roomId = newRoomId();
  await board.open(roomId);
  await board.loadExample();
  await board.reviewPill.click();

  const findings = page.locator('keel-findings');
  const reality = findings.locator('.reality');
  await expect(reality).toContainText('Nothing approved yet.');

  await reality.getByRole('button', { name: 'Approve design' }).click();
  await expect(reality).toContainText('Matches the approved design.');

  // Someone turned off backups on the Orders DB. Nobody approved that.
  await push(request, roomId, { source: 'aws', nodes: [{ ref: 'orders-db', hasBackup: false }] });

  const accident = findings.locator('.finding-group', { hasText: 'Orders DB drifted from the approved design' });
  await expect(accident).toContainText('error');
  await expect(accident).toContainText('treat it as an accident');

  // An edit on the canvas that nobody approved shows up as a pending change.
  // This finding cites only the node, so clicking it selects the component.
  await findings.locator('.finding-group', { hasText: 'Catalog DB has no replication' }).locator('button.finding').click();
  await board.field('Instances').fill('3');
  await expect(reality).toContainText('Changed since approval.');
  await expect(board.inspector.locator('.evidence')).toContainText('Changed since approval');

  const pending = findings.locator('.finding-group', { hasText: 'Catalog DB changed since it was approved' });
  await expect(pending).toContainText('approved 1, drawn 3');
  await pending.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(pending).toHaveCount(0);
  await expect(board.inspector.locator('.evidence')).toContainText(/Approved by/);
});

test('the approval baseline syncs to a second collaborator', async ({ browser, request }) => {
  const roomId = newRoomId();
  const alice = new Board(await (await browser.newContext()).newPage());
  const bob = new Board(await (await browser.newContext()).newPage());

  await alice.open(roomId);
  await alice.loadExample();
  await bob.open(roomId);
  await bob.expectCounts(11, 12);

  await alice.reviewPill.click();
  await alice.page.locator('keel-findings .reality').getByRole('button', { name: 'Approve design' }).click();

  await bob.reviewPill.click();
  await expect(bob.page.locator('keel-findings .reality')).toContainText('Matches the approved design.');

  await push(request, roomId, { source: 'kubernetes', nodes: [{ ref: 'catalog', replicas: 1 }] });
  await expect(bob.page.locator('keel-findings')).toContainText('Catalog drifted from the approved design');
});
