import type { PreparedStatement, RelationalStore, RunResult } from './adapters.js';
import { runCallerGuard, type RunCaller } from './runs.js';
import { significantStatement } from './sql-statements.js';

const EXPIRED_PATH = '$[myco_run_write_expired]';

export class RunWriteExpired extends Error {
  constructor() { super('credential holds no live run'); }
}

/** Run mutations and their authority assertions commit in one atomic store batch. */
export function runWriteStore(db: RelationalStore, projectId: string, runId: string, caller: RunCaller): RelationalStore {
  const underlying = new WeakMap<PreparedStatement, { statement: PreparedStatement; writes: boolean }>();
  const assertion = (): PreparedStatement => {
    const guard = runCallerGuard(caller, "status = 'running'");
    // An invalid JSON path aborts the transaction with a named authority failure.
    return db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?${guard.sql}
    ) THEN 1 ELSE json_extract('[]', ?) END AS admitted`)
      .bind(projectId, runId, ...guard.params, EXPIRED_PATH);
  };
  const execute = async (statements: PreparedStatement[]): Promise<RunResult[]> => {
    try {
      const results = await db.batch([assertion(), ...statements, assertion()]);
      return results.slice(1, -1);
    } catch (error) {
      if (error instanceof Error && error.message.includes(EXPIRED_PATH.slice(1))) throw new RunWriteExpired();
      throw error;
    }
  };
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
        if (held === undefined) throw new Error('run batch requires statements from its own store');
        return held;
      });
      const statementsToRun = captured.map(held => held.statement);
      return captured.some(held => held.writes) ? execute(statementsToRun) : db.batch(statementsToRun);
    },
  };
}
