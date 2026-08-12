import type { Database } from 'bun:sqlite';
import { sha256Hex } from './hash.js';
import type { DiagnosticWindow } from './types.js';

/**
 * Allowlist principle: every SELECT below lists columns explicitly (no
 * `SELECT *`) so a future migration can never leak a new prose column into
 * a default bundle by accident. Prose columns are still selected (needed
 * to compute their hash) but are stripped from the emitted row unless
 * `includeContent` is set — see `hashProse`.
 */

// -- sessions (schema-ddl.ts:28-60) -- title/summary are the only prose.
const SESSION_STRUCTURAL_COLS =
  'id, agent, "user", project_root, project_id, branch, started_at, ended_at, status, ' +
  'prompt_count, tool_count, transcript_path, parent_session_id, parent_session_reason, ' +
  'processed, content_hash, created_at, embedded, machine_id, synced_at, ' +
  'canopy_injections_offered, canopy_injection_total_tokens, canopy_skips_after_injection, ' +
  'canopy_reads_after_injection, canopy_tokens_saved, canopy_redundant_reads, ' +
  'canopy_map_tool_calls, final_mine_ok';
const SESSION_PROSE_COLS = ['title', 'summary'];

// -- prompt_batches (schema-ddl.ts:85-110) -- user_prompt gets the special
// cross-layer sha256-only treatment; response_summary gets the generic
// hash+bytes treatment. `classification` is a short categorical label
// (see skill-evolve-style CURRENT/STALE enums elsewhere in this codebase),
// not free text -- structural.
const BATCH_STRUCTURAL_COLS =
  'id, project_id, session_id, parent_prompt_batch_id, kind, origin, prompt_number, ' +
  'classification, started_at, ended_at, status, activity_count, processed, content_hash, ' +
  'created_at, machine_id, synced_at, thread_id, thread_label';

// -- session_tombstones (schema-ddl.ts:77-83) -- no created_at; window on deleted_at.
const TOMBSTONE_COLS = 'session_id, project_id, deleted_at, source';

// -- agent_runs (schema-ddl.ts:391-424). Prose: instruction, checkpoints,
// actions_taken, error, run_context (run_context is structured JSON keyed
// by candidate_id/hashes/watermark -- see agent/types.ts:669-674 -- but is
// treated as prose here per the brief's floor). task/usage_data/cost_data/
// execution_overrides are structured (task is a YAML task name; usage_data
// and cost_data are numeric accounting JSON; execution_overrides is a
// config-override packet -- see agent/types.ts:701-739) -- structural.
const AGENT_RUN_COLS =
  'id, project_id, agent_id, task, instruction, status, harness, provider, model, ' +
  'session_ref, resumable, resume_status, resume_mode, resumed_at, checkpoints, usage_data, ' +
  'started_at, completed_at, tokens_used, cost_usd, actual_cost_usd, estimated_cost_usd, ' +
  'cost_source, cost_data, actions_taken, error, dry_run, reasoning_level, ' +
  'execution_overrides, resume_attempts, run_context';
const RUN_PROSE_COLS = ['instruction', 'checkpoints', 'actions_taken', 'error', 'run_context'];

// -- agent_reports (schema-ddl.ts:426-436). Prose: summary (NOT NULL), details.
const AGENT_REPORT_COLS = 'id, project_id, run_id, agent_id, action, summary, details, created_at';
const REPORT_PROSE_COLS = ['summary', 'details'];

// -- agent_turns (schema-ddl.ts:438-450). Prose: tool_input, tool_output_summary.
const AGENT_TURN_COLS =
  'id, project_id, run_id, agent_id, turn_number, tool_name, tool_input, tool_output_summary, ' +
  'started_at, completed_at';
const TURN_PROSE_COLS = ['tool_input', 'tool_output_summary'];

// -- log_entries (schema-ddl.ts:514-525). `data` is the only prose-bearing
// column -- see redactLogPayload; `message` is always a static, code-authored
// string (e.g. event-dispatch.ts:545 logs "User prompt received", never the
// prompt itself) so it is safe verbatim.
const LOG_ENTRY_COLS = 'id, project_id, timestamp, level, component, kind, message, data, session_id';

function toJsonl(rows: unknown[], table: string): string {
  return rows.map((row) => JSON.stringify({ table, row })).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * Prose -> hash+bytes projection shared by every prose-bearing table other
 * than `user_prompt` (which gets its own sha256-only treatment below).
 * Non-string values (including null) are left as-is with no hash pair.
 */
function hashProse(
  row: Record<string, unknown>,
  proseCols: string[],
  includeContent: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const col of proseCols) {
    const value = out[col];
    if (!includeContent) delete out[col];
    if (typeof value === 'string') {
      out[`${col}_sha256`] = sha256Hex(value);
      out[`${col}_bytes`] = Buffer.byteLength(value, 'utf8');
    }
  }
  return out;
}

/**
 * Project a prompt_batches row: `response_summary` gets the generic
 * hash+bytes treatment; `user_prompt` gets sha256-only (no `_bytes`) of the
 * TRIMMED text so it is directly comparable to skeletonize.ts's
 * `text_sha256` (both hash `text.trim()`), the cross-layer correlation key
 * that lets a diagnostic reader match a transcript event to its batch
 * without either side carrying the prompt itself.
 */
function projectBatchRow(row: Record<string, unknown>, includeContent: boolean): Record<string, unknown> {
  const { user_prompt, ...rest } = row;
  const projected = hashProse(rest, ['response_summary'], includeContent);
  return {
    ...projected,
    user_prompt_sha256: typeof user_prompt === 'string' ? sha256Hex(user_prompt.trim()) : null,
    ...(includeContent ? { user_prompt } : {}),
  };
}

