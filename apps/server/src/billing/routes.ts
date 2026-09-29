import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import type { AccessStore, Role } from '../access/store.ts';
import type { SessionUser } from '../auth/session.ts';
import type { BillingService, StripeEvent } from './service.ts';
import { verifyStripeSignature } from './stripe.ts';

export interface BillingRouteDeps {
  billing: BillingService;
  access: AccessStore;
  readUser: (request: FastifyRequest) => Promise<SessionUser | null>;
  webhookSecret: string | null;
  publicUrl: string;
  limit: RouteShorthandOptions;
  log: { warn: (details: object, message: string) => void };
}

const WorkspaceIdSchema = z.uuid();

/**
 * Plans and payment for workspaces. Buying and managing a subscription happen
 * on Stripe's hosted pages; this server only opens them and listens to the
 * webhook, so no card details ever pass through Keel.
 */
export function registerBillingRoutes(app: FastifyInstance, deps: BillingRouteDeps): void {
  const { billing, access } = deps;

  type Membership = { ok: true; workspaceId: string; role: Role } | { ok: false; status: number; error: string };
  const member = async (request: FastifyRequest): Promise<Membership> => {
    const workspaceId = WorkspaceIdSchema.safeParse((request.params as { workspaceId?: unknown }).workspaceId);
    if (!workspaceId.success) return { ok: false, status: 400, error: 'invalid workspace id' };
    const user = await deps.readUser(request);
    if (!user) return { ok: false, status: 401, error: 'sign in first' };
    const role = await access.roleOf(workspaceId.data, user.id);
    if (!role) return { ok: false, status: 404, error: 'workspace not found' };
    return { ok: true, workspaceId: workspaceId.data, role };
  };

  app.get('/api/workspaces/:workspaceId/billing', deps.limit, async (request, reply) => {
    const ctx = await member(request);
    if (!ctx.ok) return reply.status(ctx.status).send({ error: ctx.error });
    if (!billing.enabled) return { enabled: false };

    const [plan, subscription, usage] = await Promise.all([
      billing.planOf(ctx.workspaceId),
      billing.subscription(ctx.workspaceId),
      billing.usage(ctx.workspaceId),
    ]);
    return {
      enabled: true,
      plan,
      status: subscription?.status ?? null,
      periodEnd: subscription?.periodEnd ?? null,
      usage,
      canManage: ctx.role === 'owner',
      hasCustomer: subscription !== null,
      purchasable: billing.purchasable,
    };
  });

  app.post('/api/workspaces/:workspaceId/billing/checkout', deps.limit, async (request, reply) => {
    if (!billing.enabled) return reply.status(404).send({ error: 'billing is not configured' });
    const ctx = await member(request);
    if (!ctx.ok) return reply.status(ctx.status).send({ error: ctx.error });
    if (ctx.role !== 'owner') return reply.status(403).send({ error: 'only an owner can change the plan' });
    const body = z.object({ plan: z.enum(['team', 'business']) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid request', issues: body.error.issues });
    if (!billing.purchasable.some((p) => p.id === body.data.plan)) return reply.status(400).send({ error: 'that plan is not for sale here' });
    // An existing subscription changes plan in the portal, not with a second subscription.
    if ((await billing.planOf(ctx.workspaceId)).id !== 'free') {
      return reply.status(409).send({ error: 'this workspace already has a paid plan: change it from Manage billing' });
    }

    const back = `${new URL(deps.publicUrl).origin}/?workspace=${ctx.workspaceId}`;
    const url = await billing.checkoutUrl(ctx.workspaceId, body.data.plan, {
      successUrl: `${back}&billing=success`,
      cancelUrl: `${back}&billing=cancelled`,
    });
    return { url };
  });

  app.post('/api/workspaces/:workspaceId/billing/portal', deps.limit, async (request, reply) => {
    if (!billing.enabled) return reply.status(404).send({ error: 'billing is not configured' });
    const ctx = await member(request);
    if (!ctx.ok) return reply.status(ctx.status).send({ error: ctx.error });
    if (ctx.role !== 'owner') return reply.status(403).send({ error: 'only an owner can manage billing' });
    const url = await billing.portalUrl(ctx.workspaceId, `${new URL(deps.publicUrl).origin}/?workspace=${ctx.workspaceId}`);
    if (!url) return reply.status(409).send({ error: 'this workspace has never had a paid plan' });
    return { url };
  });

  // The webhook needs the exact bytes Stripe signed, so JSON parsing is
  // switched off for this one route (a scoped content-type parser).
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));

    scope.post('/api/billing/webhook', async (request, reply) => {
      if (!billing.enabled || !deps.webhookSecret) return reply.status(404).send({ error: 'billing is not configured' });
      const raw = typeof request.body === 'string' ? request.body : '';
      const signature = request.headers['stripe-signature'];
      if (!verifyStripeSignature(raw, typeof signature === 'string' ? signature : undefined, deps.webhookSecret)) {
        return reply.status(400).send({ error: 'invalid signature' });
      }

      let event: StripeEvent;
      try {
        event = JSON.parse(raw) as StripeEvent;
      } catch {
        return reply.status(400).send({ error: 'invalid payload' });
      }
      if (typeof event.type !== 'string') return reply.status(400).send({ error: 'invalid payload' });

      try {
        await billing.handleEvent(event);
      } catch (error) {
        // A 500 makes Stripe retry, which is what a transient failure needs.
        deps.log.warn({ err: error, type: event.type }, 'stripe webhook failed');
        return reply.status(500).send({ error: 'could not apply the event' });
      }
      return { received: true };
    });
  });
}
