import type { PreparedStatement, RelationalStore, RunResult } from '@myco-server-worker/core/adapters.js';

/** Observes real store work and admits a deterministic interleaving before a transaction. */
export function observeRestoreStore(source: RelationalStore, before: (sql: readonly string[]) => Promise<void> = async () => {}) {
  let reads = 0;
  const originals = new WeakMap<PreparedStatement, { statement: PreparedStatement; sql: string }>();
  const measure = (results: RunResult[]) => {
    for (const result of results) if ('rows_read' in result.meta && typeof result.meta.rows_read === 'number') reads += result.meta.rows_read;
    return results;
  };
  const wrap = (statement: PreparedStatement, sql: string): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), sql),
      run: async () => { await before([sql]); return measure([await statement.run()])[0]!; },
      all: async <T>() => { await before([sql]); const result = await statement.run(); measure([result]); return { results: result.results as T[] }; },
      first: async <T>() => { await before([sql]); const result = await statement.run(); measure([result]); return result.results[0] as T ?? null; },
    };
    originals.set(wrapped, { statement, sql });
    return wrapped;
  };
  const db: RelationalStore = {
    prepare: sql => wrap(source.prepare(sql), sql),
    batch: async statements => {
      const held = statements.map(statement => {
        const original = originals.get(statement);
        if (!original) throw new Error('unobserved restore statement');
        return original;
      });
      await before(held.map(row => row.sql));
      return measure(await source.batch(held.map(row => row.statement)));
    },
  };
  return { db, reads: () => reads, reset: () => { reads = 0; } };
}
