import { visibleRunHolder } from '@goondocks/myco-shared/run-holds';
import { parseRepositoryFailure, parseHarnessStop, LATE_HARNESS_ERROR_NOTE, type HarnessStop } from '@goondocks/myco-shared/run-text';
import { type RepositoryFailure } from '@goondocks/myco-shared/repository';
import { heldPartition } from '../core/embedding/policy.js';
import { runAccounting } from './accounting.js';
import type { RecordedIdentity, CostProvenance } from '@goondocks/myco-shared/worker-usage';
import type { RelationalStore } from '../core/adapters.js';
import { clampLimit, decodeCursor, keysetPage, MAX_PAGE, page, type Page, type ReadScope } from './scope.js';
import { runDetailRow, runIsVisible, runListRows, type RunListOrder } from '../db/runs/history.js';
import { readSet } from '../db/index.js';
import { attemptStepRows, canopyMapRecord, latestRunAttempts, runAttemptRecord, runCallEvents, type AttemptRecord } from '../db/runs/detail-pages.js';
import { queuedWaits, type QueuedWait } from '../db/runs/queue.js';
import { getRun, isTerminalRunStatus } from '../db/runs/lifecycle.js';
import { RUN_CALL_FAILED, RUN_TOOL_EVENT, RUN_WRITE_EVENT, type RunCallFailure, type RunCallResult } from '../db/runs/evidence.js';
import { ownMachineNames } from './capture.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { runOutcomeCounts, type RunOutcomeCounts } from '../db/runs/reads.js';
import { attemptsReceived, runEvidenceHead } from '../db/runs/evidence.js';
import { readRunCloseEvidence, type RunCloseEvidence } from '../core/run-postconditions.js';
import { runErrorCode, skipReasonCode } from '../core/reader-codes.js';
import { requestedProfile, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { type RunResult } from '../db/runs/run-output.js';
import { MAP_WRITE_TOOL } from '../core/tool-catalogue.js';
import { redactSecrets } from '@goondocks/myco-shared/redact-secrets';
import type { StepKind, StepOutcome, UnrecognizedCount } from '@goondocks/myco-shared/worker-steps';

/** The most calls one page of a run's detail lists. */
const MAX_TOOL_CALLS = 200;

/** A run as the list shows it: what ran, how it ended, and what it cost. The error text stays in the detail; the list carries only that there is one. */
interface RunListRow {
  result: RunResult | null;
  requested: ExecutionProfile | null;
  identity: RecordedIdentity;
  costProvenance: CostProvenance | null;
  id: string;
  agentId: string;
  task: string | null;
  /** The piece of work a run's claim named, as a curation run names its cluster; null for a task that names none. */
  subject: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  startedAt: number | null;
  resumedAt: number | null;
  completedAt: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  costSource: string | null;
  dryRun: boolean;
  resumable: boolean;
  resumeStatus: string | null;
  failed: boolean;
  /** When a queued run entered the queue; null for a run that launched at once. */
  queuedAt: number | null;
  /** What holds a queued run, by name — a limit, the fleet, or the runtime itself; null once it launches. */
  heldBy: string | null;
  /** Why a queued run waits, its holder's code, and the instant it began waiting; null for any other run. */
  waitReason: string | null;
  waitingSince: number | null;
  /** How many runs of this task wait in this Project, this one included; null for any other run, and while the queue is measured. */
  taskQueued: number | null;
  /** Whether a deployment ended this run rather than its own work. */
  replaced: boolean;
  /** The run this one stands in for: the deployment that ended that run put this one in its place. */
  replaces: string | null;
  /** The harness the claim chose; null when the row records none. */
  harness: string | null;
  /** The worker credential holding the run now — a legacy worker's member credential or a runner's — null once the run ends or returns to the queue, and for a run no worker took. */
  leasedBy: string | null;
  /**
   * The worker that ran the run: the credential that held it last, the
   * machine that credential names, and the member the credential belongs to. It
   * stays once the run ends, so which machine ran a run is read off the run;
   * null for a run no worker holds or held. The member is served to every
   * viewer: a run is attributed to the person whose machine ran it. The
   * machine's name is served to that member alone. A run Myco's own runtime ran
   * (`HARNESS_MEMBER_ID`, the member `/api/members` marks `system`) names Myco.
   * A runner's run names the runner, by the name every member may read, and no member.
   */
  worker: { credentialId: string; machineId: string | null; machineName: string | null; member: { id: string; label: string | null } | null; runner: { id: string; name: string | null } | null } | null;
  /** When the held lease ends; null whenever the row names no holder. */
  leaseExpiresAt: number | null;
  /** Who started the run: the member who asked for it by hand, or the process that started it on its own (`clock`, `backfill`); null where the run names no one. */
  startedBy: string | null;
  /** The session the run's dispatch named, as a titling run names the session it titles; null for a run dispatched on no one session. */
  targetSessionId: string | null;
  /** Why a skipped run did not run, as the run records it; null for any run but a skipped one. */
  skipReasonCode: string | null;
  skipReason: string | null;
}

/** A run as a page of the list shows it: the row, and what it came to. */
export interface RunPageRow extends RunListRow {
  outcome: RunOutcomeCounts;
}

/**
 * A run in full, minus the columns nothing outside the harness reads.
 *
 * The requested profile is selected from execution overrides; private context and cost detail
 * stay in storage, and `checkpoints` leaves this module only as the parsed
 * phase list: the stored checkpoint state carries the resolved provider
 * configuration, which may hold a provider key.
 */
interface RunDetailRow extends RunListRow {
  instruction: string | null;
  /** Standing rules are not part of the stored launch record. */
  instructions: string | null;
  sessionRef: string | null;
  actualCostUsd: number | null;
  estimatedCostUsd: number | null;
  reasoningLevel: string | null;
  resumeMode: string | null;
  resumeAttempts: number;
  errorCode: string | null;
  /** When the machine holding it last renewed its lease: its last sign of life outside its calls and steps; null when never renewed. */
  lastRenewedAt: number | null;
  /** Why a failed run failed, in the reader's words, where the worker that ran it gave a reason; null where it gave none. */
  errorReason: string | null;
  repositoryFailure?: RepositoryFailure | null;
  harnessStop?: HarnessStop | null;
  endedNote?: string | null;
  error: string | null;
  dispatchedBy: string | null;
  usageData: string | null;
  actionsTaken: string | null;
}

/** One phase of a run, as the harness checkpointed it. */
interface PhaseRow {
  name: string;
  status: string;
  updatedAt: number | null;
  summary: string | null;
  turnsUsed: number | null;
  allowedMaxTurns: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  costSource: string | null;
  capHit: boolean;
  semanticCheckBlocked: boolean;
  postConditionFailed: boolean;
}

/** One call a run made back to the Deployment, in the order the calls landed. */
interface RunToolCallRow {
  id: number;
  status: 'success' | 'failed' | 'unknown';
  tool: string;
  op: string | null;
  durationMs: number | null;
  recordedAt: number;
  /** Present on a call the Deployment answered with a failure: its code, and what it said. */
  failure?: RunCallFailure;
  /** Present on a route call whose answer the Deployment kept: its scalar fields, bounded. */
  result?: RunCallResult;
}

/** One claim of a run, and what its worker's step log holds. */
/** Who took an attempt: a runner by its id and name, or a legacy worker by the member its credential belongs to. */
type RunAttemptExecutor = { kind: 'runner'; runnerId: string; name: string | null } | { kind: 'legacy-worker'; memberId: string | null };

export interface RunAttemptRow {
  attemptId: string;
  claimedAt: number;
  /** The executor that took this attempt, kept once the run moves to another; a runner is never read through a member credential. */
  executor: RunAttemptExecutor;
  /**
   * The attempt's step log: the steps its worker observed (`total`), those the Deployment holds (`received`), those
   * past the log's bound (`overflow`) and the stream records the worker could not read. Null where no page of the log
   * has arrived: a worker that keeps none, or one that has not delivered it yet.
   */
  steps: { total: number; received: number; overflow: number; unrecognized: UnrecognizedCount | null } | null;
  /** The hold its run waited under in the queue before this attempt took it; null when it waited under none or was never queued. */
  waitedFor: string | null;
}

/** One step a worker observed, metadata only: never file contents or command output. */
export interface RunStepRow {
  seq: number;
  callId: string | null;
  kind: StepKind;
  tool: string;
  target: string | null;
  outcome: StepOutcome;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

/** One page of an attempt's step log, in step order. */
export interface RunStepPage {
  attemptId: string;
  rows: RunStepRow[];
  cursor: string | null;
}

export interface RunDetail {
  run: RunDetailRow;
  /** The phases the checkpoint records; empty when it records none, null when it cannot be read. */
  phases: PhaseRow[] | null;
  /** One page of admitted calls, oldest first. */
  toolCalls: RunToolCallRow[];
  toolCallCoverage: { total: number | null; failed: number | null; cursor: string | null };
  source: { branch: string; commit: string } | null;
  map: { revision: string; branch: string; commit: string; generatedAt: number; sourceRunId: string; replaced: boolean } | null;
  /** Current artifact and no-op checks, evaluated under the same rule used at completion. */
  outcomeEvidence: RunCloseEvidence | null;
  /** The run's latest claims, oldest first, each with what its step log holds; `attemptCount` counts them all. */
  attempts: RunAttemptRow[];
  /** Every attempt the run holds; null while the counts are still being built. */
  attemptCount: number | null;
  /** The first page of the latest attempt's step log; null for a run no worker claimed. */
  steps: RunStepPage | null;
}

interface RunFilters {
  includeSignIn?: boolean;
  status?: string;
  task?: string;
  agentId?: string;
  limit?: number;
  cursor?: string;
  since?: number;
  until?: number;
  /** A windowed read only: oldest first finds the runs nearest after `since`. */
  order?: RunListOrder;
  /** Only runs of this subject, null for runs that name none; filtered before the page's limit. */
  subject?: string | null;
}

const text = (value: unknown): string | null => (value as string | null) ?? null;
const num = (value: unknown): number | null => (value as number | null) ?? null;
const flag = (value: unknown): boolean => Number(value) === 1;

/** The worker that held a run: its member to anyone, and its machine named from `ownNames`, the viewer's own machines alone. */
function workerOf(row: Record<string, unknown>, ownNames: ReadonlyMap<string, string>): NonNullable<RunListRow['worker']> {
  const runnerId = text(row.leased_runner_id);
  if (runnerId !== null) {
    const name = text(row.leased_runner_name);
    return { credentialId: row.leased_runner_credential_id as string, machineId: null, machineName: name, member: null, runner: { id: runnerId, name } };
  }
  const machineId = text(row.leased_machine);
  const memberId = text(row.leased_member);
  return {
    credentialId: row.leased_by as string,
    machineId,
    machineName: machineId === null ? null : ownNames.get(machineId) ?? null,
    member: memberId === null ? null : { id: memberId, label: memberId === HARNESS_MEMBER_ID ? 'Myco' : text(row.leased_member_label) },
    runner: null,
  };
}

/** A queued run's wait, read beside its row and merged in; every other run has none. */
const waitFields = (wait: QueuedWait | undefined) => ({ wait_reason: wait?.reason ?? null, waiting_since: wait?.since ?? null, task_queued: wait?.taskQueued ?? null });

function toListRow(row: Record<string, unknown>, ownNames: ReadonlyMap<string, string>, includeSignIn = false): RunListRow {
  // Terminal runs have no current worker lease.
  const ended = isTerminalRunStatus(row.status);
  return {
    result: text(row.result) as RunResult | null,
    requested: requestedProfile(row.requested_profile),
    id: row.id as string,
    agentId: row.agent_id as string,
    task: text(row.task),
    subject: text(row.subject),
    status: row.status as string,
    ...runAccounting(row.usage_data, row.cost_provenance),
    provider: text(row.provider),
    model: row.model == null ? null : heldPartition(String(row.model)).label,
    startedAt: num(row.started_at),
    resumedAt: num(row.resumed_at),
    completedAt: num(row.completed_at),
    tokensUsed: num(row.tokens_used),
    costUsd: num(row.cost_usd),
    costSource: text(row.cost_source),
    dryRun: flag(row.dry_run),
    resumable: flag(row.resumable),
    resumeStatus: text(row.resume_status),
    failed: flag(row.failed),
    queuedAt: num(row.queued_at),
    heldBy: visibleRunHolder(text(row.held_by), includeSignIn),
    waitReason: visibleRunHolder(text(row.wait_reason), includeSignIn),
    waitingSince: num(row.waiting_since),
    taskQueued: num(row.task_queued),
    replaced: flag(row.replaced),
    replaces: text(row.replaces),
    harness: text(row.harness),
    leasedBy: ended ? null : text(row.leased_by) ?? text(row.leased_runner_credential_id),
    worker: row.leased_by == null && row.leased_runner_id == null ? null : workerOf(row, ownNames),
    leaseExpiresAt: ended ? null : num(row.lease_expires_at),
    startedBy: text(row.started_by),
    targetSessionId: text(row.target_session_id),
    skipReasonCode: skipReasonCode(text(row.skip_reason)),
    skipReason: text(row.skip_reason),
  };
}

function toDetailRow(row: Record<string, unknown>, ownNames: ReadonlyMap<string, string>, includeSignIn: boolean): RunDetailRow {
  const repositoryFailure = parseRepositoryFailure({ code: row.repository_failure_code, summary: row.repository_failure_summary });
  const harnessStop = parseHarnessStop(typeof row.harness_stop === 'string' ? JSON.parse(row.harness_stop) : null);
  return {
    ...toListRow(row, ownNames, includeSignIn),
    ...(harnessStop === null ? {} : { harnessStop }),
    ...(row.ended_note === LATE_HARNESS_ERROR_NOTE ? { endedNote: LATE_HARNESS_ERROR_NOTE } : {}),
    instruction: typeof row.instruction === 'string' ? redactSecrets(row.instruction) : null,
    instructions: null,
    sessionRef: text(row.session_ref),
    actualCostUsd: num(row.actual_cost_usd),
    estimatedCostUsd: num(row.estimated_cost_usd),
    reasoningLevel: text(row.reasoning_level),
    resumeMode: text(row.resume_mode),
    resumeAttempts: (row.resume_attempts as number | null) ?? 0,
    errorCode: runErrorCode(text(row.error), text(row.error_code)),
    lastRenewedAt: num(row.last_renewed_at),
    errorReason: text(row.error_reason),
    ...(repositoryFailure === null ? {} : { repositoryFailure }),
    error: text(row.error),
    dispatchedBy: text(row.dispatched_by),
    usageData: text(row.usage_data),
    actionsTaken: text(row.actions_taken),
  };
}

const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const optionalNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The phase list inside a checkpoint blob.
 *
 * A missing blob records no phases and answers an empty list. A blob that does
 * not parse, or parses to something without a `phases` object, answers null: a
 * reader must be able to tell "nothing happened yet" from "the record cannot be
 * read".
 */
export function phasesOf(raw: string | null): PhaseRow[] | null {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const phases = (parsed as { phases?: unknown }).phases;
  if (typeof phases !== 'object' || phases === null || Array.isArray(phases)) return null;
  return Object.entries(phases as Record<string, unknown>).map(([key, value]) => {
    const p = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    return {
      name: optionalText(p.name) ?? key,
      status: optionalText(p.status) ?? 'pending',
      updatedAt: optionalNumber(p.updatedAt),
      summary: optionalText(p.summary),
      turnsUsed: optionalNumber(p.turnsUsed),
      allowedMaxTurns: optionalNumber(p.allowedMaxTurns),
      tokensUsed: optionalNumber(p.tokensUsed),
      costUsd: optionalNumber(p.costUsd),
      costSource: optionalText(p.costSource),
      capHit: p.capHit === true,
      semanticCheckBlocked: p.semanticCheckBlocked === true,
      postConditionFailed: p.postConditionFailed === true,
    };
  });
}

/**
 * A project's runs, newest first (or, windowed, oldest first), one page at a time; `status` and `task` narrow the set before the cursor applies.
 * Each row carries what it came to, read for the page in one more round trip, and its machine's name as of `nowMs`.
 */
export async function listRuns(db: RelationalStore, scope: ReadScope, nowMs: number, viewerId: string, opts: RunFilters = {}): Promise<Page<RunPageRow>> {
  const windowed = opts.since !== undefined || opts.until !== undefined;
  const limit = clampLimit(opts.limit);
  const cursor = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor);
  if (cursor === null) return { rows: [], cursor: null };
  const results = await runListRows(db, scope, { status: opts.status, task: opts.task, agentId: opts.agentId, since: opts.since, until: opts.until, subject: opts.subject, order: opts.order }, limit + 1,
    cursor === undefined ? undefined : { at: cursor.createdAt, id: cursor.id });
  const listed = page(results, limit, (r) => ({ createdAt: (windowed ? num(r.completed_at) : null) ?? num(r.queued_at) ?? num(r.started_at) ?? 0, id: r.id as string }));
  const ids = listed.rows.map((r) => r.id as string);
  const queued = listed.rows.filter((r) => r.status === 'queued').map((r) => r.id as string);
  const waits = queued.length === 0 ? new Map<string, QueuedWait>() : await queuedWaits(db, scope, queued);
  const outcome = runOutcomeCounts(scope, ids);
  const [counts, ownNames] = await Promise.all([readSet(db, ...outcome.statements), ownMachineNames(db, viewerId, nowMs)]);
  const outcomes = outcome.read(counts);
  return {
    cursor: listed.cursor,
    rows: listed.rows.map((r) => ({ ...toListRow({ ...r, ...waitFields(waits.get(r.id as string)) }, ownNames, opts.includeSignIn), outcome: outcomes.get(r.id as string)! })),
  };
}

/** A recorded call's payload as an object, or null where it holds none. */
function payloadOf(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The op a recorded tool call names, off the payload the record carries. */
function opOfPayload(raw: string | null): string | null {
  const op = payloadOf(raw)?.op;
  return typeof op === 'string' && op.length > 0 ? op : null;
}

/** The failure recorded against a call whose outcome is failed, or null for any other call. */
function failureOf(outcome: string | null, raw: string | null): RunCallFailure | null {
  if (outcome !== RUN_CALL_FAILED) return null;
  const failure = payloadOf(raw)?.failure as { code?: unknown; message?: unknown } | undefined;
  return {
    code: typeof failure?.code === 'string' ? failure.code : 'tool_call_failed',
    message: typeof failure?.message === 'string' ? failure.message : '',
  };
}

/** The result a route call's record kept, or null where it kept none. */
function resultOf(raw: string | null): RunCallResult | null {
  const result = payloadOf(raw)?.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const kept = Object.entries(result).filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  return kept.length === 0 ? null : Object.fromEntries(kept) as RunCallResult;
}

/** One recorded admitted call, including whether its outcome can be read. */
function toToolCall(row: Record<string, unknown>): RunToolCallRow {
  const outcome = text(row.outcome);
  const failure = failureOf(outcome, text(row.payload));
  const result = resultOf(text(row.payload));
  return {
    id: Number(row.id), tool: String(row.tool ?? ''), op: opOfPayload(text(row.payload)),
    status: outcome === RUN_CALL_FAILED ? 'failed' : outcome === 'success' ? 'success' : 'unknown',
    durationMs: num(row.durationMs), recordedAt: Number(row.recordedAt),
    ...(failure === null ? {} : { failure }),
    ...(result === null ? {} : { result }),
  };
}

/** Calls admitted by the Deployment, oldest first, with totals covering the whole run. */
async function runToolCallPage(db: RelationalStore, scope: ReadScope, runId: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ rows: RunToolCallRow[]; total: number | null; failed: number | null; cursor: string | null }> {
  const k = keysetPage({ ...opts, limit: opts.limit ?? MAX_TOOL_CALLS });
  if (k === null) throw new Error('Malformed call cursor.');
  const [calls, head] = await Promise.all([
    runCallEvents(db, { project: scope.projectId, run: runId, event: RUN_TOOL_EVENT, after: k.after, limit: k.limit + 1 }),
    runEvidenceHead(db, scope, runId),
  ]);
  const paged = page(calls, k.limit, (r) => ({ createdAt: Number(r.recordedAt), id: String(r.id) }));
  return { rows: paged.rows.map(toToolCall), cursor: paged.cursor, total: head?.calls ?? null, failed: head?.failed ?? null };
}

/** A scoped run's admitted calls, or null when the Project holds no such run. */
export async function getRunCalls(db: RelationalStore, scope: ReadScope, runId: string, opts: { limit?: number; cursor?: string } = {}): Promise<Awaited<ReturnType<typeof runToolCallPage>> | null> {
  return await runIsVisible(db, scope, runId) ? runToolCallPage(db, scope, runId, opts) : null;
}

/** One page of a run's calls for callers that only need the rows. */
export async function runToolCalls(db: RelationalStore, scope: ReadScope, runId: string, limit = MAX_TOOL_CALLS): Promise<RunToolCallRow[]> {
  return (await runToolCallPage(db, scope, runId, { limit })).rows;
}

/** The most attempts a run's detail lists: the latest. */
const MAX_ATTEMPTS = 50;

function unrecognizedOf(raw: string | null): UnrecognizedCount | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as UnrecognizedCount;
    return typeof parsed.total === 'number' && parsed.shapes !== null && typeof parsed.shapes === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** A step count while its history is still being counted is null, so the attempt answers no coverage rather than zero received. */
const attemptOf = (received: ReadonlyMap<string, number> | null, includeSignIn = false) => (row: AttemptRecord): RunAttemptRow => ({
  attemptId: row.attemptId, claimedAt: Number(row.claimedAt),
  executor: row.ownerKind === 'runner' && row.runnerId !== null ? { kind: 'runner', runnerId: row.runnerId, name: row.runnerName } : { kind: 'legacy-worker', memberId: row.memberId },
  steps: row.total === null || received === null ? null : { total: Number(row.total), received: received.get(row.attemptId) ?? 0, overflow: Number(row.overflow ?? 0), unrecognized: unrecognizedOf(row.unrecognized) },
  waitedFor: visibleRunHolder(row.waitedFor, includeSignIn),
});

/**
 * A run's latest `MAX_ATTEMPTS` attempts, oldest first, each with its step log's totals and how many of its steps the
 * Deployment holds, and how many attempts the run has in all.
 */
export async function runAttempts(db: RelationalStore, scope: ReadScope, runId: string, includeSignIn = false): Promise<{ rows: RunAttemptRow[]; total: number | null }> {
  const latest = await latestRunAttempts(db, scope.projectId, runId, MAX_ATTEMPTS);
  const [received, head] = await Promise.all([attemptsReceived(db, scope, runId, latest.map((row) => row.attemptId)), runEvidenceHead(db, scope, runId)]);
  return { rows: latest.map(attemptOf(received, includeSignIn)).reverse(), total: head === null ? null : head.attempts };
}

/** One attempt of a run by its id, or null where the run has no such attempt. */
async function runAttempt(db: RelationalStore, scope: ReadScope, runId: string, attemptId: string): Promise<RunAttemptRow | null> {
  const row = await runAttemptRecord(db, scope.projectId, runId, attemptId);
  return row === null ? null : attemptOf(await attemptsReceived(db, scope, runId, [attemptId]))(row);
}

/** One page of an attempt's step log, in step order. */
async function runStepPage(db: RelationalStore, scope: ReadScope, runId: string, attemptId: string, opts: { limit?: number; cursor?: string } = {}): Promise<RunStepPage> {
  const k = keysetPage({ ...opts, limit: opts.limit ?? MAX_PAGE });
  if (k === null) throw new Error('Malformed step cursor.');
  const results = await attemptStepRows(db, { project: scope.projectId, run: runId, attempt: attemptId, after: k.after, limit: k.limit + 1 });
  const paged = page(results, k.limit, (row) => ({ createdAt: Number(row.seq), id: String(row.seq) }));
  return { attemptId, rows: [...paged.rows], cursor: paged.cursor };
}

/** A scoped run's step log for one attempt, or the latest when none is named; null when the Project holds no such run or attempt. */
export async function getRunSteps(db: RelationalStore, scope: ReadScope, runId: string, attemptId: string | undefined, opts: { limit?: number; cursor?: string } = {}): Promise<RunStepPage | null> {
  if (!await runIsVisible(db, scope, runId)) return null;
  const chosen = attemptId === undefined ? (await runAttempts(db, scope, runId)).rows.at(-1) ?? null : await runAttempt(db, scope, runId, attemptId);
  return chosen === null ? null : runStepPage(db, scope, runId, chosen.attemptId, opts);
}

/** One run inside the scope with its phases and the calls it made, its machine named as of `nowMs`, or null — including when the run exists under another project. */
export async function getRunDetail(db: RelationalStore, scope: ReadScope, runId: string, nowMs: number, viewerId: string, calls: { limit?: number; cursor?: string; includeSignIn?: boolean } = {}): Promise<RunDetail | null> {
  const [row, ownNames] = await Promise.all([runDetailRow(db, scope, runId), ownMachineNames(db, viewerId, nowMs)]);
  if (row === null) return null;
  const waits = row.status === 'queued' ? await queuedWaits(db, scope, [runId]) : null;
  const run = await getRun(db, scope, runId);
  const [callPage, currentMap, attempts] = await Promise.all([
    runToolCallPage(db, scope, runId, calls),
    canopyMapRecord(db, scope.projectId, runId, { event: RUN_WRITE_EVENT, tool: MAP_WRITE_TOOL }),
    runAttempts(db, scope, runId, calls.includeSignIn === true),
  ]);
  const latest = attempts.rows.at(-1);
  return {
    run: toDetailRow({ ...row, ...waitFields(waits?.get(runId)) }, ownNames, calls.includeSignIn === true), phases: phasesOf(text(row.checkpoints)), toolCalls: callPage.rows,
    toolCallCoverage: { total: callPage.total, failed: callPage.failed, cursor: callPage.cursor },
    source: typeof row.source_branch === 'string' && typeof row.source_commit === 'string' ? { branch: row.source_branch, commit: row.source_commit } : null,
    map: currentMap === null ? null : {
      revision: currentMap.revision, branch: currentMap.branch, commit: currentMap.commitId,
      generatedAt: currentMap.generatedAt, sourceRunId: currentMap.sourceRunId,
      replaced: Number(currentMap.wroteMap) === 1 && currentMap.sourceRunId !== runId,
    },
    outcomeEvidence: run === null ? null : await readRunCloseEvidence(db, scope, run),
    attempts: attempts.rows,
    attemptCount: attempts.total,
    steps: latest === undefined ? null : await runStepPage(db, scope, runId, latest.attemptId),
  };
}
