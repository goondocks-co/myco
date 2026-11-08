/**
 * The operator reaches D1 under its own login. Read batches use one API request;
 * writes remain individual statements carrying their own admission guards.
 */
import type { PreparedStatement, RelationalStore, RunResult } from '@myco-server-worker/core/adapters.js';
import { queryD1Answer, queryD1ReadBatch, type D1QueryContext, type D1ReadQuery } from './cloudflare-d1-export.js';

/** The operator's store over the Deployment's D1, reached with `context`'s login. */
export function d1OperatorStore(context: D1QueryContext): RelationalStore {
  const queries = new WeakMap<PreparedStatement, D1ReadQuery>();
  const statement = (sql: string, params: readonly unknown[]): PreparedStatement => {
    const prepared: PreparedStatement = {
      bind: (...values: unknown[]) => statement(sql, values),
      first: async <T,>() => ((await queryD1Answer(context, sql, params)).results[0] as T | undefined) ?? null,
      all: async <T,>() => ({ results: (await queryD1Answer(context, sql, params)).results as T[] }),
      run: async () => {
        const answer = await queryD1Answer(context, sql, params);
        const result: RunResult = { results: answer.results, meta: { changes: answer.changes } };
        return result;
      },
    };
    queries.set(prepared, { sql, params });
    return prepared;
  };
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async statements => {
      const batch = statements.map(statement => {
        const query = queries.get(statement);
        if (query === undefined) throw new Error('the operator store requires statements prepared by this store');
        return query;
      });
      return (await queryD1ReadBatch(context, batch)).map(answer => ({ results: answer.results, meta: { changes: answer.changes } }));
    },
  };
}
