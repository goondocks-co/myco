/**
 * Phase audit view — joins agent_runs, agent_reports, agent_turns,
 * usage_data (JSON), checkpoints (JSON), and agent_run_write_intents into a
 * single per-phase summary object.
 *
 * This is a READ-ONLY view. It performs no writes and must remain cheap
 * enough to call on every page load. All underlying data is captured
 * elsewhere; this module only projects and joins it.
 *
 * Data-attribution notes:
 *
 * 1. `agent_reports` has no phase column — reports are associated to the
 *    run as a whole. The full report list is attached to every
 *    PhaseAuditEntry under `reports`. Callers that need to scope reports
 *    to a phase must do so by timestamp comparison against the checkpoint
 *    `updatedAt` values, which this module does NOT attempt automatically
 *    (false attribution is worse than unattributed). This is a known
 *    limitation documented here.
 *
 * 2. `agent_turns` has no phase column either — tool call counts are
 *    therefore run-level totals, reported on every phase (all phases show
 *    the same aggregated `toolCalls` map). Per-phase turn attribution would
 *    require either a schema change or turn_number range inference.
 *
 * 3. `toolErrors` detection is best-effort only. There is no dedicated error
 *    flag on turn rows; a turn is classified as an error when its
 *    `tool_output_summary` is non-null and does NOT start with a successful
 *    output prefix. In practice the executor stores errors via
 *    `summarizeToolError()` which produces plain error message strings, so
 *    they are indistinguishable from successful text summaries. The emitted
 *    `toolErrors` map will always be empty unless a future schema change
 *    adds an explicit error flag.
 *
 * 4. `writeIntents` are populated only when `run.dry_run === true`. Intents
 *    tagged with a `phase_id` are grouped by that phase; intents with a null
 *    `phase_id` are included in the run total but not attributed to any
 *    specific phase entry (they do not inflate any phase's `byTool` map).
 *
 * 5. `maxTurns` per phase comes from the live task definition. Since the
 *    executor may apply per-phase provider overrides and the stored
 *    checkpoint does not carry the original budget, `maxTurns` is always
 *    null in this view.
 */

import { getRun } from '@myco/db/queries/runs.js';
import { listReports } from '@myco/db/queries/reports.js';
import { listTurnsByRun } from '@myco/db/queries/turns.js';
import { listWriteIntents } from '@myco/db/queries/write-intents.js';
import { parseCheckpointState } from '@myco/agent/executor-state.js';
import { runDurationMs } from '@myco/agent/run-accounting.js';
import { tryParseJson } from '@myco/utils/json.js';
import type { ReportRow } from '@myco/db/queries/reports.js';
import type { TurnRow } from '@myco/db/queries/turns.js';
import type { WriteIntentRow } from '@myco/db/queries/write-intents.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PhaseAudit {
  runId: string;
  taskName: string | null;
  dryRun: boolean;
  phases: PhaseAuditEntry[];
}

export interface PhaseAuditEntry {
  phaseName: string;
  status: 'completed' | 'failed' | 'skipped' | 'pending';
  /** Last assistant message captured during the phase, from checkpoints JSON. */
  summary: string | null;
  turnsUsed: number;
  /**
   * Per-phase turn budget. Always null — the executor does not persist the
   * effective maxTurns into the checkpoint or usage_data JSON.
   */
  maxTurns: number | null;
  tokensUsed: number;
  costUsd: number | null;
  costSource: string | null;
  durationMs: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /**
   * Reason the phase was skipped by the orchestrator. Only set for phases
   * that appear in usage_data with status 'skipped'; otherwise null.
   */
  skipReason: string | null;
  /**
   * Total tool invocations per tool name across the entire run.
   *
   * NOTE: agent_turns has no phase column, so this is a run-level aggregate
   * repeated on every phase. See module JSDoc for details.
   */
  toolCalls: Record<string, number>;
  /**
   * Tool invocations that produced errors, by tool name.
   *
   * NOTE: Currently always an empty map — there is no dedicated error flag
   * on turn rows. See module JSDoc for details.
   */
  toolErrors: Record<string, number>;
  /**
   * Write-intent summary. Null when dry_run is false.
   * Per-phase byTool reflects intents tagged with this phase's name as phase_id.
   */
  writeIntents: {
    total: number;
    byTool: Record<string, number>;
  } | null;
  /**
   * All reports for the run. Attached to every phase because agent_reports
   * has no phase column. See module JSDoc for the attribution limitation.
   */
  reports: Array<{
    action: string;
    summary: string | null;
    details: string | null;
    createdAt: number;
  }>;
}

// ---------------------------------------------------------------------------
// Internal types matching stored JSON shapes
// ---------------------------------------------------------------------------

