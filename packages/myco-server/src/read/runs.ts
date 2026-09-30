import type { RelationalStore } from '../core/adapters.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';
import { DISPATCH_ACTOR_SQL, getRun, isTerminalRunStatus, RUN_CALL_FAILED, RUN_TOOL_EVENT, type RunCallFailure } from '../core/runs.js';
import { ownMachineNames } from './capture.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { runOutcomeCounts, type RunOutcomeCounts } from './run-reads.js';
import { readRunCloseEvidence, type RunCloseEvidence } from '../core/run-postconditions.js';
import { contextValue } from '../db/run-context.js';

/** The most calls one run's detail lists; a run that called more is read in the record rather than the page. */
const MAX_TOOL_CALLS = 200;

/** A run as the list shows it: what ran, how it ended, and what it cost. The error text stays in the detail; the list carries only that there is one. */
export interface RunListRow {
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
  skipReason: string | null;
}

/** A run as a page of the list shows it: the row, and what it came to. */
export interface RunPageRow extends RunListRow {
  outcome: RunOutcomeCounts;
}

/**
 * A run in full, minus the columns nothing outside the harness reads.
 *
 * The three columns holding execution overrides, run context and cost detail
 * are never selected, and `checkpoints` leaves this module only as the parsed
 * phase list: the stored checkpoint state carries the resolved provider
 * configuration, which may hold a provider key.
 */
export interface RunDetailRow extends RunListRow {
  instruction: string | null;
  sessionRef: string | null;
  actualCostUsd: number | null;
  estimatedCostUsd: number | null;
  reasoningLevel: string | null;
  resumeMode: string | null;
  resumeAttempts: number;
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
  tool: string;
  op: string | null;
  durationMs: number | null;
  recordedAt: number;
  /** Present on a call the Deployment answered with a failure: its code, and what it said. */
  failure?: RunCallFailure;
}

export interface RunDetail {
  run: RunDetailRow;
  /** The phases the checkpoint records; empty when it records none, null when it cannot be read. */
  phases: PhaseRow[] | null;
  /** Every call this run made back to the Deployment; empty for a run that made none. */
  toolCalls: RunToolCallRow[];
  /** Current artifact and no-op checks, evaluated under the same rule used at completion. */
  outcomeEvidence: RunCloseEvidence | null;
}

export interface RunFilters {
  status?: string;
  task?: string;
  agentId?: string;
  limit?: number;
  cursor?: string;
}

/** A queued run's place in the Deployment's queue: how many queued runs are ahead of it, oldest first. */
const POSITION_SQL = `(SELECT COUNT(*) FROM agent_runs q WHERE q.status = 'queued'
  AND (q.queued_at < agent_runs.queued_at OR (q.queued_at = agent_runs.queued_at AND q.id < agent_runs.id)))`;


