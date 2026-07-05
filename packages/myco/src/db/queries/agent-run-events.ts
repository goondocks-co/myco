/**
 * Query helpers for agent_run_events — the append-only lifecycle-event
 * log populated by the harness hook system (preToolUse/postToolUse/
 * phaseStart/phaseEnd). See docs/superpowers/specs/
 * 2026-07-01-harness-hook-system-design.md.
 *
 * Same append-only convention as write-intents.ts: no UPDATE/DELETE
 * helper is exposed, insert-order (= id order) is the natural cursor for
 * incremental polling.
 */

import { getDatabase } from '@myco/db/client.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import { epochSeconds } from '@myco/constants.js';
import { tryParseJson } from '@myco/utils/json.js';

export interface RunEventInsert {
  runId: string;
  projectId?: GroveProjectId | null;
  phaseName?: string | null;
  eventType: 'pre_tool_use' | 'post_tool_use' | 'phase_start' | 'phase_end';
  toolName?: string | null;
  outcome?: 'success' | 'error' | null;
  durationMs?: number | null;
  /** JSON-stringified full event payload, for forward-compat fields not promoted to a column. */
  payload?: string | null;
  recordedAt?: number;
}

export interface RunEventRow {
  id: number;
  project_id: string | null;
  run_id: string;
  phase_name: string | null;
  event_type: string;
  tool_name: string | null;
  outcome: string | null;
  duration_ms: number | null;
  payload: unknown;
  recorded_at: number;
}

const EVENT_COLUMNS = [
  'id', 'project_id', 'run_id', 'phase_name', 'event_type',
  'tool_name', 'outcome', 'duration_ms', 'payload', 'recorded_at',
] as const;

const SELECT_COLUMNS = EVENT_COLUMNS.join(', ');

function toRunEventRow(row: Record<string, unknown>): RunEventRow {
  return {
    id: row.id as number,
    project_id: (row.project_id as string) ?? null,
    run_id: row.run_id as string,
    phase_name: (row.phase_name as string) ?? null,
    event_type: row.event_type as string,
    tool_name: (row.tool_name as string) ?? null,
    outcome: (row.outcome as string) ?? null,
    duration_ms: (row.duration_ms as number) ?? null,
    payload: tryParseJson(row.payload),
    recorded_at: row.recorded_at as number,
  };
}

/** Insert a new lifecycle event. Returns the autoincrement id. */
export function insertRunEvent(data: RunEventInsert): number {
  const db = getDatabase();
  const recordedAt = data.recordedAt ?? epochSeconds();
  const info = db.prepare(
    `INSERT INTO agent_run_events
       (project_id, run_id, phase_name, event_type, tool_name, outcome, duration_ms, payload, recorded_at)
     VALUES (COALESCE(?, (SELECT project_id FROM agent_runs WHERE id = ?)), ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.projectId ?? null,
    data.runId,
    data.runId,
    data.phaseName ?? null,
    data.eventType,
    data.toolName ?? null,
    data.outcome ?? null,
    data.durationMs ?? null,
    data.payload ?? null,
    recordedAt,
  );
  return Number(info.lastInsertRowid);
}

export interface ListRunEventsOptions {
  /** Only return rows with id > sinceId — cursor-based incremental polling. */
  sinceId?: number;
  limit?: number;
  scope: ProjectScope;
}

/** List lifecycle events for a run, ordered by id (= insert order). */
export function listRunEvents(runId: string, options: ListRunEventsOptions): RunEventRow[] {
  const db = getDatabase();
  const conditions = ['run_id = ?'];
  const params: unknown[] = [runId];
  if (options.sinceId !== undefined) {
    conditions.push('id > ?');
    params.push(options.sinceId);
  }
  appendProjectCondition(conditions, params, options.scope);
  let tail = 'ORDER BY id ASC';
  if (options.limit !== undefined) {
    tail += ' LIMIT ?';
    params.push(options.limit);
  }
  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_run_events
     WHERE ${conditions.join(' AND ')}
     ${tail}`,
  ).all(...params) as Record<string, unknown>[];
  return rows.map(toRunEventRow);
}

/**
 * Counts `post_tool_use` events for a run, phase, tool name, and outcome.
 * `agent_turns` (turns.ts) has no phase column; only `agent_run_events`
 * carries `phase_name`. `outcome: 'success'` means the call did not
 * throw/report `isError` — an app-level `textResult({ error })` return
 * still counts as 'success'.
 */
export function countPhaseToolCallsByOutcome(
  runId: string,
  phaseName: string,
  toolName: string,
  outcome: 'success' | 'error',
): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) as count
     FROM agent_run_events
     WHERE run_id = ? AND phase_name = ? AND event_type = 'post_tool_use'
       AND tool_name = ? AND outcome = ?`,
  ).get(runId, phaseName, toolName, outcome) as { count: number };
  return row.count;
}

/**
 * Counts `post_tool_use` events for a run, tool name, and outcome across
 * every phase. Same shape as `countPhaseToolCallsByOutcome` without the
 * `phase_name` filter — for callers that need a run-scoped total rather
 * than a single phase's.
 */
export function countRunToolCallsByOutcome(
  runId: string,
  toolName: string,
  outcome: 'success' | 'error',
): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) as count
     FROM agent_run_events
     WHERE run_id = ? AND event_type = 'post_tool_use'
       AND tool_name = ? AND outcome = ?`,
  ).get(runId, toolName, outcome) as { count: number };
  return row.count;
}
