import type { AccessStore } from '../access/store.ts';
import { PLANS, UNLIMITED, type Plan, type PlanId, type PlanLimits } from './plans.ts';
import type { BillingStore, Subscription } from './store.ts';
import type { StripeApi } from './stripe.ts';

export interface BillingConfig {
  /** Stripe Price ids, by plan. A plan without one cannot be bought. */
  prices: Partial<Record<Exclude<PlanId, 'free'>, string>>;
  /** Charge per editor (owners and editors; viewers are free): checkout starts at that count, and role changes update it. */
  perSeat: boolean;
}

export interface Usage {
  /** Owners and editors, the people a per-seat plan charges for. */
  editors: number;
  viewers: number;
  rooms: number;
  collectors: number;
}

/** Statuses that keep a paid plan. past_due keeps it while Stripe retries the card. */
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Plans, limits and the Stripe side of both.
 *
 * With billing off (no Stripe keys) every workspace is unlimited, so a
 * self-hosted or local Keel never hits a paywall it has no way to lift.
 */
export class BillingService {
  readonly enabled: boolean;
  readonly #store: BillingStore;
  readonly #access: AccessStore;
  readonly #stripe: StripeApi | null;
  readonly #config: BillingConfig;

  constructor(deps: { store: BillingStore; access: AccessStore; stripe: StripeApi | null; config: BillingConfig }) {
    this.#store = deps.store;
    this.#access = deps.access;
    this.#stripe = deps.stripe;
    this.#config = deps.config;
    this.enabled = deps.stripe !== null && Object.values(deps.config.prices).some(Boolean);
  }

  /** Plans that can be bought here, in order. */
  get purchasable(): Plan[] {
    return (['team', 'business'] as const).filter((id) => this.#config.prices[id]).map((id) => PLANS[id]);
  }

  async subscription(workspaceId: string): Promise<Subscription | null> {
    return this.#store.get(workspaceId);
  }

  async planOf(workspaceId: string): Promise<Plan> {
    const subscription = await this.#store.get(workspaceId);
    return subscription && PAID_STATUSES.has(subscription.status) ? PLANS[subscription.plan] : PLANS.free;
  }

  /** What a workspace may have. `plan` is null when billing is off. */
  async limitsFor(workspaceId: string): Promise<{ plan: Plan | null; limits: PlanLimits }> {
    if (!this.enabled) return { plan: null, limits: UNLIMITED };
    const plan = await this.planOf(workspaceId);
    return { plan, limits: plan.limits };
  }

  /** What a room may use. A link room has no plan of its own, so it gets the free plan's features. */
  async limitsForRoom(roomId: string): Promise<{ plan: Plan | null; limits: PlanLimits }> {
    if (!this.enabled) return { plan: null, limits: UNLIMITED };
    const placement = await this.#access.placementOf(roomId);
    return placement ? this.limitsFor(placement.workspaceId) : { plan: PLANS.free, limits: PLANS.free.limits };
  }

  async usage(workspaceId: string): Promise<Usage> {
    const [members, rooms] = await Promise.all([this.#access.members(workspaceId), this.#access.roomsIn(workspaceId)]);
    const tokens = await Promise.all(rooms.map((room) => this.#access.ingestTokens(room.roomId)));
    const editors = members.filter((m) => m.role !== 'viewer').length;
    return {
      editors,
      viewers: members.length - editors,
      rooms: rooms.length,
      collectors: tokens.reduce((sum, list) => sum + list.length, 0),
    };
  }

  async checkoutUrl(workspaceId: string, plan: Exclude<PlanId, 'free'>, urls: { successUrl: string; cancelUrl: string }): Promise<string> {
    const priceId = this.#config.prices[plan];
    if (!this.#stripe || !priceId) throw new Error(`the ${plan} plan cannot be bought here`);
    const existing = await this.#store.get(workspaceId);
    const quantity = this.#config.perSeat ? Math.max(1, (await this.usage(workspaceId)).editors) : 1;
    return this.#stripe.createCheckout({ priceId, quantity, workspaceId, customerId: existing?.customerId ?? null, ...urls });
  }

  async portalUrl(workspaceId: string, returnUrl: string): Promise<string | null> {
    const existing = await this.#store.get(workspaceId);
    if (!this.#stripe || !existing) return null;
    return this.#stripe.createPortal(existing.customerId, returnUrl);
  }

  /**
   * Keep a per-seat subscription's quantity at the editor count. Best effort:
   * a failure is logged by the caller and the next membership change retries.
   */
  async syncSeats(workspaceId: string): Promise<void> {
    if (!this.#config.perSeat || !this.#stripe) return;
    const subscription = await this.#store.get(workspaceId);
    if (!subscription?.itemId || !PAID_STATUSES.has(subscription.status)) return;
    await this.#stripe.setQuantity(subscription.itemId, Math.max(1, (await this.usage(workspaceId)).editors));
  }

  /**
   * Apply one verified webhook event. Idempotent: Stripe delivers at least
   * once and in no guaranteed order, so each event writes the state it
   * describes rather than a change relative to the last one.
   */
  async handleEvent(event: StripeEvent): Promise<void> {
    const object = event.data?.object ?? {};

    if (event.type === 'checkout.session.completed') {
      const workspaceId = str(object['client_reference_id']);
      const customerId = str(object['customer']);
      if (!workspaceId || !customerId || !(await this.#access.getWorkspace(workspaceId))) return;
      const existing = await this.#store.get(workspaceId);
      const subscriptionId = str(object['subscription']);
      // The subscription events carry the plan; this only links the customer,
      // and must not undo a subscription event that arrived first.
      if (existing && existing.subscriptionId === subscriptionId) return;
      await this.#store.put({
        workspaceId,
        plan: existing?.plan ?? 'free',
        status: existing?.status ?? 'incomplete',
        customerId,
        subscriptionId,
        itemId: existing?.itemId ?? null,
        periodEnd: existing?.periodEnd ?? null,
      });
      return;
    }

    if (!event.type.startsWith('customer.subscription.')) return;
    const customerId = str(object['customer']);
    if (!customerId) return;
    const metadata = (object['metadata'] ?? {}) as Record<string, unknown>;
    const workspaceId = str(metadata['workspace_id']) ?? (await this.#store.byCustomer(customerId))?.workspaceId ?? null;
    if (!workspaceId || !(await this.#access.getWorkspace(workspaceId))) return;

    const item = ((object['items'] as { data?: unknown[] } | undefined)?.data?.[0] ?? {}) as Record<string, unknown>;
    const priceId = str((item['price'] as Record<string, unknown> | undefined)?.['id']);
    const deleted = event.type === 'customer.subscription.deleted';
    // Newer API versions moved the period end onto the item.
    const periodEnd = num(item['current_period_end']) ?? num(object['current_period_end']);

    await this.#store.put({
      workspaceId,
      plan: deleted ? 'free' : (this.#planForPrice(priceId) ?? 'free'),
      status: deleted ? 'canceled' : (str(object['status']) ?? 'incomplete'),
      customerId,
      subscriptionId: str(object['id']),
      itemId: str(item['id']),
      periodEnd: periodEnd === null ? null : new Date(periodEnd * 1000).toISOString(),
    });
  }

  #planForPrice(priceId: string | null): PlanId | null {
    if (!priceId) return null;
    const match = Object.entries(this.#config.prices).find(([, id]) => id === priceId);
    return (match?.[0] as PlanId | undefined) ?? null;
  }
}

export interface StripeEvent {
  id?: string;
  type: string;
  data?: { object?: Record<string, unknown> };
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
