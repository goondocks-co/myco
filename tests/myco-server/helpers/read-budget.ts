import type { Miniflare } from 'miniflare';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';

type D1 = Awaited<ReturnType<Miniflare['getD1Database']>>;

export function measuredStore(d1: D1) {
  let reads = 0;
  let historyQueries = 0;
  const originals = new WeakMap<PreparedStatement, ReturnType<D1['prepare']>>();
  const observe = (statement: ReturnType<D1['prepare']>): PreparedStatement => {
    const wrapped: PreparedStatement = {
    bind: (...values) => observe(statement.bind(...values)),
    first: async <T,>() => {
      const result = await statement.all<T>();
      reads += result.meta.rows_read;
      return result.results[0] ?? null;
    },
    all: async <T,>() => {
      const result = await statement.all<T>();
      reads += result.meta.rows_read;
      return result;
    },
    run: async () => {
      const result = await statement.run();
      reads += result.meta.rows_read;
      return result;
    },
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  const db: RelationalStore = {
    prepare: (sql) => {
      if (/SELECT (?:MAX\()?COALESCE\(queued_at, started_at\)/.test(sql)) historyQueries++;
      return observe(d1.prepare(sql));
    },
    batch: async (statements) => {
      const results = await d1.batch(statements.map((statement) => {
        const original = originals.get(statement);
        if (original === undefined) throw new Error('batch statement did not come from the measured D1 store');
        return original;
      }));
      reads += results.reduce((sum, result) => sum + result.meta.rows_read, 0);
      return results;
    },
  };
  return { db, reset: () => { reads = 0; historyQueries = 0; }, reads: () => reads, historyQueries: () => historyQueries };
}
