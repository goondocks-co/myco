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
 * A task may name several reports, one of which says the run wrote nothing: an
 * extraction pass that finds no unread prompt reports a skip, and that is as
 * complete a pass as one that wrote ten spores. A run whose evidence is only
 * such a skip owes no row — but the skip is still the model's word, so a rule
 * names what the server reads to agree with it (`skipHolds`): no unread prompt
 * for extraction, a seeded Project for seeding, a standing title for titling. A
 * skip the server cannot agree with closes failed, naming the artifact.
 *
 * A dry run reaches no artifact check: it does the work and writes nothing by
 * the dispatcher's decision, and that decision is on its own row.
 *
 * **Every retained task declares a rule**, and
 * `tests/myco-server/task-catalogue.test.ts` holds this table equal to the task
 * catalogue's own. A task with no entry would close on the runtime's word while
 * reading as governed, so there is no entry that means "no rule".
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { listReports, runRecordedWrite, sessionNamedByRun, type RunRow, getRun, insertReport, type ReportInsert } from './runs.js';
import { MAP_ACTION, MAP_TASK, MAP_UNCHANGED_ACTION } from '@goondocks/myco-shared/canopy';
import { canopyMapWrittenBy } from './canopy.js';
import { sessionCarriesTitle } from '../read/sessions.js';
import { countSpores, sporeAuthoredBy } from './spores.js';
import { listUnprocessedPrompts } from '../read/prompts.js';
import { BLOCK_WRITE_TOOL, PROMPT_MARK_TOOL, TITLE_WRITE_TOOL } from './tool-catalogue.js';
import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from './task-catalogue.js';
import { SEEDED_SPORE_FLOOR } from './seeding-input.js';

/** The report a run records to say it found nothing to write. */
export const RUN_SKIP_ACTION = 'skip';

/** What one task's run owes before it closes. */
export interface RunCloseRule {
  /** The report actions the run must have recorded one of. */
  reports: readonly string[];
  /** Whether the row this run owed exists. Absent for a task whose product is the report itself. */
  artifact?: (db: RelationalStore, scope: ReadScope, run: RunRow) => Promise<boolean>;
  /** Whether the server's own read agrees with a skip. Absent where a skip is not accepted. */
  skipHolds?: (db: RelationalStore, scope: ReadScope, run: RunRow) => Promise<boolean>;
}

/** The report a titling run files, whatever it found to do. */
export const TITLING_REPORT_ACTION = 'summary';
/** The report an extraction run files after reading a page of prompts. */
export const EXTRACTION_REPORT_ACTION = 'extract';
/** The report a seeding run files after writing a Project's first spores. */
export const SEEDING_REPORT_ACTION = 'seed';

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
 * question the canopy map asks of its own artifact row — that one carries a run
 * column and the session row does not. The title is checked as well, so a write
 * recorded against a row that no longer holds one does not pass.
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

/**
 * Whether THIS run marked at least one prompt read.
 *
 * The mark is the extraction run's own landed write: it says the run read the
 * prompt and decided what it taught, and it is what moves the cursor so the next
 * pass reads on. A run that wrote spores and marked nothing has left the next
 * pass to read the same prompts again, and is held to the mark rather than to
 * the spores; a run that read a page and judged none of it worth a spore has
 * still done the pass, and the mark is the row that says so.
 */
export async function promptsMarkedBy(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  return runRecordedWrite(db, scope, run.id, PROMPT_MARK_TOOL);
}

/** Whether THIS run wrote a spore: the spore row's `author` column names the run. */
export async function sporesWrittenBy(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  return sporeAuthoredBy(db, scope, run.id);
}

/** Whether THIS run handed over the managed block: the `run_write` row the `agents_block` op lands. */
export async function blockWrittenBy(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  return runRecordedWrite(db, scope, run.id, BLOCK_WRITE_TOOL);
}

/** A seeding run owes both: a spore it authored and the block it handed over. */
export async function seedingWrittenBy(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  return (await sporesWrittenBy(db, scope, run)) && (await blockWrittenBy(db, scope, run));
}

/** An extraction skip holds when no settled prompt is left unread. */
export async function nothingUnread(db: RelationalStore, scope: ReadScope): Promise<boolean> {
  return (await listUnprocessedPrompts(db, scope, { limit: 1 })).rows.length === 0;
}

/** A seeding skip holds when the Project already holds enough active spores to count as seeded. */
export async function alreadySeeded(db: RelationalStore, scope: ReadScope): Promise<boolean> {
  return (await countSpores(db, scope, { status: 'active' })) >= SEEDED_SPORE_FLOOR;
}

/** A titling skip holds when the session its dispatch named carries a title. */
export async function titleStands(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  const sessionId = sessionNamedByRun(run);
  return sessionId !== null && (await sessionCarriesTitle(db, scope, sessionId));
}

