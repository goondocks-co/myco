/**
 * Aggregate health queries over the three observability tables no
 * agent-facing tool reads today: agent_run_events, agent_run_write_intents,
 * agent_runs. Backs `vault_run_health` (agent/tools/observability-tools.ts).
 *
 * Aggregate-first by design (repo doctrine: tool gates over self-checks):
 * every bucket here is deterministic SQL. The agent tool returns these
 * rows verbatim — a model interprets them, it never re-derives the
 * anomaly detection itself.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { epochSeconds } from '@myco/constants.js';
import { BUNDLED_AGENT_TASKS } from '@myco/agent/definitions.generated.js';

// ---------------------------------------------------------------------------
// Shared window helper
// ---------------------------------------------------------------------------

export interface RunHealthWindow {
  /** Inclusive lower bound, epoch seconds. */
  startedAfter: number;
  /** Upper bound, epoch seconds — always "now" at query time. */
  endedBefore: number;
  windowHours: number;
}

export function resolveRunHealthWindow(windowHours: number, now = epochSeconds()): RunHealthWindow {
  return {
    startedAfter: now - Math.max(0, windowHours) * 3600,
    endedBefore: now,
    windowHours,
  };
}

/** Cap on attribution rows (run ids, task names, etc.) returned per bucket. */
const DEFAULT_ATTRIBUTION_LIMIT = 25;

// ---------------------------------------------------------------------------
// 1. unpaired_events — pre/post tool-use count mismatch
// ---------------------------------------------------------------------------

export interface UnpairedEventGroup {
  run_id: string;
  phase_name: string | null;
  tool_name: string | null;
  pre_count: number;
  post_count: number;
}

/**
 * Groups of (run_id, phase_name, tool_name) within the window whose
 * pre_tool_use count differs from its post_tool_use count. `agent_run_events`
 * has no row-level pairing key, so a count mismatch is the only
 * deterministic signal available — it does not distinguish "process died
 * mid-tool" from "a best-effort post insert was swallowed". A count diff
 * is NOT itself an error signal: post fires even when a tool call ends in
 * outcome 'error', so a balanced pre/post count with error outcomes is
 * normal and excluded here by construction (only the count imbalance is
 * flagged, never individual error rows). Excludes the calling run itself
 * (`excludeRunId`): the audit wrapper inserts `pre_tool_use` synchronously
 * before the handler runs (tools.ts) and the matching `post_tool_use` lands
 * only after the handler returns, so the current `vault_run_health` call's
 * own in-flight pre row is otherwise a guaranteed false positive on every
 * invocation. Not filtered by terminal status — a process-death run stays
 * status='running' forever and is this bucket's primary target.
 */
export function findUnpairedEvents(
  window: RunHealthWindow,
  scope: ProjectScope,
  excludeRunId: string,
  limit = DEFAULT_ATTRIBUTION_LIMIT,
): UnpairedEventGroup[] {
  const db = getDatabase();
  const conditions = [
    'event_type IN (\'pre_tool_use\', \'post_tool_use\')',
    'recorded_at >= ?',
    'recorded_at <= ?',
    'run_id != ?',
  ];
  const params: unknown[] = [window.startedAfter, window.endedBefore, excludeRunId];
  appendProjectCondition(conditions, params, scope);
  const rows = db.prepare(
    `SELECT
       run_id,
       phase_name,
       tool_name,
       SUM(CASE WHEN event_type = 'pre_tool_use' THEN 1 ELSE 0 END) AS pre_count,
       SUM(CASE WHEN event_type = 'post_tool_use' THEN 1 ELSE 0 END) AS post_count
     FROM agent_run_events
     WHERE ${conditions.join(' AND ')}
     GROUP BY run_id, phase_name, tool_name
     HAVING pre_count != post_count
     ORDER BY run_id ASC
     LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    run_id: row.run_id as string,
    phase_name: (row.phase_name as string) ?? null,
    tool_name: (row.tool_name as string) ?? null,
    pre_count: Number(row.pre_count),
    post_count: Number(row.post_count),
  }));
}

// ---------------------------------------------------------------------------
// 2. cap_hits + postcondition_failures — actions_taken JSON flags
// ---------------------------------------------------------------------------

export interface PhaseFlagHit {
  run_id: string;
  task: string | null;
  phase_name: string | null;
}

/**
 * Runs in the window whose `actions_taken.phases[]` carries a phase entry
 * with the given boolean flag set to true. Detects via the JSON payload
 * (`buildPhaseResult` in executor-state.ts writes `capHit`/
 * `postConditionFailed` only when `=== true`, on both success and failure
 * paths) — NOT via error-string matching. The executor's postcondition
 * error text (`Phase "…" postcondition "…" not satisfied: …`) is an
 * internal message that does not reliably survive to a matchable column;
 * matching it returns zero rows. The JSON flag is the only deterministic
 * signal.
 */
function findPhaseFlagHits(
  flagKey: 'capHit' | 'postConditionFailed',
  window: RunHealthWindow,
  scope: ProjectScope,
  limit: number,
): PhaseFlagHit[] {
  const db = getDatabase();
  const conditions = [
    'r.actions_taken IS NOT NULL',
    'r.started_at >= ?',
    'r.started_at <= ?',
  ];
  const params: unknown[] = [window.startedAfter, window.endedBefore];
  appendProjectCondition(conditions, params, scope, 'r');
  const rows = db.prepare(
    `SELECT DISTINCT r.id AS run_id, r.task AS task, json_extract(phase.value, '$.name') AS phase_name
     FROM agent_runs r, json_each(json_extract(r.actions_taken, '$.phases')) AS phase
     WHERE ${conditions.join(' AND ')}
       AND json_extract(phase.value, '$.${flagKey}') = 1
     ORDER BY r.id ASC
     LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    run_id: row.run_id as string,
    task: (row.task as string) ?? null,
    phase_name: (row.phase_name as string) ?? null,
  }));
}

