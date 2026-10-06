import type { PreparedStatement, RelationalStore, RunResult } from './adapters.js';
import { significantStatement } from './sql-statements.js';

/** Mutations and their authority assertion execute in one atomic store batch. */
export function writeGuardStore(
  db: RelationalStore,
  assertion: () => PreparedStatement,
  refusal: (error: unknown) => never,
  options: { assertAfter?: boolean } = {},
): RelationalStore {
  const underlying = new WeakMap<PreparedStatement, { statement: PreparedStatement; writes: boolean }>();
  const execute = (statements: PreparedStatement[]) => writeGuardBatch(db, assertion, refusal, statements, options);
  const wrap = (statement: PreparedStatement, writes: boolean): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), writes),
      run: async () => writes ? (await execute([statement]))[0]! : statement.run(),
      all: async <T,>() => writes ? { results: (await execute([statement]))[0]!.results as T[] } : statement.all<T>(),
      first: async <T,>() => writes ? ((await execute([statement]))[0]!.results[0] as T | undefined) ?? null : statement.first<T>(),
    };
    underlying.set(wrapped, { statement, writes });
    return wrapped;
  };
  return {
    prepare: sql => wrap(db.prepare(sql), !/^SELECT\b/i.test(significantStatement(sql))),
    batch: async statements => {
      const captured = statements.map(statement => {
        const held = underlying.get(statement);
        if (held === undefined) throw new Error('guarded batch requires statements from its own store');
        return held;
      });
      const statementsToRun = captured.map(held => held.statement);
      return captured.some(held => held.writes) ? execute(statementsToRun) : db.batch(statementsToRun);
    },
  };
}

/** The assertion and every supplied mutation commit together or leave no rows. */
export async function writeGuardBatch(
  db: RelationalStore, assertion: () => PreparedStatement, refusal: (error: unknown) => never,
  statements: PreparedStatement[], options: { assertAfter?: boolean } = {},
): Promise<RunResult[]> {
  try {
    const results = await db.batch([assertion(), ...statements, ...(options.assertAfter ? [assertion()] : [])]);
    return results.slice(1, options.assertAfter ? -1 : undefined);
  } catch (error) { return refusal(error); }
}
