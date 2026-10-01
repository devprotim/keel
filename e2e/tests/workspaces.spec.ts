import { expect, test, type Browser, type Page } from '@playwright/test';
import { Board, newRoomId } from './board.ts';
import { signIn } from './session.ts';

async function person(browser: Browser, baseURL: string, who?: { id: string; name: string }): Promise<Page> {
  const context = await browser.newContext();
  if (who) await signIn(context, baseURL, who.id, who.name);
  return context.newPage();
}

const shareButton = (page: Page) => page.getByRole('button', { name: /^(Share|Private)$/ });

test('a room made private opens only for members, and a viewer can watch but not edit', async ({ browser, baseURL }) => {
  const roomId = await newRoomId();
  const alicePage = await person(browser, baseURL!, { id: 'alice', name: 'Alice' });
  const alice = new Board(alicePage);
  await alice.open(roomId);
  await alice.placeNode('service', { x: 400, y: 300 });
  await alice.field('Name').fill('Orders API');
  await alice.page.keyboard.press('Escape');

  // Alice moves it into a new workspace.
  await shareButton(alicePage).click();
  const share = alicePage.getByRole('dialog', { name: 'Sharing' });
  await share.getByRole('textbox', { name: 'New workspace name' }).fill('Payments');
  await share.getByRole('textbox', { name: 'Diagram name' }).fill('Checkout');
  await share.getByRole('button', { name: 'Make private' }).click();
  await expect(shareButton(alicePage)).toHaveText('Private');
  await expect(alicePage.locator('.room-name')).toHaveText('Checkout');
  await alice.expectLive();

  // A stranger with the link is turned away and sees none of it.
  const strangerPage = await person(browser, baseURL!);
  await strangerPage.goto(`/${roomId}`);
  await expect(strangerPage.getByText('This diagram is private')).toBeVisible();
  await new Board(strangerPage).expectCounts(0, 0);

  // Alice invites Bob to view.
  await shareButton(alicePage).click();
  await share.getByRole('combobox', { name: 'Invite as' }).selectOption('viewer');
  await share.getByRole('button', { name: 'Create link' }).click();
  const inviteUrl = await share.getByRole('textbox', { name: 'Invite link' }).inputValue();
  expect(inviteUrl).toContain('/invite/keel_inv_');

  const bobPage = await person(browser, baseURL!, { id: 'bob', name: 'Bob' });
  await bobPage.goto(new URL(inviteUrl).pathname);
  await expect(bobPage.getByRole('heading', { name: 'Join Payments' })).toBeVisible();
  await bobPage.getByRole('button', { name: 'Join as Bob' }).click();

  // The landing page lists the workspace's diagram; opening it is read-only.
  await bobPage.getByRole('link', { name: 'Checkout' }).click();
  const bob = new Board(bobPage);
  await bob.expectLive();
  await expect(bob.nodeList.first()).toHaveText(/^Orders API, service/);
  await expect(bobPage.getByText('View only')).toBeVisible();
  await expect(bobPage.getByRole('toolbar', { name: 'Add a component' })).toHaveCount(0);
  await bob.canvas.click({ position: { x: 400, y: 300 } });
  await expect(bob.field('Name')).toBeDisabled();

  // Promoted to editor, Bob's board unlocks without a reload. Reopened, so
  // the member list includes Bob, who joined after it was loaded.
  await alicePage.keyboard.press('Escape');
  await shareButton(alicePage).click();
  await share.getByRole('combobox', { name: 'Role for Bob' }).selectOption('editor');
  await expect(bobPage.getByText('View only')).toBeHidden();
  await expect(bobPage.getByRole('toolbar', { name: 'Add a component' })).toBeVisible();

  for (const page of [alicePage, strangerPage, bobPage]) await page.context().close();
});

test('a collector needs a token to report into a private room', async ({ browser, baseURL, request }) => {
  const roomId = await newRoomId();
  const page = await person(browser, baseURL!, { id: 'carol', name: 'Carol' });
  await new Board(page).open(roomId);
  await shareButton(page).click();
  const share = page.getByRole('dialog', { name: 'Sharing' });
  await share.getByRole('textbox', { name: 'New workspace name' }).fill('Platform');
  await share.getByRole('button', { name: 'Make private' }).click();
  await expect(shareButton(page)).toHaveText('Private');

  const body = { source: 'kubernetes', observedAt: new Date().toISOString(), nodes: [] };
  expect((await request.post(`/api/rooms/${roomId}/observations`, { data: body })).status()).toBe(401);

  await shareButton(page).click();
  await share.getByRole('textbox', { name: 'Token name' }).fill('prod cluster');
  await share.getByRole('button', { name: 'New token' }).click();
  const secret = await share.getByRole('textbox', { name: 'New token' }).inputValue();
  expect(secret).toMatch(/^keel_ing_/);

  const accepted = await request.post(`/api/rooms/${roomId}/observations`, {
    data: body,
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(accepted.status()).toBe(202);
  await expect(share.getByText('prod cluster')).toBeVisible();
  await page.context().close();
});

test('leaving a room for a new one does not carry its diagram along', async ({ page }) => {
  // Entirely in-app (router navigation and history), so the app instance, and
  // the collaboration service in it, survive from one room to the next.
  const board = new Board(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a new diagram' }).click();
  await board.expectLive();
  await board.loadExample();
  await board.expectCounts(11, 12);

  await page.goBack();
  await page.getByRole('button', { name: 'Start a new diagram' }).click();
  await board.expectLive();
  await board.expectCounts(0, 0);
});

test('an owner deleting a diagram removes it for everyone, including their offline copies', async ({ browser, baseURL }) => {
  const roomId = await newRoomId();
  const ownerPage = await person(browser, baseURL!, { id: 'dana', name: 'Dana' });
  const owner = new Board(ownerPage);
  await owner.open(roomId);
  await owner.loadExample();
  await shareButton(ownerPage).click();
  const share = ownerPage.getByRole('dialog', { name: 'Sharing' });
  await share.getByRole('textbox', { name: 'New workspace name' }).fill('Ops');
  await share.getByRole('button', { name: 'Make private' }).click();
  await expect(shareButton(ownerPage)).toHaveText('Private');
  await owner.expectLive();

  // A second tab of the same person, open on the diagram.
  const otherTab = await ownerPage.context().newPage();
  const other = new Board(otherTab);
  await other.open(roomId);
  await other.expectCounts(11, 12);

  ownerPage.once('dialog', (dialog) => void dialog.accept());
  await shareButton(ownerPage).click();
  await share.getByRole('button', { name: 'Delete diagram' }).click();
  await expect(ownerPage).toHaveURL(/\/$/);

  await expect(otherTab.getByText('This diagram was deleted')).toBeVisible();
  await other.expectCounts(0, 0);

  // Reloading does not resurrect it from IndexedDB.
  await otherTab.reload();
  await expect(otherTab.getByText('This diagram was deleted')).toBeVisible();
  await other.expectCounts(0, 0);
  await ownerPage.context().close();
});
