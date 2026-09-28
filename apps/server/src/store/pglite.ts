import type { PGlite } from '@electric-sql/pglite';
import type { SqlDatabase, SqlExecutor } from './sql.ts';

/**
 * Adapt PGlite (real Postgres, compiled to WASM) to the store's driver slice.
 * Test-only: it lets the Postgres store's contract run with no database server.
 */
export function fromPGlite(pg: PGlite): SqlDatabase {
  const executor = (client: Pick<PGlite, 'query'>): SqlExecutor => ({
    query: async <Row>(text: string, params?: unknown[]) => {
      const result = await client.query<Row>(text, params);
      return { rows: result.rows };
    },
  });

  return {
    ...executor(pg),
    transaction: (fn) => pg.transaction((tx) => fn(executor(tx))),
    end: () => pg.close(),
  };
}
