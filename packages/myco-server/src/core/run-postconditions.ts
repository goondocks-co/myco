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
 * A task may name several reports, one of which says the run wrote nothing: a
 * digest run that finds every tier current reports a skip, and that is as
 * complete a pass as one that wrote three tiers. A run whose evidence is only
 * such a skip owes no row.
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
import { inputHashOf, listReports, type RunRow } from './runs.js';
import { digestWrittenBy } from './digests.js';
import { instructionsWrittenBy } from '../read/cortex.js';

/** The report a run records to say it found nothing to write. */
export const RUN_SKIP_ACTION = 'skip';

/** What one task's run owes before it closes. */
export interface RunCloseRule {
  /** The report actions the run must have recorded one of. */
  reports: readonly string[];
  /** Whether the row this run owed exists. Absent for a task whose product is the report itself. */
  artifact?: (db: RelationalStore, scope: ReadScope, run: RunRow) => Promise<boolean>;
}

/** What each task's run must have left behind, by task. */
export const RUN_CLOSE_RULES: Readonly<Record<string, RunCloseRule>> = {
  'supersession-sweep': { reports: ['supersession'] },
  'cortex-instructions': {
    reports: ['cortex_instructions'],
    artifact: (db, scope, run) => instructionsWrittenBy(db, scope, run.id),
  },
  'digest-only': {
    reports: ['digest', RUN_SKIP_ACTION],
    artifact: (db, scope, run) => digestWrittenBy(db, scope, { runId: run.id, substrateHash: inputHashOf(run), since: run.startedAt }),
  },
};

/** The report actions a task's run must have recorded one of, by task. */
export const RUN_CLOSE_REPORTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(RUN_CLOSE_RULES).map(([task, rule]) => [task, rule.reports]),
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
  const evidence = reports.filter((report) => rule.reports.includes(report.action));
  if (evidence.length === 0) return RUN_CLOSE_ERROR;
  if (rule.artifact === undefined || run.dryRun === 1) return null;
  if (evidence.every((report) => report.action === RUN_SKIP_ACTION)) return null;
  return (await rule.artifact(db, scope, run)) ? null : RUN_CLOSE_ARTIFACT_ERROR;
}
