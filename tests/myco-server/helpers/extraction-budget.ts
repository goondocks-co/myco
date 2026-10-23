import type { PreparedStatement, RelationalStore, RunResult } from '@myco-server-worker/core/adapters.js';

/** Batch concurrent fixture calls while retaining each production writer's statements and result slice. */
export function fixtureBatchStore(db: RelationalStore): RelationalStore {
  let pending: { statements: PreparedStatement[]; resolve(results: RunResult[]): void; reject(error: unknown): void }[] = [];
  const schedule = (statements: PreparedStatement[]): Promise<RunResult[]> => new Promise((resolve, reject) => {
    pending.push({ statements, resolve, reject });
    if (pending.length > 1) return;
    queueMicrotask(async () => {
      const calls = pending;
      pending = [];
      try {
        const results = await db.batch(calls.flatMap(call => call.statements));
        let offset = 0;
        for (const call of calls) { call.resolve(results.slice(offset, offset + call.statements.length)); offset += call.statements.length; }
      } catch (error) { for (const call of calls) call.reject(error); }
    });
  });
  const originals = new WeakMap<PreparedStatement, PreparedStatement>();
  const wrap = (statement: PreparedStatement): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: async <T,>() => (await schedule([statement]))[0]!.results[0] as T ?? null,
      all: async <T,>() => ({ results: (await schedule([statement]))[0]!.results as T[] }),
      run: async () => (await schedule([statement]))[0]!,
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  return { prepare: sql => wrap(db.prepare(sql)), batch: statements => schedule(statements.map(statement => {
    const original = originals.get(statement);
    if (original === undefined) throw new Error('fixture batch received a foreign statement');
    return original;
  })) };
}

