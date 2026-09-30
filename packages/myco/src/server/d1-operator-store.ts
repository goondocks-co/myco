/**
 * A hosted Deployment's database, as a relational store the operator's machine reaches over the D1 API with its own
 * login (`queryD1Answer`).
 *
 * It serves statements one at a time. It runs no batch, and refuses one: the D1 API answers one statement per request
 * here, and a store that ran a batch's statements one by one would break the all-or-nothing batch every caller of a
 * store may rely on. What runs over it — a first-owner setup (`core/first-owner.ts`) — carries a guard on each
 * statement instead.
 */
import type { PreparedStatement, RelationalStore, RunResult } from '@myco-server-worker/core/adapters.js';
import { queryD1Answer, type D1QueryContext } from './cloudflare-d1-export.js';

/** The operator's store over the Deployment's D1, reached with `context`'s login. */
export function d1OperatorStore(context: D1QueryContext): RelationalStore {
  const statement = (sql: string, params: readonly unknown[]): PreparedStatement => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async <T,>() => ((await queryD1Answer(context, sql, params)).results[0] as T | undefined) ?? null,
    all: async <T,>() => ({ results: (await queryD1Answer(context, sql, params)).results as T[] }),
    run: async () => {
      const answer = await queryD1Answer(context, sql, params);
      const result: RunResult = { results: answer.results, meta: { changes: answer.changes } };
      return result;
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async () => { throw new Error('the operator store runs statements one at a time and runs no batch'); },
  };
}
