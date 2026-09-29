import type { SqlDatabase } from '../store/sql.ts';
import type { PlanId } from './plans.ts';

/**
 * Which plan each workspace is on, as Stripe last told us.
 *
 * Stripe is the source of truth; this is its latest word, written only by the
 * webhook, so a workspace's plan never depends on a redirect the browser may
 * not complete. No row means the free plan.
 */
export interface Subscription {
  workspaceId: string;
  plan: PlanId;
  /** Stripe's subscription status: active, trialing, past_due, canceled, ... */
  status: string;
  customerId: string;
  subscriptionId: string | null;
  /** The subscription item that carries the seat quantity, for seat syncing. */
  itemId: string | null;
  /** ISO time the paid period ends, when Stripe said. */
  periodEnd: string | null;
}

export interface BillingStore {
  get(workspaceId: string): Promise<Subscription | null>;
  byCustomer(customerId: string): Promise<Subscription | null>;
  put(subscription: Subscription): Promise<void>;
}

export class MemoryBillingStore implements BillingStore {
  readonly #rows = new Map<string, Subscription>();

  async get(workspaceId: string): Promise<Subscription | null> {
    return this.#rows.get(workspaceId) ?? null;
  }

  async byCustomer(customerId: string): Promise<Subscription | null> {
    return [...this.#rows.values()].find((s) => s.customerId === customerId) ?? null;
  }

  async put(subscription: Subscription): Promise<void> {
    this.#rows.set(subscription.workspaceId, { ...subscription });
  }
}

interface Row {
  workspace_id: string;
  plan: PlanId;
  status: string;
  customer_id: string;
  subscription_id: string | null;
  item_id: string | null;
  period_end: Date | string | null;
}

export class PostgresBillingStore implements BillingStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  async get(workspaceId: string): Promise<Subscription | null> {
    const { rows } = await this.#db.query<Row>('SELECT * FROM workspace_billing WHERE workspace_id = $1', [workspaceId]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async byCustomer(customerId: string): Promise<Subscription | null> {
    const { rows } = await this.#db.query<Row>('SELECT * FROM workspace_billing WHERE customer_id = $1', [customerId]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async put(s: Subscription): Promise<void> {
    await this.#db.query(
      `INSERT INTO workspace_billing (workspace_id, plan, status, customer_id, subscription_id, item_id, period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id) DO UPDATE SET
         plan = EXCLUDED.plan, status = EXCLUDED.status, customer_id = EXCLUDED.customer_id,
         subscription_id = EXCLUDED.subscription_id, item_id = EXCLUDED.item_id,
         period_end = EXCLUDED.period_end, updated_at = now()`,
      [s.workspaceId, s.plan, s.status, s.customerId, s.subscriptionId, s.itemId, s.periodEnd],
    );
  }
}

function fromRow(row: Row): Subscription {
  const end = row.period_end;
  return {
    workspaceId: row.workspace_id,
    plan: row.plan,
    status: row.status,
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    itemId: row.item_id,
    periodEnd: end === null ? null : new Date(end).toISOString(),
  };
}
