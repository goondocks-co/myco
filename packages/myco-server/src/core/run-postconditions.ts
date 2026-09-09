/**
 * What a run must have recorded before it may close as completed.
 *
 * The runtime says a run finished; the server decides whether it did. Both front
 * doors a run ends through — a container reporting its own status over the run
 * routes, and a worker reporting an outcome for the run it leases — carry the
 * runtime's word about work the server can see for itself. A harness that ends
 * its turn without ever calling the Deployment has spent its budget and written
 * nothing, and on the runtime's word alone that run lands `completed`. The rule
 * lives here, beside the store that holds the evidence, rather than in the
 * runtime that is the thing being checked.
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
 * **Every retained task declares a rule or declares `RUN_CLOSE_NONE`**, and
 * `tests/myco-server/task-catalogue.test.ts` holds this table equal to the task
 * catalogue's own. A
 * task with no entry would close on the runtime's word while reading as
 * governed, so the absence has to be a decision someone wrote down rather than
 * a name nobody added. `RUN_CLOSE_NONE` says this task's product is not yet
 * something the server can see, and a run of it closes as its runtime reports.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { inputHashOf, listReports, runRecordedWrite, sessionNamedByRun, type RunRow } from './runs.js';
import { digestWrittenBy } from './digests.js';
import { MAP_ACTION, MAP_TASK, MAP_UNCHANGED_ACTION } from '@goondocks/myco-shared/canopy';
import { canopyMapWrittenBy } from './canopy.js';
import { sessionCarriesTitle } from '../read/sessions.js';
import { TITLE_WRITE_TOOL } from './tool-catalogue.js';
import { TITLING_TASK } from './task-catalogue.js';

/** The report a run records to say it found nothing to write. */
export const RUN_SKIP_ACTION = 'skip';
/** The report a digest run files after writing. */
export const DIGEST_REPORT_ACTION = 'digest';

/** A task whose product the server cannot yet see: its runs close as their runtime reports them. */
export const RUN_CLOSE_NONE = 'none';

/** What one task's run owes before it closes. */
export interface RunCloseRule {
  /** The report actions the run must have recorded one of. */
  reports: readonly string[];
  /** Whether the row this run owed exists. Absent for a task whose product is the report itself. */
  artifact?: (db: RelationalStore, scope: ReadScope, run: RunRow) => Promise<boolean>;
}

/** The report a titling run files, whatever it found to do. */
export const TITLING_REPORT_ACTION = 'summary';

/**
 * Whether THIS run wrote the title on the session its dispatch named.
 *
 * The session is read off the run's own recorded context, which the dispatcher
 * wrote and no runtime may move, so the row checked is the one the dispatch named
 * to write. A run whose context names no session owed a title it can never be
 * held to, and answers false rather than passing on the absence.
 *
 * **A title standing on the session is not this run's work.** An owner may
 * re-title any session, titled or not, and that write goes over whatever is
 * there; a session may also carry a title with no claim stamp at all. So a run
 * that filed its report and never called would pass on a title an earlier run
 * wrote. The run key is the write the run landed (`RUN_WRITE_EVENT`), the same
 * question `digest-only` and `canopy-map` ask of their own artifact rows — those
 * carry a run column and the session row does not. The title is checked as well,
 * so a write recorded against a row that no longer holds one does not pass.
 *
 * The record is a second statement after the title commits, and it throws where
 * the store refuses it, so a store fault between the two leaves the title
 * standing and the run failed for an artifact it did in fact write. A
 * `titled_by_run` column on the session would make the two one write and is the
 * long-run shape; the record is what holds the rule without a migration.
 */
export async function titleWrittenBy(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  const sessionId = sessionNamedByRun(run);
  if (sessionId === null) return false;
  return (await runRecordedWrite(db, scope, run.id, TITLE_WRITE_TOOL)) && (await sessionCarriesTitle(db, scope, sessionId));
}

/** What each task's run must have left behind, by task. Every retained task appears. */
export const RUN_CLOSE_RULES: Readonly<Record<string, RunCloseRule | typeof RUN_CLOSE_NONE>> = {
  [MAP_TASK]: { reports: [MAP_ACTION, MAP_UNCHANGED_ACTION], artifact: canopyMapWrittenBy },
  'embedding-reconcile': { reports: ['embedding'] },
  'supersession-sweep': { reports: ['supersession'] },
  'digest-only': {
    reports: [DIGEST_REPORT_ACTION, RUN_SKIP_ACTION],
    artifact: (db, scope, run) => digestWrittenBy(db, scope, { runId: run.id, substrateHash: inputHashOf(run), since: run.startedAt }),
  },
  // The whole product of a titling run is the title on the session its dispatch
  // named, which is why it names an artifact and not the report alone.
  // A write refused for a title already standing is a pass with nothing to do, and closes as one.
  [TITLING_TASK]: { reports: [TITLING_REPORT_ACTION, RUN_SKIP_ACTION], artifact: titleWrittenBy },

  // The probe's product is the one report it files, which is what it proves.
  'container-smoke': { reports: ['container-smoke'] },

  // Spores, skills and instructions a run writes carry the run as their author,
  // but nothing yet reads that back as the row a NAMED run owed.
  'cortex-prompt-builder': RUN_CLOSE_NONE,
  'skill-survey': RUN_CLOSE_NONE,
  'skill-generate': RUN_CLOSE_NONE,
  'skill-evolve': RUN_CLOSE_NONE,
  'vault-evolve': RUN_CLOSE_NONE,
  'vault-seed': RUN_CLOSE_NONE,
  'extract-only': RUN_CLOSE_NONE,
  'review-session': RUN_CLOSE_NONE,
};

/** The rule this task's runs close under, or undefined for a name this Deployment does not serve. */
export function closeRuleFor(task: string | null): RunCloseRule | undefined {
  if (task === null) return undefined;
  const rule = RUN_CLOSE_RULES[task];
  return rule === undefined || rule === RUN_CLOSE_NONE ? undefined : rule;
}

/** The report actions a task's run must have recorded one of, by task. */
export const RUN_CLOSE_REPORTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(RUN_CLOSE_RULES).flatMap(([task, rule]) => (rule === RUN_CLOSE_NONE ? [] : [[task, rule.reports]])),
);

/** How a run that closed without the report its task owes is recorded. */
export const RUN_CLOSE_ERROR = 'the run ended without its report';
/** How a run that reported but left no row is recorded. */
export const RUN_CLOSE_ARTIFACT_ERROR = 'the run ended without its artifact';

/** Why this run may not close as completed, or null when it may. */
export async function runCloseRefusal(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<string | null> {
  const rule = closeRuleFor(run.task);
  if (rule === undefined) return null;
  const reports = await listReports(db, scope, run.id);
  const evidence = reports.filter((report) => rule.reports.includes(report.action));
  if (evidence.length === 0) return RUN_CLOSE_ERROR;
  if (rule.artifact === undefined || run.dryRun === 1) return null;
  if (evidence.every((report) => report.action === RUN_SKIP_ACTION)) return null;
  return (await rule.artifact(db, scope, run)) ? null : RUN_CLOSE_ARTIFACT_ERROR;
}