export function findCapHits(
  window: RunHealthWindow,
  scope: ProjectScope,
  limit = DEFAULT_ATTRIBUTION_LIMIT,
): PhaseFlagHit[] {
  return findPhaseFlagHits('capHit', window, scope, limit);
}

export function findPostConditionFailures(
  window: RunHealthWindow,
  scope: ProjectScope,
  limit = DEFAULT_ATTRIBUTION_LIMIT,
): PhaseFlagHit[] {
  return findPhaseFlagHits('postConditionFailed', window, scope, limit);
}

// ---------------------------------------------------------------------------
// 3. cost_spikes — per (task, provider) mean cost vs trailing window
// ---------------------------------------------------------------------------

export interface CostSpike {
  task: string | null;
  provider: string | null;
  window_mean_cost_usd: number;
  window_run_count: number;
  trailing_mean_cost_usd: number;
  trailing_run_count: number;
  ratio: number;
}

interface CostAggRow {
  task: string | null;
  provider: string | null;
  mean_cost: number;
  run_count: number;
}

function aggregateCostByTaskProvider(
  startedAfter: number,
  endedBefore: number,
  scope: ProjectScope,
): CostAggRow[] {
  const db = getDatabase();
  const conditions = [
    'started_at >= ?',
    'started_at <= ?',
    // Local providers hard-zero costUsd — a mixed mean of real and
    // hard-zeroed costs masks genuine spikes, so zero-cost rows are
    // excluded from the mean rather than segmented by provider alone.
    'cost_usd IS NOT NULL',
    'cost_usd != 0',
  ];
  const params: unknown[] = [startedAfter, endedBefore];
  appendProjectCondition(conditions, params, scope);
  const rows = db.prepare(
    `SELECT task, provider, AVG(cost_usd) AS mean_cost, COUNT(*) AS run_count
     FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     GROUP BY task, provider`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    task: (row.task as string) ?? null,
    provider: (row.provider as string) ?? null,
    mean_cost: Number(row.mean_cost ?? 0),
    run_count: Number(row.run_count ?? 0),
  }));
}

/**
 * (task, provider) pairs whose mean cost_usd in the window exceeds the
 * mean cost_usd in the trailing window (the window immediately before it,
 * same length) by at least `spikeRatio`. Zero-cost rows (local providers
 * hard-zero costUsd) are excluded from both means so a mixed population
 * never masks a real spike. Requires at least one run with nonzero cost
 * in both windows to compute a ratio — a (task, provider) with no
 * trailing baseline is not reported (nothing to compare against).
 */
export function findCostSpikes(
  window: RunHealthWindow,
  scope: ProjectScope,
  spikeRatio: number,
): CostSpike[] {
  const spanSeconds = window.endedBefore - window.startedAfter;
  const trailingStart = window.startedAfter - spanSeconds;
  const trailingEnd = window.startedAfter;

  const current = aggregateCostByTaskProvider(window.startedAfter, window.endedBefore, scope);
  const trailing = aggregateCostByTaskProvider(trailingStart, trailingEnd, scope);
  const trailingByKey = new Map(trailing.map((row) => [`${row.task ?? ''} ${row.provider ?? ''}`, row]));

  const spikes: CostSpike[] = [];
  for (const row of current) {
    const key = `${row.task ?? ''} ${row.provider ?? ''}`;
    const base = trailingByKey.get(key);
    if (!base || base.mean_cost <= 0) continue;
    const ratio = row.mean_cost / base.mean_cost;
    if (ratio >= spikeRatio) {
      spikes.push({
        task: row.task,
        provider: row.provider,
        window_mean_cost_usd: row.mean_cost,
        window_run_count: row.run_count,
        trailing_mean_cost_usd: base.mean_cost,
        trailing_run_count: base.run_count,
        ratio,
      });
    }
  }
  return spikes.sort((a, b) => b.ratio - a.ratio);
}

// ---------------------------------------------------------------------------
// 4. flag_clusters — semantic-check 'flag' write intents
// ---------------------------------------------------------------------------

export interface FlagClusterEntry {
  run_id: string;
  task: string | null;
  tool_name: string;
  classifier_reason: string | null;
  recorded_at: number;
}

