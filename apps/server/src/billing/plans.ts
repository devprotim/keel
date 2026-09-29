/**
 * Plans and what each allows.
 *
 * Prices are not here: they live in Stripe, as the Price objects named by
 * STRIPE_PRICE_TEAM and STRIPE_PRICE_BUSINESS, so changing a price is a
 * dashboard change, not a deploy. The limits below are provisional: which
 * tiers exist and where the lines fall is the packaging decision in
 * PROJECT_PLAN task 13 (see docs/pricing/), and this table is its one place in
 * the code.
 *
 * Limits apply to workspaces. Link rooms stay free and unlimited: they are the
 * way in, and they have no owner to bill.
 */

export type PlanId = 'free' | 'team' | 'business';
export const PLAN_IDS: readonly PlanId[] = ['free', 'team', 'business'];

export interface PlanLimits {
  /**
   * Owners and editors. Viewers are free and unlimited on every plan: the
   * people who only look (on-call, reviewers) are the ones a team most wants
   * to bring in, and charging for them is what keeps them out.
   */
  editors: number | null;
  /** Diagrams in the workspace. */
  rooms: number | null;
  /** Collector (ingest) tokens across the workspace's diagrams. */
  collectors: number | null;
  /** PagerDuty as an alert channel. Slack is on every plan. */
  pagerDuty: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  limits: PlanLimits;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: { id: 'free', name: 'Free', limits: { editors: 3, rooms: 3, collectors: 1, pagerDuty: false } },
  team: { id: 'team', name: 'Team', limits: { editors: 25, rooms: 50, collectors: 10, pagerDuty: true } },
  business: { id: 'business', name: 'Business', limits: { editors: null, rooms: null, collectors: null, pagerDuty: true } },
};

/** Everything allowed: what a workspace gets when billing is not configured (self-hosted, local, tests). */
export const UNLIMITED: PlanLimits = { editors: null, rooms: null, collectors: null, pagerDuty: true };

export type Limited = 'editors' | 'rooms' | 'collectors' | 'pagerDuty';

/** Whether one more of `what` fits, given how many there are now. */
export function allows(limits: PlanLimits, what: Exclude<Limited, 'pagerDuty'>, current: number): boolean {
  const limit = limits[what];
  return limit === null || current < limit;
}

/** The error body a refused action returns, with enough for the client to explain and offer an upgrade. */
export function overLimit(plan: Plan | null, what: Limited): { error: string; limit: Limited; plan: PlanId | null } {
  const name = plan?.name ?? 'This';
  const messages: Record<Limited, string> = {
    editors: `${name} plan workspaces can have ${plan?.limits.editors ?? 'no more'} owners and editors. Viewers are unlimited; upgrade to add more editors.`,
    rooms: `${name} plan workspaces can hold ${plan?.limits.rooms ?? 'no more'} diagrams. Upgrade to add more.`,
    collectors: `${name} plan workspaces can have ${plan?.limits.collectors ?? 'no more'} collector tokens. Upgrade to add more.`,
    pagerDuty: `PagerDuty alerts need a paid plan. Slack works on every plan.`,
  };
  return { error: messages[what], limit: what, plan: plan?.id ?? null };
}
