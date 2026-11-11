/** The authority a run's own writes hold: the run is still running under the caller that dispatched it. */
import { textDigest } from '../composed-statements.js';
import { assertion, refusalCode, type BindValue, type Bound, type Statement } from '../index.js';
import { runCallerGuard } from './claim.js';
import type { RunCaller } from './lifecycle.js';

/** A run write's batch carried no live run for its caller. */
export const RUN_WRITE_EXPIRED = refusalCode('run_write_expired');

const held = new Map<string, Statement<BindValue[], unknown, 'assertion'>>();

/** Stops the batch with `RUN_WRITE_EXPIRED` unless the run is running and `caller` still holds it. */
export function liveRunWrite(projectId: string, runId: string, caller: RunCaller): Bound<unknown, 'assertion'> {
  const guard = runCallerGuard(caller, "status = 'running'");
  const when = `EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?${guard.sql})`;
  let statement = held.get(when);
  if (statement === undefined) {
    statement = assertion<BindValue[]>({ name: `runs.liveRunWriteK${textDigest(when)}`, refusal: RUN_WRITE_EXPIRED, when });
    held.set(when, statement);
  }
  return statement.bind(projectId, runId, ...guard.params);
}
