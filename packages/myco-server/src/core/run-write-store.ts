import type { PreparedStatement, RelationalStore } from './adapters.js';
import { runCallerGuard, type RunCaller } from './runs.js';
import { writeGuardStore } from './write-guard-store.js';

const EXPIRED_PATH = '$[myco_run_write_expired]';

export class RunWriteExpired extends Error {
  constructor() { super('credential holds no live run'); }
}

/** Run mutations and their authority assertions commit in one atomic store batch. */
export function runWriteStore(db: RelationalStore, projectId: string, runId: string, caller: RunCaller): RelationalStore {
  const assertion = (): PreparedStatement => {
    const guard = runCallerGuard(caller, "status = 'running'");
    // An invalid JSON path aborts the transaction with a named authority failure.
    return db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?${guard.sql}
    ) THEN 1 ELSE json_extract('[]', ?) END AS admitted`)
      .bind(projectId, runId, ...guard.params, EXPIRED_PATH);
  };
  return writeGuardStore(db, assertion, error => {
    if (error instanceof Error && error.message.includes(EXPIRED_PATH.slice(1))) throw new RunWriteExpired();
    throw error;
  }, { assertAfter: true });
}
