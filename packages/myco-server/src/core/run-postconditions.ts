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
 * Two kinds of evidence, and a task names one or both. **A report is the
 * model's claim about its own pass**: a report listing zero spores passes — the
 * counts inside it are the model's word, not something the server can hold it
 * to. **An artifact is the row the run owed**, and the server can see whether it
 * exists. A task whose product is a stored row names both, so a run whose write
 * met a refusal — an unheld surface, a lost connection — closes failed by name
 * rather than completed on the strength of a report it filed anyway.
 *
 * A dry run reaches no artifact check: it does the work and writes nothing by
 * the dispatcher's decision, and that decision is on its own row.
 *
 * Titling has no rule here. Its own routes admit the write and refuse it
 * outside the run's bound, so a titling run that wrote nothing already left
 * that record where a reader can see it.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { listReports, type RunRow } from './runs.js';
import { instructionsWrittenBy } from '../read/cortex.js';

/** What one task's run owes before it closes. */
export interface RunCloseRule {
  /** The report action the run must have recorded. */
  report: string;
  /** Whether the row this run owed exists. Absent for a task whose product is the report itself. */
  artifact?: (db: RelationalStore, scope: ReadScope, runId: string) => Promise<boolean>;
}

/** What each task's run must have left behind, by task. */
export const RUN_CLOSE_RULES: Readonly<Record<string, RunCloseRule>> = {
  'supersession-sweep': { report: 'supersession' },
  'cortex-instructions': { report: 'cortex_instructions', artifact: instructionsWrittenBy },
};

/** The report action a task's run must have recorded, by task. */
export const RUN_CLOSE_REPORTS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RUN_CLOSE_RULES).map(([task, rule]) => [task, rule.report]),
);

/** How a run that closed without the report its task owes is recorded. */
export const RUN_CLOSE_ERROR = 'the run ended without its report';
/** How a run that reported but left no row is recorded. */
export const RUN_CLOSE_ARTIFACT_ERROR = 'the run ended without its artifact';

/** Why this run may not close as completed, or null when it may. */
export async function runCloseRefusal(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<string | null> {
  const rule = run.task === null ? undefined : RUN_CLOSE_RULES[run.task];
  if (rule === undefined) return null;
  const reports = await listReports(db, scope, run.id);
  if (!reports.some((report) => report.action === rule.report)) return RUN_CLOSE_ERROR;
  if (rule.artifact === undefined || run.dryRun === 1) return null;
  return (await rule.artifact(db, scope, run.id)) ? null : RUN_CLOSE_ARTIFACT_ERROR;
}
