/**
 * What a run must have recorded before it may close as completed.
 *
 * The runtime says a run finished; the server decides whether it did. A
 * container reports its own status over the run routes, so a run that spent its
 * turns and wrote nothing would land `completed` on the runtime's word alone —
 * and a task whose whole product is a report would be indistinguishable from
 * one that did its work. The rule lives here, beside the store that holds the
 * evidence, rather than in the runtime that is the thing being checked.
 *
 * A report listing zero spores passes: the report is the contract, and the
 * counts inside it are the model's claim about its own pass, not evidence the
 * server can hold it to.
 *
 * Titling has no rule here. Its own routes admit the write and refuse it
 * outside the run's bound, so a titling run that wrote nothing already left
 * that record where a reader can see it.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { listReports, type RunRow } from './runs.js';

/** The report action a task's run must have recorded, by task. */
export const RUN_CLOSE_REPORTS: Readonly<Record<string, string>> = {
  'supersession-sweep': 'supersession',
};

/** How a run that closed without what its task owes is recorded. */
export const RUN_CLOSE_ERROR = 'the run ended without its report';

/** Why this run may not close as completed, or null when it may. */
export async function runCloseRefusal(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<string | null> {
  const action = run.task === null ? undefined : RUN_CLOSE_REPORTS[run.task];
  if (action === undefined) return null;
  const reports = await listReports(db, scope, run.id);
  return reports.some((report) => report.action === action) ? null : RUN_CLOSE_ERROR;
}
