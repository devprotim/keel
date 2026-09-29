import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The few Stripe calls billing needs, over its REST API.
 *
 * No SDK: three form-encoded POSTs and one signature check are less to audit
 * and update than a client library, and the interface is what tests replace.
 */
export interface StripeApi {
  /** A hosted Checkout page for a new subscription. Returns its URL. */
  createCheckout(input: CheckoutInput): Promise<string>;
  /** A hosted billing portal page for an existing customer. Returns its URL. */
  createPortal(customerId: string, returnUrl: string): Promise<string>;
  /** Set the quantity on a subscription item, for per-seat plans. */
  setQuantity(itemId: string, quantity: number): Promise<void>;
}

export interface CheckoutInput {
  priceId: string;
  quantity: number;
  workspaceId: string;
  /** Reuse the workspace's Stripe customer when it already has one. */
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}

export class StripeRestApi implements StripeApi {
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(secretKey: string, fetchImpl: typeof fetch = fetch, base = 'https://api.stripe.com') {
    this.#secretKey = secretKey;
    this.#fetch = fetchImpl;
    this.#base = base.replace(/\/$/, '');
  }

  async createCheckout(input: CheckoutInput): Promise<string> {
    const params: Record<string, string> = {
      mode: 'subscription',
      'line_items[0][price]': input.priceId,
      'line_items[0][quantity]': String(input.quantity),
      // Both, so every event about this subscription can be traced back to the
      // workspace: the session carries the reference, the subscription the metadata.
      client_reference_id: input.workspaceId,
      'subscription_data[metadata][workspace_id]': input.workspaceId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: 'true',
    };
    if (input.customerId) params['customer'] = input.customerId;
    const session = await this.#post<{ url?: string }>('/v1/checkout/sessions', params);
    if (!session.url) throw new Error('Stripe returned a Checkout session without a URL');
    return session.url;
  }

  async createPortal(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.#post<{ url?: string }>('/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    if (!session.url) throw new Error('Stripe returned a portal session without a URL');
    return session.url;
  }

  async setQuantity(itemId: string, quantity: number): Promise<void> {
    await this.#post(`/v1/subscription_items/${encodeURIComponent(itemId)}`, {
      quantity: String(quantity),
      proration_behavior: 'create_prorations',
    });
  }

  async #post<T>(path: string, params: Record<string, string>): Promise<T> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(`Stripe ${path} failed (${response.status}): ${body.error?.message ?? 'no message'}`);
    return body;
  }
}

/**
 * Check a webhook's `Stripe-Signature` header against the raw body.
 *
 * Stripe signs `<timestamp>.<raw body>` with HMAC-SHA256 under the endpoint's
 * signing secret and sends `t=<timestamp>,v1=<hex>[,v1=...]`. Any matching v1
 * passes; an old timestamp fails even with a valid signature, so a captured
 * event cannot be replayed later. Five minutes matches Stripe's own libraries.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  { now = Date.now(), toleranceSeconds = 300 }: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!header) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2).map((s) => s.trim());
    if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'));
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Sign a payload the way Stripe does. For tests and local webhook replay. */
export function signStripePayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}
