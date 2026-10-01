import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { MemoryAccessStore } from '../access/store.ts';
import { loadConfig } from '../config.ts';
import { migrate } from '../store/migrations.ts';
import { fromPGlite } from '../store/pglite.ts';
import { MemoryDocStore } from '../store/store.ts';
import { MemoryBillingStore, PostgresBillingStore, type BillingStore } from './store.ts';
import { signStripePayload, verifyStripeSignature, type CheckoutInput, type StripeApi } from './stripe.ts';

const SECRET = 's'.repeat(32);
const WEBHOOK_SECRET = 'whsec_test';

/** Rooms only open once made; these are the ones the tests below use. */
async function roomStore(): Promise<MemoryDocStore> {
  const store = new MemoryDocStore();
  for (const roomId of ['room-open', ...Array.from({ length: 10 }, (_, i) => `room-${i}`)]) await store.create(roomId);
  return store;
}

/** Records what would have gone to Stripe. */
class FakeStripe implements StripeApi {
  checkouts: CheckoutInput[] = [];
  portals: string[] = [];
  quantities: [string, number][] = [];
  async createCheckout(input: CheckoutInput): Promise<string> {
    this.checkouts.push(input);
    return 'https://checkout.stripe.test/session';
  }
  async createPortal(customerId: string): Promise<string> {
    this.portals.push(customerId);
    return 'https://billing.stripe.test/portal';
  }
  async setQuantity(itemId: string, quantity: number): Promise<void> {
    this.quantities.push([itemId, quantity]);
  }
}

let app: FastifyInstance;
let stripe: FakeStripe;

async function start(env: Record<string, string> = {}): Promise<void> {
  stripe = new FakeStripe();
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: SECRET,
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      PUBLIC_URL: 'https://keel.test',
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_TEAM: 'price_team',
      ...env,
    }),
    store: await roomStore(),
    accessStore: new MemoryAccessStore(),
    billingStore: new MemoryBillingStore(),
    stripeApi: stripe,
  });
  await app.ready();
}

async function cookieFor(id: string): Promise<string> {
  const token = await new SignJWT({ id: `github:${id}`, provider: 'github', name: id, avatarUrl: null })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));
  return `keel_session=${token}`;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: Method, url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: cookie ? { cookie } : {} });

async function workspace() {
  const owner = await cookieFor('owner');
  const created = await call('POST', '/api/workspaces', owner, { name: 'Payments' });
  return { owner, id: created.json<{ workspace: { id: string } }>().workspace.id };
}

async function invite(workspaceId: string, owner: string, role: 'editor' | 'viewer', who: string) {
  const link = await call('POST', `/api/workspaces/${workspaceId}/invites`, owner, { role });
  const token = link.json<{ url: string }>().url.split('/invite/')[1] ?? '';
  return call('POST', `/api/invites/${token}/accept`, await cookieFor(who));
}

function webhook(event: object, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(event);
  return app.inject({
    method: 'POST',
    url: '/api/billing/webhook',
    payload: body,
    headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(body, secret) },
  });
}

const subscriptionEvent = (workspaceId: string, type = 'customer.subscription.updated', status = 'active') => ({
  id: 'evt_1',
  type,
  data: {
    object: {
      id: 'sub_1',
      customer: 'cus_1',
      status,
      metadata: { workspace_id: workspaceId },
      items: { data: [{ id: 'si_1', price: { id: 'price_team' }, current_period_end: 1_790_000_000 }] },
    },
  },
});

describe('verifyStripeSignature', () => {
  const body = '{"type":"x"}';
  const now = 1_790_000_000_000;

  it('accepts what Stripe signed, with any of several v1 signatures', () => {
    const header = signStripePayload(body, 'whsec', now / 1000);
    expect(verifyStripeSignature(body, header, 'whsec', { now })).toBe(true);
    expect(verifyStripeSignature(body, `${header},v1=deadbeef`, 'whsec', { now })).toBe(true);
  });

  it('rejects a changed body, the wrong secret, an old timestamp and a missing header', () => {
    const header = signStripePayload(body, 'whsec', now / 1000);
    expect(verifyStripeSignature('{"type":"y"}', header, 'whsec', { now })).toBe(false);
    expect(verifyStripeSignature(body, header, 'other', { now })).toBe(false);
    expect(verifyStripeSignature(body, header, 'whsec', { now: now + 301_000 })).toBe(false);
    expect(verifyStripeSignature(body, undefined, 'whsec', { now })).toBe(false);
    expect(verifyStripeSignature(body, 't=abc,v1=00', 'whsec', { now })).toBe(false);
  });
});