/**
 * sessions + prompt_batches + session_tombstones, windowed and tagged by
 * table for `sessions.jsonl`. Sessions window on
 * `[started_at, COALESCE(ended_at, started_at)]` overlap; batches the same
 * shape; tombstones (no created_at) window on `deleted_at` alone.
 */
export function collectSessionRows(db: Database, w: DiagnosticWindow, includeContent: boolean): string {
  const params = { $since: w.since, $until: w.until };

  const sessions = db
    .query(
      `SELECT ${SESSION_STRUCTURAL_COLS}, title, summary FROM sessions
       WHERE started_at <= $until AND COALESCE(ended_at, started_at) >= $since
       ORDER BY started_at`,
    )
    .all(params) as Array<Record<string, unknown>>;

  const batches = db
    .query(
      `SELECT ${BATCH_STRUCTURAL_COLS}, user_prompt, response_summary FROM prompt_batches
       WHERE started_at <= $until AND COALESCE(ended_at, started_at) >= $since
       ORDER BY started_at`,
    )
    .all(params) as Array<Record<string, unknown>>;

  const tombstones = db
    .query(
      `SELECT ${TOMBSTONE_COLS} FROM session_tombstones
       WHERE deleted_at BETWEEN $since AND $until
       ORDER BY deleted_at`,
    )
    .all(params);

  return (
    toJsonl(sessions.map((r) => hashProse(r, SESSION_PROSE_COLS, includeContent)), 'sessions') +
    toJsonl(batches.map((r) => projectBatchRow(r, includeContent)), 'prompt_batches') +
    toJsonl(tombstones, 'session_tombstones')
  );
}

/**
 * agent_runs + agent_reports + agent_turns, windowed and tagged by table for
 * `agent-runs.jsonl`. Runs window on `COALESCE(started_at, completed_at)` --
 * agent_runs has no `created_at` (schema-ddl.ts:391-424); a NULL
 * `started_at` (queued, never dispatched) is included only if `completed_at`
 * falls in the window, and a run with neither set is never in scope.
 * Children are scoped to the windowed runs' ids, not independently windowed.
 */
export function collectAgentRuns(db: Database, w: DiagnosticWindow, includeContent: boolean): string {
  const params = { $since: w.since, $until: w.until };

  const runs = db
    .query(
      `SELECT ${AGENT_RUN_COLS} FROM agent_runs
       WHERE COALESCE(started_at, completed_at) BETWEEN $since AND $until
       ORDER BY COALESCE(started_at, completed_at)`,
    )
    .all(params) as Array<Record<string, unknown>>;

  const runIds = runs.map((r) => r.id as string);
  const placeholders = runIds.map(() => '?').join(', ');

  const reports =
    runIds.length === 0
      ? []
      : (db
          .query(`SELECT ${AGENT_REPORT_COLS} FROM agent_reports WHERE run_id IN (${placeholders}) ORDER BY created_at`)
          .all(...runIds) as Array<Record<string, unknown>>);

  const turns =
    runIds.length === 0
      ? []
      : (db
          .query(`SELECT ${AGENT_TURN_COLS} FROM agent_turns WHERE run_id IN (${placeholders}) ORDER BY turn_number`)
          .all(...runIds) as Array<Record<string, unknown>>);

  return (
    toJsonl(runs.map((r) => hashProse(r, RUN_PROSE_COLS, includeContent)), 'agent_runs') +
    toJsonl(reports.map((r) => hashProse(r, REPORT_PROSE_COLS, includeContent)), 'agent_reports') +
    toJsonl(turns.map((r) => hashProse(r, TURN_PROSE_COLS, includeContent)), 'agent_turns')
  );
}

/**
 * log_entries, windowed on the ISO `timestamp` column and tagged for
 * `log-entries.jsonl`. `timestamp` is stored as ISO-8601 text (not epoch),
 * so the window bounds are converted before binding.
 */
export function collectLogEntries(db: Database, w: DiagnosticWindow, includeContent: boolean): string {
  const rows = db
    .query(
      `SELECT ${LOG_ENTRY_COLS} FROM log_entries
       WHERE timestamp >= $since AND timestamp <= $until
       ORDER BY timestamp`,
    )
    .all({
      $since: new Date(w.since * 1000).toISOString(),
      $until: new Date(w.until * 1000).toISOString(),
    }) as Array<Record<string, unknown>>;

  return toJsonl(rows.map((r) => redactLogPayload(r, includeContent)), 'log_entries');
}

/**
 * Redact a `log_entries` row's `data` payload (the F1 privacy gate): the
 * daemon logs `prompt_preview` (first N chars of every prompt) into `data`
 * at info level (event-dispatch.ts:538-547) and `log-entry-insert.ts`
 * spreads arbitrary event payloads into this column -- `data` is prose,
 * everything else on the row is structural and stays verbatim. Also
 * consumed directly by Task 8's `collectDaemonLog` with `includeContent`
 * hardcoded `false` (a machine-global daemon log has no per-window content
 * gate).
 */
export function redactLogPayload(
  row: Record<string, unknown>,
  includeContent: boolean,
): Record<string, unknown> {
  const { data, ...structural } = row;
  if (includeContent || data === null || data === undefined) {
    return { ...structural, data };
  }
  const payload: Record<string, { byte_length: number; sha256: string }> = {};
  try {
    const parsed = JSON.parse(String(data)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      const serialized = JSON.stringify(value);
      payload[key] = { byte_length: Buffer.byteLength(serialized, 'utf8'), sha256: sha256Hex(serialized) };
    }
  } catch {
    const serialized = String(data);
    payload._unparseable = { byte_length: Buffer.byteLength(serialized, 'utf8'), sha256: sha256Hex(serialized) };
  }
  return { ...structural, payload };
}
