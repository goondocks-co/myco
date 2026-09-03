import type { RelationalStore } from '../core/adapters.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';

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
  /** The limit that holds a queued run, by name; null once it launches. */
  heldBy: string | null;
  /** How many queued runs are ahead of a queued run; null for any other. */
  position: number | null;
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

export interface RunDetail {
  run: RunDetailRow;
  /** The phases the checkpoint records; empty when it records none, null when it cannot be read. */
  phases: PhaseRow[] | null;
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
  queued_at, held_by, CASE WHEN status = 'queued' THEN ${POSITION_SQL} ELSE NULL END AS position`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, instruction, session_ref, actual_cost_usd, estimated_cost_usd, reasoning_level,
  resume_mode, resume_attempts, error, dispatched_by, usage_data, actions_taken, checkpoints`;

const text = (value: unknown): string | null => (value as string | null) ?? null;
const num = (value: unknown): number | null => (value as number | null) ?? null;
const flag = (value: unknown): boolean => Number(value) === 1;

function toListRow(row: Record<string, unknown>): RunListRow {
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
  };
}

function toDetailRow(row: Record<string, unknown>): RunDetailRow {
  return {
    ...toListRow(row),
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

/** A project's runs, newest first, one page at a time; `status` and `task` narrow the set before the cursor applies. */
export async function listRuns(db: RelationalStore, scope: ReadScope, opts: RunFilters = {}): Promise<Page<RunListRow>> {
  // A queued run has no start yet; it takes its place in the list from the instant it queued.
  const k = keyset(opts, { order: 'COALESCE(started_at, queued_at)', id: 'id', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const conditions = ['project_id = ?'];
  const params: (string | number)[] = [scope.projectId];
  if (opts.status !== undefined) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.task !== undefined) { conditions.push('task = ?'); params.push(opts.task); }
  if (opts.agentId !== undefined) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
  if (k.where !== '') conditions.push(k.where);
  const { results } = await db
    .prepare(`SELECT ${LIST_COLUMNS} FROM agent_runs WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(started_at, queued_at) DESC, id DESC LIMIT ?`)
    .bind(...params, ...k.params, k.limit + 1)
    .all<Record<string, unknown>>();
  return page(results.map(toListRow), k.limit, (r) => ({ createdAt: r.startedAt ?? r.queuedAt ?? 0, id: r.id }));
}

/** One run inside the scope with its phases, or null — including when the run exists under another project. */
export async function getRunDetail(db: RelationalStore, scope: ReadScope, runId: string): Promise<RunDetail | null> {
  const row = await db
    .prepare(`SELECT ${DETAIL_COLUMNS} FROM agent_runs WHERE project_id = ? AND id = ?`)
    .bind(scope.projectId, runId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  return { run: toDetailRow(row), phases: phasesOf(text(row.checkpoints)) };
}
