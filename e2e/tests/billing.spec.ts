import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E_STRIPE_WEBHOOK_SECRET, FAKE_STRIPE_PORT } from '../playwright.config.ts';
import { Board, newRoomId } from './board.ts';
import { signIn } from './session.ts';

/**
 * Billing, end to end: a free workspace meets its limits, its owner goes
 * through Checkout (a local fake of Stripe's hosted page), Stripe's signed
 * webhook arrives, and the plan changes. The server talks to the fake exactly
 * as it would to api.stripe.com.
 */

const fakeStripe = `http://127.0.0.1:${FAKE_STRIPE_PORT}`;

/** Sign and deliver a webhook the way Stripe does. */
async function deliver(page: Page, event: object): Promise<void> {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', E2E_STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  const response = await page.request.post('/api/billing/webhook', {
    data: body,
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
  });
  expect(response.status()).toBe(200);
}

async function makePrivate(page: Page, workspace: { newName?: string; existing?: string }, diagram: string): Promise<void> {
  await page.getByRole('button', { name: /^(Share|Private)$/ }).click();
  const share = page.getByRole('dialog', { name: 'Sharing' });
  if (workspace.existing) await share.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: workspace.existing });
  if (workspace.newName) await share.getByRole('textbox', { name: 'New workspace name' }).fill(workspace.newName);
  await share.getByRole('textbox', { name: 'Diagram name' }).fill(diagram);
  await share.getByRole('button', { name: 'Make private' }).click();
}

test('a free workspace meets its limit, upgrades through Checkout, and the webhook lifts it', async ({ page, context, baseURL }) => {
  const owner = `owner-${await newRoomId()}`;
  await signIn(context, baseURL!, owner, 'Olga');
  const board = new Board(page);

  // Three diagrams fill a free workspace.
  await board.open(await newRoomId());
  await makePrivate(page, { newName: 'Platform' }, 'One');
  await expect(page.getByRole('button', { name: 'Private', exact: true })).toBeVisible();
  const { workspaces } = (await (await page.request.get('/api/workspaces')).json()) as { workspaces: { id: string }[] };
  const workspaceId = workspaces[0]!.id;
  for (const name of ['Two', 'Three']) {
    expect((await page.request.put(`/api/rooms/${await newRoomId()}/workspace`, { data: { workspaceId, name } })).status()).toBe(200);
  }

  // The fourth is refused, with the reason and the way out.
  await board.open(await newRoomId());
  await makePrivate(page, { existing: 'Platform' }, 'Four');
  await expect(page.getByRole('dialog', { name: 'Sharing' })).toContainText('Free plan workspaces can hold 3 diagrams. Upgrade to add more.');

  // The landing page shows the plan, and the owner upgrades.
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Your workspaces' }).locator('.workspace', { hasText: 'Platform' });
  await expect(card).toContainText('Free plan');
  await expect(card).toContainText('1 of 3 editors · 0 viewers · 3 of 3 diagrams');
  await card.getByRole('button', { name: 'Upgrade to Team' }).click();
  await expect(page).toHaveURL(`${fakeStripe}/checkout`);
  await expect(page.getByRole('heading', { name: 'Fake Stripe checkout' })).toBeVisible();

  // What Keel asked Stripe for.
  const sent = (await (await page.request.get(`${fakeStripe}/requests`)).json()) as { path: string; params: Record<string, string> }[];
  const checkout = sent.filter((r) => r.path === '/v1/checkout/sessions').at(-1)!;
  expect(checkout.params).toMatchObject({
    mode: 'subscription',
    'line_items[0][price]': 'price_team_e2e',
    'line_items[0][quantity]': '1',
    client_reference_id: workspaceId,
    'subscription_data[metadata][workspace_id]': workspaceId,
    success_url: `${baseURL}/?workspace=${workspaceId}&billing=success`,
  });

  // Stripe confirms, by webhook, and the owner comes back.
  await deliver(page, { type: 'checkout.session.completed', data: { object: { client_reference_id: workspaceId, customer: 'cus_e2e', subscription: 'sub_e2e' } } });
  await deliver(page, {
    type: 'customer.subscription.created',
    data: {
      object: {
        id: 'sub_e2e',
        customer: 'cus_e2e',
        status: 'active',
        metadata: { workspace_id: workspaceId },
        items: { data: [{ id: 'si_e2e', price: { id: 'price_team_e2e' } }] },
      },
    },
  });
  await page.goto(`/?workspace=${workspaceId}&billing=success`);
  await expect(page.getByRole('status')).toContainText('Your plan updates as soon as Stripe confirms');
  await expect(card).toContainText('Team plan');
  await expect(card).toContainText('3 of 50 diagrams');

  // The limit is gone.
  expect((await page.request.put(`/api/rooms/${await newRoomId()}/workspace`, { data: { workspaceId, name: 'Four' } })).status()).toBe(200);

  // And billing is managed on Stripe's portal.
  await card.getByRole('button', { name: 'Manage billing' }).click();
  await expect(page).toHaveURL(`${fakeStripe}/portal`);
});

test('a forged webhook changes nothing', async ({ page }) => {
  const response = await page.request.post('/api/billing/webhook', {
    data: JSON.stringify({ type: 'customer.subscription.updated', data: { object: {} } }),
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
  });
  expect(response.status()).toBe(400);
});
