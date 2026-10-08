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
import { agentProse, strictName } from '@goondocks/myco-shared/run-text';
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { listReports, runRecordedWrite, sessionNamedByRun, type RunRow, getRun, insertReport, type ReportInsert, type RunCaller } from './runs.js';
import { MAP_ACTION, MAP_TASK, MAP_UNCHANGED_ACTION } from '@goondocks/myco-shared/canopy';
import { canopyMapWrittenBy } from './canopy.js';
import { sessionCarriesTitle } from '../read/sessions.js';
import { countSpores, sporeAuthoredBy } from './spores.js';
import { listUnprocessedPrompts } from '../read/prompts.js';
import { PROMPT_MARK_TOOL, TITLE_WRITE_TOOL } from './tool-catalogue.js';
import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from './task-catalogue.js';
import { SEEDED_SPORE_FLOOR } from './seeding-params.js';
import { titlingParamsOf } from './titling-params.js';
import { parseRunAudit } from './run-audit.js';
import { runHasAttempt } from './run-steps.js';
import { RUN_CLOSE_AUDIT_ERROR } from './reader-codes.js';

export { RUN_CLOSE_AUDIT_ERROR } from './reader-codes.js';

/** The report a run records to say it found nothing to write. */
export const RUN_SKIP_ACTION = 'skip';