describe('billing', () => {
  beforeEach(() => start());
  afterEach(async () => {
    await app.close();
  });

  it('is off without Stripe keys, and then nothing is limited', async () => {
    await app.close();
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }),
      store: await roomStore(),
    });
    await app.ready();
    const { owner, id } = await workspace();
    expect((await call('GET', `/api/workspaces/${id}/billing`, owner)).json()).toEqual({ enabled: false });
    for (let i = 0; i < 5; i += 1) {
      expect((await call('PUT', `/api/rooms/room-${i}/workspace`, owner, { workspaceId: id, name: `D${i}` })).statusCode).toBe(200);
    }
    expect((await call('POST', `/api/workspaces/${id}/billing/checkout`, owner, { plan: 'team' })).statusCode).toBe(404);
  });

  it('refuses to boot with half a Stripe configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'test', STRIPE_PRICE_TEAM: 'price' })).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('holds a free workspace to its limits, and counts only editors against them', async () => {
    const { owner, id } = await workspace();
    const status = await call('GET', `/api/workspaces/${id}/billing`, owner);
    expect(status.json()).toMatchObject({
      enabled: true,
      plan: { id: 'free', limits: { editors: 3, rooms: 3 } },
      usage: { editors: 1, viewers: 0, rooms: 0 },
      canManage: true,
      purchasable: [{ id: 'team' }],
    });

    for (let i = 0; i < 3; i += 1) {
      expect((await call('PUT', `/api/rooms/room-${i}/workspace`, owner, { workspaceId: id, name: `D${i}` })).statusCode).toBe(200);
    }
    const fourth = await call('PUT', '/api/rooms/room-3/workspace', owner, { workspaceId: id, name: 'D3' });
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json()).toMatchObject({ limit: 'rooms', plan: 'free' });

    expect((await invite(id, owner, 'editor', 'e1')).statusCode).toBe(200);
    expect((await invite(id, owner, 'editor', 'e2')).statusCode).toBe(200);
    expect((await invite(id, owner, 'editor', 'e3')).json()).toMatchObject({ limit: 'editors' });
    // Viewers are free on every plan.
    for (const who of ['v1', 'v2', 'v3', 'v4']) expect((await invite(id, owner, 'viewer', who)).statusCode).toBe(200);
    // Promoting one of them would be a fourth editor.
    expect((await call('PUT', `/api/workspaces/${id}/members/github:v1`, owner, { role: 'editor' })).statusCode).toBe(402);

    expect((await call('POST', '/api/rooms/room-0/ingest-tokens', owner, { name: 'prod' })).statusCode).toBe(201);
    expect((await call('POST', '/api/rooms/room-1/ingest-tokens', owner, { name: 'staging' })).json()).toMatchObject({ limit: 'collectors' });
  });

  it('keeps PagerDuty for paid plans, on link rooms too', async () => {
    const response = await call('PUT', '/api/rooms/room-open/alerts', undefined, { pagerduty: { routingKey: 'a'.repeat(32) } });
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ limit: 'pagerDuty' });
    expect((await call('PUT', '/api/rooms/room-open/alerts', undefined, { slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' } })).statusCode).toBe(200);
  });

  it('sends an owner to Checkout, charging for the editors there are', async () => {
    const { owner, id } = await workspace();
    await invite(id, owner, 'editor', 'e1');
    await invite(id, owner, 'viewer', 'v1');

    expect((await call('POST', `/api/workspaces/${id}/billing/checkout`, await cookieFor('e1'), { plan: 'team' })).statusCode).toBe(403);
    const checkout = await call('POST', `/api/workspaces/${id}/billing/checkout`, owner, { plan: 'team' });
    expect(checkout.json()).toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(stripe.checkouts).toEqual([
      {
        priceId: 'price_team',
        quantity: 2,
        workspaceId: id,
        customerId: null,
        successUrl: `https://keel.test/?workspace=${id}&billing=success`,
        cancelUrl: `https://keel.test/?workspace=${id}&billing=cancelled`,
      },
    ]);
    expect((await call('POST', `/api/workspaces/${id}/billing/checkout`, owner, { plan: 'business' })).statusCode).toBe(400);
  });

  it('upgrades only on a signed webhook, then lifts the limits and keeps seats in step', async () => {
    const { owner, id } = await workspace();
    expect((await webhook(subscriptionEvent(id), 'whsec_wrong')).statusCode).toBe(400);
    expect((await call('GET', `/api/workspaces/${id}/billing`, owner)).json()).toMatchObject({ plan: { id: 'free' } });

    expect((await webhook({ type: 'checkout.session.completed', data: { object: { client_reference_id: id, customer: 'cus_1', subscription: 'sub_1' } } })).statusCode).toBe(200);
    expect((await webhook(subscriptionEvent(id))).statusCode).toBe(200);
    expect((await call('GET', `/api/workspaces/${id}/billing`, owner)).json()).toMatchObject({
      plan: { id: 'team', limits: { editors: 25 } },
      status: 'active',
      periodEnd: new Date(1_790_000_000_000).toISOString(),
      hasCustomer: true,
    });

    for (let i = 0; i < 4; i += 1) {
      expect((await call('PUT', `/api/rooms/room-${i}/workspace`, owner, { workspaceId: id, name: `D${i}` })).statusCode).toBe(200);
    }
    await invite(id, owner, 'editor', 'e1');
    await invite(id, owner, 'viewer', 'v1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stripe.quantities).toEqual([['si_1', 2]]);

    expect((await call('POST', `/api/workspaces/${id}/billing/checkout`, owner, { plan: 'team' })).statusCode).toBe(409);
    expect((await call('POST', `/api/workspaces/${id}/billing/portal`, owner)).json()).toEqual({ url: 'https://billing.stripe.test/portal' });
    expect(stripe.portals).toEqual(['cus_1']);
  });

  it('falls back to free when the subscription ends or stops being paid', async () => {
    const { owner, id } = await workspace();
    await webhook(subscriptionEvent(id));
    await webhook(subscriptionEvent(id, 'customer.subscription.updated', 'unpaid'));
    expect((await call('GET', `/api/workspaces/${id}/billing`, owner)).json()).toMatchObject({ plan: { id: 'free' }, status: 'unpaid' });

    await webhook(subscriptionEvent(id, 'customer.subscription.updated', 'past_due'));
    expect((await call('GET', `/api/workspaces/${id}/billing`, owner)).json()).toMatchObject({ plan: { id: 'team' } });

    await webhook(subscriptionEvent(id, 'customer.subscription.deleted'));
    expect((await call('GET', `/api/workspaces/${id}/billing`, owner)).json()).toMatchObject({ plan: { id: 'free' }, status: 'canceled' });
  });

  it('ignores events for workspaces that do not exist, and events it does not handle', async () => {
    expect((await webhook(subscriptionEvent('00000000-0000-4000-8000-000000000000'))).statusCode).toBe(200);
    expect((await webhook({ type: 'invoice.paid', data: { object: {} } })).statusCode).toBe(200);
  });
});

const shared = new PGlite();
afterAll(() => shared.close());
let schemas = 0;

describe.each<[string, () => Promise<{ store: BillingStore; workspaceId: string }>]>([
  ['memory', async () => ({ store: new MemoryBillingStore(), workspaceId: 'ws-1' })],
  [
    'postgres (PGlite)',
    async () => {
      const schema = `billing_${++schemas}`;
      await shared.query(`CREATE SCHEMA ${schema}`);
      await shared.query(`SET search_path TO ${schema}`);
      const db = fromPGlite(shared);
      await migrate(db);
      const workspaceId = '11111111-1111-4111-8111-111111111111';
      await db.query('INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3)', [workspaceId, 'W', 'github:1']);
      return { store: new PostgresBillingStore(db), workspaceId };
    },
  ],
])('BillingStore contract: %s', (_name, create) => {
  it('stores a subscription, finds it by customer, and replaces it', async () => {
    const { store, workspaceId } = await create();
    expect(await store.get(workspaceId)).toBeNull();
    const subscription = {
      workspaceId,
      plan: 'team' as const,
      status: 'active',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      itemId: 'si_1',
      periodEnd: '2026-10-29T00:00:00.000Z',
    };
    await store.put(subscription);
    expect(await store.get(workspaceId)).toEqual(subscription);
    expect(await store.byCustomer('cus_1')).toEqual(subscription);

    await store.put({ ...subscription, plan: 'free', status: 'canceled', periodEnd: null });
    expect(await store.get(workspaceId)).toMatchObject({ plan: 'free', status: 'canceled', periodEnd: null });
  });
});