const LIST_COLUMNS = `id, agent_id, task, status, provider, model, started_at, resumed_at, completed_at,
  tokens_used, cost_usd, cost_source, dry_run, resumable, resume_status, (error IS NOT NULL) AS failed,
  queued_at, held_by, CASE WHEN status = 'queued' THEN ${POSITION_SQL} ELSE NULL END AS position,
  ${contextValue('replaced')} AS replaced, ${contextValue('replaces')} AS replaces,
  harness, leased_by, lease_expires_at,
  (SELECT c.machine_id FROM member_credentials c WHERE c.id = agent_runs.leased_by) AS leased_machine,
  (SELECT c.member_id FROM member_credentials c WHERE c.id = agent_runs.leased_by) AS leased_member,
  (SELECT m.label FROM member_credentials c CROSS JOIN members m ON m.id = c.member_id WHERE c.id = agent_runs.leased_by) AS leased_member_label,
  ${DISPATCH_ACTOR_SQL} AS started_by, ${contextValue('session_id')} AS target_session_id,
  CASE WHEN status = 'skipped' THEN ${contextValue('reason')} END AS skip_reason`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, instruction, session_ref, actual_cost_usd, estimated_cost_usd, reasoning_level,
  resume_mode, resume_attempts, error, dispatched_by, usage_data, actions_taken, checkpoints`;

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
    id: row.id as string,
    agentId: row.agent_id as string,
    task: text(row.task),
    status: row.status as string,
    provider: text(row.provider),
    model: text(row.model),
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
    skipReason: text(row.skip_reason),
  };
}

function toDetailRow(row: Record<string, unknown>, ownNames: ReadonlyMap<string, string>): RunDetailRow {
  return {
    ...toListRow(row, ownNames),
    instruction: text(row.instruction),
    sessionRef: text(row.session_ref),
    actualCostUsd: num(row.actual_cost_usd),
    estimatedCostUsd: num(row.estimated_cost_usd),
    reasoningLevel: text(row.reasoning_level),
    resumeMode: text(row.resume_mode),
    resumeAttempts: (row.resume_attempts as number | null) ?? 0,
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
  // A run that waited keeps the place it took when it queued, launched or not: the instant it entered the list never moves under a reader paging through it.
  const k = keyset(opts, { order: 'COALESCE(queued_at, started_at)', id: 'id', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const conditions = ['project_id = ?'];
  const params: (string | number)[] = [scope.projectId];
  if (opts.status !== undefined) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.task !== undefined) { conditions.push('task = ?'); params.push(opts.task); }
  if (opts.agentId !== undefined) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
  if (k.where !== '') conditions.push(k.where);
  const { results } = await db
    .prepare(`SELECT ${LIST_COLUMNS} FROM agent_runs WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(queued_at, started_at) DESC, id DESC LIMIT ?`)
    .bind(...params, ...k.params, k.limit + 1)
    .all<Record<string, unknown>>();
  const listed = page(results, k.limit, (r) => ({ createdAt: num(r.queued_at) ?? num(r.started_at) ?? 0, id: r.id as string }));
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

/**
 * Every call a run made back to the Deployment, oldest first.
 *
 * An empty list is the answer for a run that made none, which is the reading
 * that matters: a run whose harness never called is indistinguishable from one
 * that worked until this list is read.
 */
export async function runToolCalls(db: RelationalStore, scope: ReadScope, runId: string, limit = MAX_TOOL_CALLS): Promise<RunToolCallRow[]> {
  const { results } = await db
    .prepare(`SELECT tool_name AS tool, duration_ms AS durationMs, outcome, payload, recorded_at AS recordedAt
       FROM agent_run_events WHERE project_id = ? AND run_id = ? AND event_type = ?
       ORDER BY recorded_at ASC, id ASC LIMIT ?`)
    .bind(scope.projectId, runId, RUN_TOOL_EVENT, limit)
    .all<Record<string, unknown>>();
  return results.map((r) => {
    const failure = failureOf(text(r.outcome), text(r.payload));
    return {
      tool: String(r.tool ?? ''),
      op: opOfPayload(text(r.payload)),
      durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
      recordedAt: Number(r.recordedAt ?? 0),
      ...(failure === null ? {} : { failure }),
    };
  });
}

/** One run inside the scope with its phases and the calls it made, its machine named as of `nowMs`, or null — including when the run exists under another project. */
export async function getRunDetail(db: RelationalStore, scope: ReadScope, runId: string, nowMs: number, viewerId: string): Promise<RunDetail | null> {
  const [[found], ownNames] = await Promise.all([db.batch([
    db.prepare(`SELECT ${DETAIL_COLUMNS} FROM agent_runs WHERE project_id = ? AND id = ?`).bind(scope.projectId, runId),
  ]), ownMachineNames(db, viewerId, nowMs)]);
  const row = (found!.results[0] ?? null) as Record<string, unknown> | null;
  if (row === null) return null;
  const run = await getRun(db, scope, runId);
  return {
    run: toDetailRow(row, ownNames), phases: phasesOf(text(row.checkpoints)), toolCalls: await runToolCalls(db, scope, runId),
    outcomeEvidence: run === null ? null : await readRunCloseEvidence(db, scope, run),
  };
}