interface StoredPhaseUsage {
  name: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    durationMs?: number;
    costUsd?: number;
  } | null;
  tokensUsed?: number;
  costUsd?: number | null;
  costSource?: string | null;
}

interface StoredUsageData {
  run?: unknown;
  phases?: StoredPhaseUsage[];
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseUsageData(raw: string | null | undefined): StoredUsageData {
  return tryParseJson<StoredUsageData>(raw) ?? {};
}

function normalizeStatus(
  raw: string | undefined,
): 'completed' | 'failed' | 'skipped' | 'pending' {
  if (raw === 'completed' || raw === 'failed' || raw === 'skipped') return raw;
  return 'pending';
}

// ---------------------------------------------------------------------------
// Turn aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate tool call counts from a list of turns.
 * Returns [toolCalls, toolErrors] maps.
 *
 * toolErrors is always empty — see module JSDoc for the limitation.
 */
function aggregateTurnCounts(
  turns: TurnRow[],
): [Record<string, number>, Record<string, number>] {
  const toolCalls: Record<string, number> = {};
  for (const turn of turns) {
    toolCalls[turn.tool_name] = (toolCalls[turn.tool_name] ?? 0) + 1;
  }
  // No reliable error detection without a schema-level error flag.
  const toolErrors: Record<string, number> = {};
  return [toolCalls, toolErrors];
}

// ---------------------------------------------------------------------------
// Write-intent aggregation
// ---------------------------------------------------------------------------

interface WriteIntentSummary {
  total: number;
  byPhase: Record<string, Record<string, number>>; // phase -> tool -> count
  unattributedByTool: Record<string, number>;       // phase_id IS NULL
  totalByTool: Record<string, number>;              // run total by tool
}

function aggregateWriteIntents(intents: WriteIntentRow[]): WriteIntentSummary {
  const byPhase: Record<string, Record<string, number>> = {};
  const unattributedByTool: Record<string, number> = {};
  const totalByTool: Record<string, number> = {};

  for (const intent of intents) {
    const tool = intent.tool_name;
    totalByTool[tool] = (totalByTool[tool] ?? 0) + 1;

    if (intent.phase_id) {
      if (!byPhase[intent.phase_id]) byPhase[intent.phase_id] = {};
      byPhase[intent.phase_id][tool] = (byPhase[intent.phase_id][tool] ?? 0) + 1;
    } else {
      // Null phase_id: counted in run total but not attributed to any phase.
      unattributedByTool[tool] = (unattributedByTool[tool] ?? 0) + 1;
    }
  }

  return {
    total: intents.length,
    byPhase,
    unattributedByTool,
    totalByTool,
  };
}

// ---------------------------------------------------------------------------
// Report serialization
// ---------------------------------------------------------------------------

function serializeReports(reports: ReportRow[]) {
  return reports.map((r) => ({
    action: r.action,
    summary: r.summary ?? null,
    details: r.details ?? null,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a PhaseAudit for the given run by joining:
 *   - agent_runs (dry_run, task, usage_data, checkpoints)
 *   - agent_reports (all reports for the run)
 *   - agent_turns (tool call counts)
 *   - agent_run_write_intents (dry-run only)
 *
 * Returns null if the run does not exist.
 */
export function buildPhaseAudit(runId: string): PhaseAudit | null {
  const run = getRun(runId);
  if (!run) return null;

  // `toRunRow` coerces dry_run to a real boolean (see db/queries/runs.ts)
  // — no need to defend against integer leakage at this call site.
  const dryRun = run.dry_run;

  // --- Parse stored JSON blobs ---
  const usageData = parseUsageData(run.usage_data);
  const checkpointState = parseCheckpointState(run.checkpoints);

  // Build a lookup from phase name → stored usage entry.
  const usageByName = new Map<string, StoredPhaseUsage>(
    (usageData.phases ?? []).map((p) => [p.name, p]),
  );

  // Build a lookup from phase name → checkpoint entry. The canonical
  // `parseCheckpointState` returns richer typings (PhaseCheckpoint) than
  // this module needs, but the fields we read (name/status/summary/
  // turnsUsed/tokensUsed/costUsd/costSource/updatedAt) are all present
  // and compatible with the loose-typed view used below.
  const checkpointByName = new Map(
    Object.entries(checkpointState.phases).map(([key, cp]) => [
      cp.name ?? key,
      cp,
    ]),
  );

  // Determine the union of phase names from both sources (preserving order).
  const phaseNames: string[] = [];
  const seen = new Set<string>();
  for (const p of usageData.phases ?? []) {
    if (!seen.has(p.name)) { phaseNames.push(p.name); seen.add(p.name); }
  }
  for (const name of checkpointByName.keys()) {
    if (!seen.has(name)) { phaseNames.push(name); seen.add(name); }
  }

  // --- Load supporting tables ---
  const reports = listReports(runId);
  const turns = listTurnsByRun(runId);
  const [toolCalls, toolErrors] = aggregateTurnCounts(turns);
  const serializedReports = serializeReports(reports);

  // Write intents (only loaded for dry runs)
  let intentSummary: WriteIntentSummary | null = null;
  if (dryRun) {
    const intents = listWriteIntents(runId);
    intentSummary = aggregateWriteIntents(intents);
  }

  // --- Synthetic single-phase fallback for non-phased tasks ---
  //
  // Tasks like `extract-only` have no phase checkpoints. Rather than returning
  // an empty phases array (which leaves the UI audit section useless), we
  // synthesize one entry named 'run' representing the whole run. Attribution
  // degrades gracefully: tool calls are already run-level aggregates, write
  // intents with null phase_id contribute to the total (and show up in the
  // synthetic phase's byTool map), and reports are attached as normal.
  if (phaseNames.length === 0 && turns.length > 0) {
    const runStatus = normalizeStatus(run.status);
    const durationMs = runDurationMs(run);

    // For non-phased runs, the whole-run write-intent summary is the sum of
    // all intents (attributed + unattributed). We rebuild byTool from the
    // full intent list rather than the phase-bucketed version because
    // null-phase intents are not represented in `byPhase`.
    let writeIntents: PhaseAuditEntry['writeIntents'] = null;
    if (intentSummary) {
      writeIntents = {
        total: intentSummary.total,
        byTool: intentSummary.totalByTool,
      };
    }

    // Prefer run.error when the run failed and no summary is otherwise
    // available. Not persisted as part of usage_data for non-phased tasks.
    const summary = run.status === 'failed' ? (run.error ?? null) : null;

    return {
      runId,
      taskName: run.task ?? null,
      dryRun,
      phases: [
        {
          phaseName: 'run',
          status: runStatus,
          summary,
          turnsUsed: turns.length,
          maxTurns: null,
          tokensUsed: run.tokens_used ?? 0,
          costUsd: run.cost_usd ?? null,
          costSource: run.cost_source ?? null,
          durationMs,
          startedAt: run.started_at,
          completedAt: run.completed_at,
          skipReason: null,
          toolCalls,
          toolErrors,
          writeIntents,
          reports: serializedReports,
        },
      ],
    };
  }

  // --- Build per-phase entries ---
  const phases: PhaseAuditEntry[] = phaseNames.map((phaseName) => {
    const usage = usageByName.get(phaseName);
    const cp = checkpointByName.get(phaseName);

    // Prefer checkpoint for status/summary/turnsUsed (more authoritative).
    const status = normalizeStatus(cp?.status ?? (usage ? 'pending' : 'pending'));

    const tokensUsed =
      cp?.tokensUsed ??
      usage?.tokensUsed ??
      usage?.usage?.totalTokens ??
      0;

    const costUsd =
      cp?.costUsd !== undefined
        ? cp.costUsd
        : usage?.costUsd !== undefined
          ? usage.costUsd
          : null;

    const costSource = cp?.costSource ?? usage?.costSource ?? null;

    const durationMs = usage?.usage?.durationMs ?? null;

    // checkpoints store updatedAt (phase completed/failed timestamp).
    // There is no startedAt in the checkpoint — it only records the last
    // updated time. We expose completedAt from updatedAt for completed/failed
    // phases, and startedAt as null (not persisted).
    const completedAt = (status === 'completed' || status === 'failed')
      ? (cp?.updatedAt ?? null)
      : null;
    const startedAt: number | null = null;

    const skipReason: string | null = null; // Not persisted in current schema

    // Write intents for this phase (null when not a dry run)
    let writeIntents: PhaseAuditEntry['writeIntents'] = null;
    if (intentSummary) {
      const phaseByTool = intentSummary.byPhase[phaseName] ?? {};
      writeIntents = {
        // Phase total = sum of tool calls attributed to this phase
        total: Object.values(phaseByTool).reduce((sum, n) => sum + n, 0),
        byTool: phaseByTool,
      };
    }

    return {
      phaseName,
      status,
      summary: cp?.summary ?? null,
      turnsUsed: cp?.turnsUsed ?? 0,
      maxTurns: null, // Not persisted — see module JSDoc
      tokensUsed,
      costUsd,
      costSource,
      durationMs,
      startedAt,
      completedAt,
      skipReason,
      toolCalls, // run-level aggregate (no per-phase turn attribution)
      toolErrors, // always empty — no error flag on turn rows
      writeIntents,
      reports: serializedReports, // all reports; no phase column exists
    };
  });

  return {
    runId,
    taskName: run.task ?? null,
    dryRun,
    phases,
  };
}
