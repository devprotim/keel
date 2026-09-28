import type { Pool, PoolClient } from 'pg';

/**
 * The slice of a Postgres driver the store needs.
 *
 * Narrow on purpose: node-postgres in production and PGlite (real Postgres,
 * compiled to WASM) in tests both fit behind it, so the contract tests run the
 * same SQL against the same engine the service uses, not a mock of it.
 */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface SqlDatabase extends SqlExecutor {
  /** Run `fn` inside one transaction on one connection; roll back if it throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** Adapt a node-postgres pool. Transactions check out a dedicated client. */
export function fromPgPool(pool: Pool): SqlDatabase {
  const executor = (client: Pool | PoolClient): SqlExecutor => ({
    query: async <Row>(text: string, params?: unknown[]) => {
      const result = await client.query(text, params);
      return { rows: result.rows as Row[] };
    },
  });

  return {
    ...executor(pool),
    async transaction(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn(executor(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // A failed ROLLBACK means the connection itself is broken. Releasing it
        // with that error tells the pool to discard it rather than hand a
        // half-open transaction to the next caller.
        await client.query('ROLLBACK').catch((rollbackError: unknown) => {
          broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        });
        throw error;
      } finally {
        client.release(broken);
      }
    },
    end: () => pool.end(),
  };
}