/**
 * Write intents in the window whose classifier_verdict is the literal
 * string 'flag' — the semantic check ran and blocked the write. This is
 * NOT the same population as "every write_intents row": dry-run
 * interception (wrapToolWithDryRun in agent/tools.ts) inserts a row for
 * every intercepted write with classifier_verdict left NULL, so an
 * unfiltered count over agent_run_write_intents is dominated by ordinary
 * dry-run traffic, not flagged writes.
 */
export function findFlagClusters(
  window: RunHealthWindow,
  scope: ProjectScope,
  limit = DEFAULT_ATTRIBUTION_LIMIT,
): FlagClusterEntry[] {
  const db = getDatabase();
  const conditions = [
    'wi.classifier_verdict = \'flag\'',
    'wi.recorded_at >= ?',
    'wi.recorded_at <= ?',
  ];
  const params: unknown[] = [window.startedAfter, window.endedBefore];
  appendProjectCondition(conditions, params, scope, 'wi');
  const rows = db.prepare(
    `SELECT wi.run_id AS run_id, r.task AS task, wi.tool_name AS tool_name,
            wi.classifier_reason AS classifier_reason, wi.recorded_at AS recorded_at
     FROM agent_run_write_intents wi
     LEFT JOIN agent_runs r ON r.id = wi.run_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY wi.recorded_at DESC
     LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    run_id: row.run_id as string,
    task: (row.task as string) ?? null,
    tool_name: row.tool_name as string,
    classifier_reason: (row.classifier_reason as string) ?? null,
    recorded_at: Number(row.recorded_at),
  }));
}

// ---------------------------------------------------------------------------
// 5. zero_usage — completed/failed runs with zero telemetry
// ---------------------------------------------------------------------------

export interface ZeroUsageRun {
  run_id: string;
  task: string | null;
  status: string;
}

/**
 * Completed runs with tokens_used = 0, plus failed runs whose usage
 * telemetry is entirely zero/absent (tokens_used = 0 AND cost_usd is
 * NULL or 0). The failed-run half is an honest info-tier signal, not an
 * alarm: it flags runs whose failure telemetry was unrecoverable, not a
 * claim that every failed local run qualifies (a failed run with partial
 * usage recorded before the failure is excluded).
 */
export function findZeroUsageRuns(
  window: RunHealthWindow,
  scope: ProjectScope,
  limit = DEFAULT_ATTRIBUTION_LIMIT,
): ZeroUsageRun[] {
  const db = getDatabase();
  const conditions = [
    'started_at >= ?',
    'started_at <= ?',
    `(
       (status = 'completed' AND COALESCE(tokens_used, 0) = 0)
       OR (status = 'failed' AND COALESCE(tokens_used, 0) = 0 AND COALESCE(cost_usd, 0) = 0)
     )`,
  ];
  const params: unknown[] = [window.startedAfter, window.endedBefore];
  appendProjectCondition(conditions, params, scope);
  const rows = db.prepare(
    `SELECT id AS run_id, task, status
     FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY started_at DESC
     LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    run_id: row.run_id as string,
    task: (row.task as string) ?? null,
    status: row.status as string,
  }));
}

// ---------------------------------------------------------------------------
// 6. silent_streams — YAML-default-enabled tasks with zero runs
// ---------------------------------------------------------------------------

export interface SilentStream {
  task: string;
  interval_seconds: number;
}

/**
 * Tasks that are enabled-by-default in the bundled YAML schedule (no
 * per-project myco.yaml override applied — `resolveSchedule` in
 * task-scheduler.ts is module-private and not reachable from a query
 * module, so this reads BUNDLED_AGENT_TASKS directly) with no task-level
 * `preCondition` gate, that produced zero runs in the window. Info-tier
 * only: a task can be legitimately quiet (nothing to do, or a myco.yaml
 * override disabled it) — this bucket's description exists to point an
 * operator at "check whether this is expected", never to alarm on its
 * own. The bundled-YAML default is an honest approximation of the
 * effective schedule, not the effective schedule itself.
 */
export function findSilentStreams(
  window: RunHealthWindow,
  scope: ProjectScope,
): SilentStream[] {
  const candidates = BUNDLED_AGENT_TASKS.filter(
    (task) => task.schedule?.enabled === true && !task.schedule?.preCondition,
  );
  if (candidates.length === 0) return [];

  const db = getDatabase();
  const conditions = ['task = ?', 'started_at >= ?', 'started_at <= ?'];
  const baseParams: unknown[] = [window.startedAfter, window.endedBefore];

  const silent: SilentStream[] = [];
  for (const task of candidates) {
    const params = [task.name, ...baseParams];
    const conds = [...conditions];
    appendProjectCondition(conds, params, scope);
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM agent_runs WHERE ${conds.join(' AND ')}`,
    ).get(...params) as { count: number };
    if (Number(row.count) === 0) {
      silent.push({ task: task.name, interval_seconds: task.schedule!.intervalSeconds });
    }
  }
  return silent;
}
