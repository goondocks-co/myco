import { heldPartition } from '../core/embedding/policy.js';
import { costProvenanceValue } from '../db/run-accounting.js';
import { runAccounting } from './accounting.js';
import type { RecordedIdentity, CostProvenance } from '@goondocks/myco-shared/worker-usage';
import type { RelationalStore } from '../core/adapters.js';
import { keyset, MAX_PAGE, page, type Page, type ReadScope } from './scope.js';
import { DISPATCH_ACTOR_SQL, getRun, isTerminalRunStatus, RUN_CALL_FAILED, RUN_TOOL_EVENT, RUN_WRITE_EVENT, type RunCallFailure } from '../core/runs.js';
import { ownMachineNames } from './capture.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { runOutcomeCounts, type RunOutcomeCounts } from './run-reads.js';
import { readRunCloseEvidence, type RunCloseEvidence } from '../core/run-postconditions.js';
import { runErrorCode, skipReasonCode } from '../core/reader-codes.js';
import { contextValue, FAILURE_REASON_KEY } from '../db/run-context.js';
import { requestedProfile, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { requestedProfileValue } from '../db/run-profile.js';
import { runResultSql, type RunResult } from './run-outcome.js';
import { MAP_WRITE_TOOL } from '../core/tool-catalogue.js';
import { redactSecrets } from '@goondocks/myco-shared/redact-secrets';
import type { StepKind, StepOutcome, UnrecognizedCount } from '@goondocks/myco-shared/worker-steps';

/** The most calls one page of a run's detail lists. */
const MAX_TOOL_CALLS = 200;

/** A run as the list shows it: what ran, how it ended, and what it cost. The error text stays in the detail; the list carries only that there is one. */
export interface RunListRow {
  result: RunResult | null;
  requested: ExecutionProfile | null;
  identity: RecordedIdentity;
  costProvenance: CostProvenance | null;
  id: string;
  agentId: string;
  task: string | null;
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
  /** How many queued runs are ahead of a queued run; null for any other. */
  position: number | null;
  /** Whether a deployment ended this run rather than its own work. */
  replaced: boolean;
  /** The run this one stands in for: the deployment that ended that run put this one in its place. */
  replaces: string | null;
  /** The harness the claim chose; null when the row records none. */
  harness: string | null;
  /** The worker credential holding the run now; null once the run ends or returns to the queue, and for a run no worker took. */
  leasedBy: string | null;
  /**
   * The worker that ran the run: the credential that held it last, the
   * machine that credential names, and the member the credential belongs to. It
   * stays once the run ends, so which machine ran a run is read off the run;
   * null for a run no worker holds or held. The member is served to every
   * viewer: a run is attributed to the person whose machine ran it. The
   * machine's name is served to that member alone. A run Myco's own runtime ran
   * (`HARNESS_MEMBER_ID`, the member `/api/members` marks `system`) names Myco.
   */
  worker: { credentialId: string; machineId: string | null; machineName: string | null; member: { id: string; label: string | null } | null } | null;
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
export interface RunDetailRow extends RunListRow {
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
  /** Why a failed run failed, in the reader's words, where the worker that ran it gave a reason; null where it gave none. */
  errorReason: string | null;
  error: string | null;
  dispatchedBy: string | null;
  usageData: string | null;
  actionsTaken: string | null;
}

/** One phase of a run, as the harness checkpointed it. */
export interface PhaseRow {
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
export interface RunToolCallRow {
  id: number;
  status: 'success' | 'failed' | 'unknown';
  tool: string;
  op: string | null;
  durationMs: number | null;
  recordedAt: number;
  /** Present on a call the Deployment answered with a failure: its code, and what it said. */
  failure?: RunCallFailure;
}

/** One claim of a run, and what its worker's step log holds. */
export interface RunAttemptRow {
  attemptId: string;
  claimedAt: number;
  /**
   * The attempt's step log: the steps its worker observed (`total`), those the Deployment holds (`received`), those
   * past the log's bound (`overflow`) and the stream records the worker could not read. Null where no page of the log
   * has arrived: a worker that keeps none, or one that has not delivered it yet.
   */
  steps: { total: number; received: number; overflow: number; unrecognized: UnrecognizedCount | null } | null;
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
  toolCallCoverage: { total: number; failed: number; cursor: string | null };
  source: { branch: string; commit: string } | null;
  map: { revision: string; branch: string; commit: string; generatedAt: number; sourceRunId: string; replaced: boolean } | null;
  /** Current artifact and no-op checks, evaluated under the same rule used at completion. */
  outcomeEvidence: RunCloseEvidence | null;
  /** The run's latest claims, oldest first, each with what its step log holds; `attemptCount` counts them all. */
  attempts: RunAttemptRow[];
  attemptCount: number;
  /** The first page of the latest attempt's step log; null for a run no worker claimed. */
  steps: RunStepPage | null;
}

export interface RunFilters {
  status?: string;
  task?: string;
  agentId?: string;
  limit?: number;
  cursor?: string;
  since?: number;
  until?: number;
}

/** A queued run's place in the Deployment's queue: how many queued runs are ahead of it, oldest first. */
const POSITION_SQL = `(SELECT COUNT(*) FROM agent_runs q WHERE q.status = 'queued'
  AND (q.queued_at < agent_runs.queued_at OR (q.queued_at = agent_runs.queued_at AND q.id < agent_runs.id)))`;


const LIST_COLUMNS = `id, agent_id, task, status, provider, model, usage_data,
  ${runResultSql('agent_runs')} AS result,
  ${requestedProfileValue()} AS requested_profile,
  ${costProvenanceValue()} AS cost_provenance, started_at, resumed_at, completed_at,
  tokens_used, cost_usd, cost_source, dry_run, resumable, resume_status, (error IS NOT NULL) AS failed,
  queued_at, held_by, CASE WHEN status = 'queued' THEN ${POSITION_SQL} ELSE NULL END AS position,
  ${contextValue('replaced')} AS replaced, ${contextValue('replaces')} AS replaces,
  harness, leased_by, lease_expires_at,
  (SELECT c.machine_id FROM member_credentials c WHERE c.id = agent_runs.leased_by) AS leased_machine,
  (SELECT c.member_id FROM member_credentials c WHERE c.id = agent_runs.leased_by) AS leased_member,
  (SELECT m.label FROM member_credentials c CROSS JOIN members m ON m.id = c.member_id WHERE c.id = agent_runs.leased_by) AS leased_member_label,
  ${DISPATCH_ACTOR_SQL} AS started_by, ${contextValue('session_id')} AS target_session_id,
  CASE WHEN status = 'skipped' THEN ${contextValue('reason')} END AS skip_reason`;

const DETAIL_COLUMNS = `${LIST_COLUMNS},
  ${contextValue('repository.branch')} AS source_branch, ${contextValue('repository.commit')} AS source_commit,
  instruction, session_ref, actual_cost_usd, estimated_cost_usd, reasoning_level,
  resume_mode, resume_attempts, error, error_code, CASE WHEN status = 'failed' THEN ${contextValue(FAILURE_REASON_KEY)} END AS error_reason,
  dispatched_by, actions_taken, checkpoints`;

const text = (value: unknown): string | null => (value as string | null) ?? null;
const num = (value: unknown): number | null => (value as number | null) ?? null;
const flag = (value: unknown): boolean => Number(value) === 1;

/** The worker that held a run: its member to anyone, and its machine named from `ownNames`, the viewer's own machines alone. */
function workerOf(row: Record<string, unknown>, ownNames: ReadonlyMap<string, string>): NonNullable<RunListRow['worker']> {
  const machineId = text(row.leased_machine);
  const memberId = text(row.leased_member);
  return {
    credentialId: row.leased_by as string,
    machineId,
    machineName: machineId === null ? null : ownNames.get(machineId) ?? null,
    member: memberId === null ? null : { id: memberId, label: memberId === HARNESS_MEMBER_ID ? 'Myco' : text(row.leased_member_label) },
  };
}

function toListRow(row: Record<string, unknown>, ownNames: ReadonlyMap<string, string>): RunListRow {
  // Terminal runs have no current worker lease.
  const ended = isTerminalRunStatus(row.status);
  return {
    result: text(row.result) as RunResult | null,
    requested: requestedProfile(row.requested_profile),
    id: row.id as string,
    agentId: row.agent_id as string,
    task: text(row.task),
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
    heldBy: text(row.held_by),
    position: num(row.position),
    replaced: flag(row.replaced),
    replaces: text(row.replaces),
    harness: text(row.harness),
    leasedBy: ended ? null : text(row.leased_by),
    worker: row.leased_by == null ? null : workerOf(row, ownNames),
    leaseExpiresAt: ended ? null : num(row.lease_expires_at),
    startedBy: text(row.started_by),
    targetSessionId: text(row.target_session_id),
    skipReasonCode: skipReasonCode(text(row.skip_reason)),
    skipReason: text(row.skip_reason),
  };
}

function toDetailRow(row: Record<string, unknown>, ownNames: ReadonlyMap<string, string>): RunDetailRow {
  return {
    ...toListRow(row, ownNames),
    instruction: typeof row.instruction === 'string' ? redactSecrets(row.instruction) : null,
    instructions: null,
    sessionRef: text(row.session_ref),
    actualCostUsd: num(row.actual_cost_usd),
    estimatedCostUsd: num(row.estimated_cost_usd),
    reasoningLevel: text(row.reasoning_level),
    resumeMode: text(row.resume_mode),
    resumeAttempts: (row.resume_attempts as number | null) ?? 0,
    errorCode: runErrorCode(text(row.error), text(row.error_code)),
    errorReason: text(row.error_reason),
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
 * A project's runs, newest first, one page at a time; `status` and `task` narrow the set before the cursor applies.
 * Each row carries what it came to, read for the page in one more round trip, and its machine's name as of `nowMs`.
 */
export async function listRuns(db: RelationalStore, scope: ReadScope, nowMs: number, viewerId: string, opts: RunFilters = {}): Promise<Page<RunPageRow>> {
  const windowed = opts.since !== undefined || opts.until !== undefined;
  const order = windowed ? 'COALESCE(completed_at, queued_at, started_at)' : 'COALESCE(queued_at, started_at)';
  const k = keyset(opts, { order, id: 'id', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const conditions = ['project_id = ?'];
  const params: (string | number)[] = [scope.projectId];
  if (opts.status !== undefined) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.task !== undefined) { conditions.push('task = ?'); params.push(opts.task); }
  if (opts.agentId !== undefined) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
  if (opts.since !== undefined) { conditions.push('COALESCE(completed_at, queued_at, started_at) >= ?'); params.push(opts.since); }
  if (opts.until !== undefined) { conditions.push('COALESCE(completed_at, queued_at, started_at) < ?'); params.push(opts.until); }
  if (k.where !== '') conditions.push(k.where);
  const { results } = await db
    .prepare(`SELECT ${LIST_COLUMNS} FROM agent_runs WHERE ${conditions.join(' AND ')} ORDER BY ${order} DESC, id DESC LIMIT ?`)
    .bind(...params, ...k.params, k.limit + 1)
    .all<Record<string, unknown>>();
  const listed = page(results, k.limit, (r) => ({ createdAt: (windowed ? num(r.completed_at) : null) ?? num(r.queued_at) ?? num(r.started_at) ?? 0, id: r.id as string }));
  const outcome = runOutcomeCounts(db, scope, listed.rows.map((r) => r.id as string));
  const [counts, ownNames] = await Promise.all([db.batch(outcome.statements), ownMachineNames(db, viewerId, nowMs)]);
  const outcomes = outcome.read(counts);
  return {
    cursor: listed.cursor,
    rows: listed.rows.map((r) => ({ ...toListRow(r, ownNames), outcome: outcomes.get(r.id as string)! })),
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

/** One recorded admitted call, including whether its outcome can be read. */
function toToolCall(row: Record<string, unknown>): RunToolCallRow {
  const outcome = text(row.outcome);
  const failure = failureOf(outcome, text(row.payload));
  return {
    id: Number(row.id), tool: String(row.tool ?? ''), op: opOfPayload(text(row.payload)),
    status: outcome === RUN_CALL_FAILED ? 'failed' : outcome === 'success' ? 'success' : 'unknown',
    durationMs: num(row.durationMs), recordedAt: Number(row.recordedAt),
    ...(failure === null ? {} : { failure }),
  };
}

/** Calls admitted by the Deployment, oldest first, with totals covering the whole run. */
export async function runToolCallPage(db: RelationalStore, scope: ReadScope, runId: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ rows: RunToolCallRow[]; total: number; failed: number; cursor: string | null }> {
  const k = keyset({ ...opts, limit: opts.limit ?? MAX_TOOL_CALLS }, { order: 'recorded_at', id: 'id', direction: 'ASC' });
  if (k === null) throw new Error('Malformed call cursor.');
  const [calls, totals] = await db.batch([
    db.prepare(`SELECT id, tool_name AS tool, duration_ms AS durationMs, outcome, payload, recorded_at AS recordedAt
      FROM agent_run_events WHERE project_id = ? AND run_id = ? AND event_type = ? ${k.where === '' ? '' : `AND ${k.where}`}
      ORDER BY recorded_at ASC, id ASC LIMIT ?`).bind(scope.projectId, runId, RUN_TOOL_EVENT, ...k.params, k.limit + 1),
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(outcome = ?), 0) AS failed FROM agent_run_events
      WHERE project_id = ? AND run_id = ? AND event_type = ?`).bind(RUN_CALL_FAILED, scope.projectId, runId, RUN_TOOL_EVENT),
  ]);
  const paged = page(calls.results as Record<string, unknown>[], k.limit, (r) => ({ createdAt: Number(r.recordedAt), id: String(r.id) }));
  const counts = totals.results[0] as { total: number; failed: number };
  return { rows: paged.rows.map(toToolCall), cursor: paged.cursor, total: Number(counts.total), failed: Number(counts.failed) };
}

/** A scoped run's admitted calls, or null when the Project holds no such run. */
export async function getRunCalls(db: RelationalStore, scope: ReadScope, runId: string, opts: { limit?: number; cursor?: string } = {}): Promise<Awaited<ReturnType<typeof runToolCallPage>> | null> {
  const found = await db.prepare('SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?').bind(scope.projectId, runId).first();
  return found === null ? null : runToolCallPage(db, scope, runId, opts);
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

const ATTEMPT_COLUMNS = `a.attempt_id AS attemptId, a.claimed_at AS claimedAt, a.steps_total AS total, a.steps_overflow AS overflow, a.unrecognized,
  (SELECT COUNT(*) FROM agent_run_steps s WHERE s.project_id = a.project_id AND s.run_id = a.run_id AND s.attempt_id = a.attempt_id) AS received`;

type AttemptRecord = { attemptId: string; claimedAt: number; total: number | null; overflow: number | null; unrecognized: string | null; received: number };

const attemptOf = (row: AttemptRecord): RunAttemptRow => ({
  attemptId: row.attemptId, claimedAt: Number(row.claimedAt),
  steps: row.total === null ? null : { total: Number(row.total), received: Number(row.received), overflow: Number(row.overflow ?? 0), unrecognized: unrecognizedOf(row.unrecognized) },
});

/**
 * A run's latest `MAX_ATTEMPTS` attempts, oldest first, each with its step log's totals and how many of its steps the
 * Deployment holds, and how many attempts the run has in all.
 */
export async function runAttempts(db: RelationalStore, scope: ReadScope, runId: string): Promise<{ rows: RunAttemptRow[]; total: number }> {
  const [latest, counted] = await db.batch([
    db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM agent_run_attempts a WHERE a.project_id = ? AND a.run_id = ?
      ORDER BY a.claimed_at DESC, a.attempt_id DESC LIMIT ?`).bind(scope.projectId, runId, MAX_ATTEMPTS),
    db.prepare(`SELECT COUNT(*) AS total FROM agent_run_attempts WHERE project_id = ? AND run_id = ?`).bind(scope.projectId, runId),
  ]);
  return {
    rows: (latest!.results as AttemptRecord[]).map(attemptOf).reverse(),
    total: Number((counted!.results[0] as { total: number }).total),
  };
}

/** One attempt of a run by its id, or null where the run has no such attempt. */
async function runAttempt(db: RelationalStore, scope: ReadScope, runId: string, attemptId: string): Promise<RunAttemptRow | null> {
  const row = await db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM agent_run_attempts a WHERE a.project_id = ? AND a.run_id = ? AND a.attempt_id = ?`)
    .bind(scope.projectId, runId, attemptId).first<AttemptRecord>();
  return row === null ? null : attemptOf(row);
}

/** One page of an attempt's step log, in step order. */
export async function runStepPage(db: RelationalStore, scope: ReadScope, runId: string, attemptId: string, opts: { limit?: number; cursor?: string } = {}): Promise<RunStepPage> {
  const k = keyset({ ...opts, limit: opts.limit ?? MAX_PAGE }, { order: 'seq', id: 'seq', direction: 'ASC' });
  if (k === null) throw new Error('Malformed step cursor.');
  const { results } = await db.prepare(
    `SELECT seq, call_id AS callId, kind, tool, target, outcome, exit_code AS exitCode, started_at AS startedAt, ended_at AS endedAt
      FROM agent_run_steps WHERE project_id = ? AND run_id = ? AND attempt_id = ? ${k.where === '' ? '' : `AND ${k.where}`}
      ORDER BY seq ASC LIMIT ?`,
  ).bind(scope.projectId, runId, attemptId, ...k.params, k.limit + 1).all<RunStepRow>();
  const paged = page(results, k.limit, (row) => ({ createdAt: Number(row.seq), id: String(row.seq) }));
  return { attemptId, rows: [...paged.rows], cursor: paged.cursor };
}

/** A scoped run's step log for one attempt, or the latest when none is named; null when the Project holds no such run or attempt. */
export async function getRunSteps(db: RelationalStore, scope: ReadScope, runId: string, attemptId: string | undefined, opts: { limit?: number; cursor?: string } = {}): Promise<RunStepPage | null> {
  const chosen = attemptId === undefined ? (await runAttempts(db, scope, runId)).rows.at(-1) ?? null : await runAttempt(db, scope, runId, attemptId);
  return chosen === null ? null : runStepPage(db, scope, runId, chosen.attemptId, opts);
}

/** One run inside the scope with its phases and the calls it made, its machine named as of `nowMs`, or null — including when the run exists under another project. */
export async function getRunDetail(db: RelationalStore, scope: ReadScope, runId: string, nowMs: number, viewerId: string, calls: { limit?: number; cursor?: string } = {}): Promise<RunDetail | null> {
  const [[found], ownNames] = await Promise.all([db.batch([
    db.prepare(`SELECT ${DETAIL_COLUMNS} FROM agent_runs WHERE project_id = ? AND id = ?`).bind(scope.projectId, runId),
  ]), ownMachineNames(db, viewerId, nowMs)]);
  const row = (found!.results[0] ?? null) as Record<string, unknown> | null;
  if (row === null) return null;
  const run = await getRun(db, scope, runId);
  const [callPage, currentMap, attempts] = await Promise.all([
    runToolCallPage(db, scope, runId, calls),
    db.prepare(`SELECT revision, repository_branch AS branch, repository_commit AS commitId, generated_at AS generatedAt,
      source_run_id AS sourceRunId,
      EXISTS (SELECT 1 FROM agent_run_events e WHERE e.project_id = ? AND e.run_id = ? AND e.event_type = ? AND e.tool_name = ?) AS wroteMap
      FROM canopy_maps WHERE project_id = ?`).bind(scope.projectId, runId, RUN_WRITE_EVENT, MAP_WRITE_TOOL, scope.projectId)
      .first<{ revision: string; branch: string; commitId: string; generatedAt: number; sourceRunId: string; wroteMap: number }>(),
    runAttempts(db, scope, runId),
  ]);
  const latest = attempts.rows.at(-1);
  return {
    run: toDetailRow(row, ownNames), phases: phasesOf(text(row.checkpoints)), toolCalls: callPage.rows,
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