/** What each task's run must have left behind, by task. Every retained task appears. */
export const RUN_CLOSE_RULES: Readonly<Record<string, RunCloseRule>> = {
  [MAP_TASK]: { reports: [MAP_ACTION, MAP_UNCHANGED_ACTION], artifact: canopyMapWrittenBy },
  'embedding-reconcile': { reports: ['embedding'] },
  // The whole product of a titling run is the title on the session its dispatch
  // named, which is why it names an artifact and not the report alone.
  // A write refused for a title already standing is a pass with nothing to do, and closes as one.
  [TITLING_TASK]: { reports: [TITLING_REPORT_ACTION, RUN_SKIP_ACTION], artifact: titleWrittenBy, skipHolds: titleStands },
  // An extraction pass owes the cursor move: a prompt it read, marked read under
  // its own credential. The skip is a pass that found no unread prompt.
  [EXTRACTION_TASK]: { reports: [EXTRACTION_REPORT_ACTION, RUN_SKIP_ACTION], artifact: promptsMarkedBy, skipHolds: (db, scope) => nothingUnread(db, scope) },
  // A seeding run owes the Project's first spores, authored by the run, and the
  // managed block it handed over. The skip is a pass that found the Project seeded.
  [SEEDING_TASK]: { reports: [SEEDING_REPORT_ACTION, RUN_SKIP_ACTION], artifact: seedingWrittenBy, skipHolds: (db, scope) => alreadySeeded(db, scope) },
  // The probe's product is the one report it files, which is what it proves.
  'container-smoke': { reports: ['container-smoke'] },
};

/** The rule this task's runs close under, or undefined for a name this Deployment does not serve. */
export function closeRuleFor(task: string | null): RunCloseRule | undefined {
  return task === null ? undefined : RUN_CLOSE_RULES[task];
}

/** How a run that closed without the report its task owes is recorded. */
export const RUN_CLOSE_ERROR = 'the run ended without its report';
/** How a run that reported but left no row is recorded. */
export const RUN_CLOSE_ARTIFACT_ERROR = 'the run ended without its artifact';

/**
 * The report actions a task's run may close with, or null for a task held to
 * no rule. The one vocabulary the report tool accepts and the judgment reads:
 * a rule that means to hear a pass with nothing to do lists the skip itself.
 */
export function acceptedActions(task: string | null): readonly string[] | null {
  return closeRuleFor(task)?.reports ?? null;
}

/** Why this run may not close as completed, or null when it may. */
export async function runCloseRefusal(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<string | null> {
  const rule = closeRuleFor(run.task);
  if (rule === undefined) return null;
  const evidence = (await listReports(db, scope, run.id)).filter((report) => rule.reports.includes(report.action));
  if (evidence.length === 0) return RUN_CLOSE_ERROR;
  if (rule.artifact === undefined || run.dryRun === 1) return null;
  if (evidence.every((report) => report.action === RUN_SKIP_ACTION)) {
    return rule.skipHolds === undefined || (await rule.skipHolds(db, scope, run)) ? null : RUN_CLOSE_ARTIFACT_ERROR;
  }
  return (await rule.artifact(db, scope, run)) ? null : RUN_CLOSE_ARTIFACT_ERROR;
}

/** How a report under an action a task's rule cannot hear is refused, on either door a run reports through. */
export function unacceptedActionError(task: string | null, accepted: readonly string[]): string {
  return `a ${task ?? 'run'} run closes with action ${accepted.map((a) => `"${a}"`).join(' or ')}`;
}

/** What recording a report answered: the row landed, the run is not one this Project holds, or the action is one its task cannot close under. */
export type ReportOutcome =
  | { recorded: true }
  | { recorded: false; reason: 'unheld' }
  | { recorded: false; reason: 'unaccepted'; error: string };

/**
 * Record a run's report: the one door every report lands through, on the MCP
 * surface and the container's route alike (`tests/meta/report-record-chokepoint.test.ts`).
 * An action the run's task cannot close under is refused here, naming what it
 * can, and leaves no row; a row the judgment would ignore is never written.
 */
export async function recordReport(db: RelationalStore, scope: ReadScope, report: ReportInsert): Promise<ReportOutcome> {
  const run = await getRun(db, scope, report.runId);
  if (run === null) return { recorded: false, reason: 'unheld' };
  const accepted = acceptedActions(run.task);
  if (accepted !== null && !accepted.includes(report.action)) return { recorded: false, reason: 'unaccepted', error: unacceptedActionError(run.task, accepted) };
  return (await insertReport(db, scope, report)) ? { recorded: true } : { recorded: false, reason: 'unheld' };
}