/** What one task's run owes before it closes. */
export interface RunCloseRule {
  /** The report actions the run must have recorded one of. */
  reports: readonly string[];
  /** The evidence this rule requires, in reader words. */
  description: readonly string[];
  /** Whether the row this run owed exists. Absent for a task whose product is the report itself. */
  artifact?: (db: RelationalStore, scope: ReadScope, run: RunRow) => Promise<boolean>;
  /** Whether the server's own read agrees with a skip. Absent where a skip is not accepted. */
  skipHolds?: (db: RelationalStore, scope: ReadScope, run: RunRow) => Promise<boolean>;
  /**
   * Set where an agent does the task: a report closes the run only with its audit (`core/run-audit.ts`). A run owes it
   * only where a worker's claim recorded its attempt (`owesAudit`), so a run claimed before attempts were recorded, or
   * run by a container, closes as it did.
   */
  audited?: true;
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

/** An extraction skip holds when no settled prompt is left unread. */
export async function nothingUnread(db: RelationalStore, scope: ReadScope): Promise<boolean> {
  return (await listUnprocessedPrompts(db, scope, { limit: 1 })).rows.length === 0;
}

/** A seeding skip holds when the Project already holds enough active spores to count as seeded. */
export async function alreadySeeded(db: RelationalStore, scope: ReadScope): Promise<boolean> {
  return (await countSpores(db, scope, { status: 'active' })) >= SEEDED_SPORE_FLOOR;
}

/** A titling skip holds when the session its dispatch named carries a title; a refresh exists to replace that title, so none holds for it. */
export async function titleStands(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  const sessionId = sessionNamedByRun(run);
  if (titlingParamsOf(run.runContext)?.mode === 'refresh') return false;
  return sessionId !== null && (await sessionCarriesTitle(db, scope, sessionId));
}

/** What each task's run must have left behind, by task. Every retained task appears. */
export const RUN_CLOSE_RULES: Readonly<Record<string, RunCloseRule>> = {
  [MAP_TASK]: { description: ['A report with its audit and a code map written by this run, or a report with its audit that the map is unchanged.'], reports: [MAP_ACTION, MAP_UNCHANGED_ACTION], artifact: canopyMapWrittenBy, audited: true },
  'embedding-reconcile': { description: ['A report of the search index update.'], reports: ['embedding'] },
  // The whole product of a titling run is the title on the session its dispatch
  // named, which is why it names an artifact and not the report alone.
  // A write refused for a title already standing is a pass with nothing to do, and closes as one.
  [TITLING_TASK]: { description: ['A report with its audit and a title written by this run for its session, or a supported skip when a title already stands.'], reports: [TITLING_REPORT_ACTION, RUN_SKIP_ACTION], artifact: titleWrittenBy, skipHolds: titleStands, audited: true },
  // An extraction pass owes the cursor move: a prompt it read, marked read under
  // its own credential. The skip is a pass that found no unread prompt.
  [EXTRACTION_TASK]: { description: ['A report with its audit and at least one prompt marked as read by this run, or a supported skip when no unread prompts remain.'], reports: [EXTRACTION_REPORT_ACTION, RUN_SKIP_ACTION], artifact: promptsMarkedBy, skipHolds: (db, scope) => nothingUnread(db, scope), audited: true },
  // Seeding owes spores authored by the run, or a skip supported by the Project's active spores.
  [SEEDING_TASK]: { description: ['A report with its audit and a spore written by this run, or a supported skip when the project already has enough active spores.'], reports: [SEEDING_REPORT_ACTION, RUN_SKIP_ACTION], artifact: sporesWrittenBy, skipHolds: (db, scope) => alreadySeeded(db, scope), audited: true },
  // The probe's product is the one report it files, which is what it proves.
  'container-smoke': { description: ['A report of the health check.'], reports: ['container-smoke'] },
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

export interface RunCloseEvidence {
  hasReport: boolean;
  /** Whether a closing report carries its audit; null for a task whose reports owe none. */
  hasAudit: boolean | null;
  artifactPresent: boolean | null;
  skipSupported: boolean | null;
  targetSessionId: string | null;
}

/** Whether this run's closing report owes its audit: its task's rule is audited and a worker's claim recorded its attempt. */
export async function owesAudit(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  return closeRuleFor(run.task)?.audited === true && await runHasAttempt(db, scope, run.id);
}

/** Current persisted evidence under the task's close rule; null for an ungoverned task. */
export async function readRunCloseEvidence(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<RunCloseEvidence | null> {
  const rule = closeRuleFor(run.task);
  if (rule === undefined) return null;
  const evidence = (await listReports(db, scope, run.id)).filter((report) => rule.reports.includes(report.action));
  const result: RunCloseEvidence = {
    hasReport: evidence.length > 0, hasAudit: await owesAudit(db, scope, run) ? evidence.some((report) => report.audit !== null) : null,
    artifactPresent: null, skipSupported: null, targetSessionId: sessionNamedByRun(run),
  };
  if (!result.hasReport || rule.artifact === undefined || run.dryRun === 1) return result;
  if (evidence.every((report) => report.action === RUN_SKIP_ACTION)) {
    result.skipSupported = rule.skipHolds === undefined || await rule.skipHolds(db, scope, run);
  } else {
    result.artifactPresent = await rule.artifact(db, scope, run);
  }
  return result;
}

/**
 * Why this run may not close as completed, or null when it may: no closing report, then no artifact or an unsupported
 * skip, then no audit on any closing report. Whatever the run wrote stays written; only the outcome is decided here.
 */
export async function runCloseRefusal(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<string | null> {
  const evidence = await readRunCloseEvidence(db, scope, run);
  if (evidence === null) return null;
  if (!evidence.hasReport) return RUN_CLOSE_ERROR;
  if (evidence.artifactPresent === false || evidence.skipSupported === false) return RUN_CLOSE_ARTIFACT_ERROR;
  return evidence.hasAudit === false ? RUN_CLOSE_AUDIT_ERROR : null;
}

/** How a report under an action a task's rule cannot hear is refused, on either door a run reports through. */
export function unacceptedActionError(task: string | null, accepted: readonly string[]): string {
  return `a ${task ?? 'run'} run closes with action ${accepted.map((a) => `"${a}"`).join(' or ')}`;
}

/**
 * What recording a report answered: the row landed, the run is not one this Project holds, or the action is one its
 * task cannot close under. A landed row whose audit is absent or malformed says why in `auditError`, where the run's
 * task owes one or an audit is offered: the report stands without it, and cannot close the run as completed.
 */
export type ReportOutcome =
  | { recorded: true; auditError: string | null; auditRepairs: string[] }
  | { recorded: false; reason: 'unheld' }
  | { recorded: false; reason: 'unaccepted'; error: string };

/** A report as either door offers it: the audit is the caller's raw argument, judged here. */
export type ReportOffer = Omit<ReportInsert, 'audit'> & { audit: unknown };

/** The most characters a report's summary and its details are stored with, on either door a run reports through. */
export const MAX_REPORT_SUMMARY_CHARS = 4_096;
export const MAX_REPORT_DETAILS_CHARS = 65_536;

/**
 * Record a run's report: the one door every report lands through, on the MCP
 * surface and the container's route alike (`tests/meta/report-record-chokepoint.test.ts`).
 * An action the run's task cannot close under is refused here, naming what it
 * can, and leaves no row; a row the judgment would ignore is never written. The
 * audit is held to its shape here (`parseRunAudit`), and the summary and details
 * are stored as agent prose (`agentProse`), so both doors store the same thing
 * for the same offer.
 */
export async function recordReport(db: RelationalStore, scope: ReadScope, report: ReportOffer, caller?: RunCaller): Promise<ReportOutcome> {
  const run = await getRun(db, scope, report.runId);
  if (run === null) return { recorded: false, reason: 'unheld' };
  // A report names its agent by an identifier, and its action from the task's own list; a task held to no rule takes none.
  if (strictName(report.agentId) === null) return { recorded: false, reason: 'unaccepted', error: 'a report names its agent by an identifier' };
  const accepted = acceptedActions(run.task);
  if (accepted === null) return { recorded: false, reason: 'unaccepted', error: `a ${run.task ?? 'run'} run closes under no rule, so it takes no report` };
  if (!accepted.includes(report.action)) return { recorded: false, reason: 'unaccepted', error: unacceptedActionError(run.task, accepted) };
  const offered = report.audit === undefined || report.audit === null ? null : parseRunAudit(report.audit);
  const audit = offered?.ok === true ? JSON.stringify(offered.audit) : null;
  const auditError = offered === null
    ? (await owesAudit(db, scope, run) ? 'the report carries no audit' : null)
    : (offered.ok ? null : offered.error);
  const auditRepairs = offered?.ok === true ? offered.repairs : [];
  // The agent's own words, bounded and masked (`agentProse`): stored with the run and kept as long as it is.
  const summary = agentProse(report.summary, MAX_REPORT_SUMMARY_CHARS) ?? '…';
  const details = report.details === null ? null : agentProse(report.details, MAX_REPORT_DETAILS_CHARS);
  return (await insertReport(db, scope, { ...report, summary, details, audit }, caller)) ? { recorded: true, auditError, auditRepairs } : { recorded: false, reason: 'unheld' };
}
