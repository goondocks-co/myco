/**
 * Shared serializer for agent_runs rows exposed via API.
 *
 * The list/detail handlers in `agent-runs.ts` and the evaluation detail
 * handler in `agent-evaluations.ts` both need to turn a `RunRow` into a
 * JSON-safe payload. This module centralizes that logic so both call sites
 * agree on field naming, optional field inclusion, and the embedded
 * phase-checkpoint projection.
 */

import type { RunRow } from '@myco/db/queries/runs.js';
import type { DaemonLogger } from '../logger.js';
import { transformProviderOverrides } from './schemas/execution-overrides-traversal.js';

export interface PhaseCheckpointSummary {
  name: string;
  status: string;
  updatedAt: number;
  tokensUsed?: number;
  costUsd?: number;
  costSource?: string;
}

/**
 * Parse the run's `checkpoints` JSON blob and project a flat list of
 * phase summaries. Corruption degrades to an empty array.
 */
export function buildPhaseCheckpointSummary(
  checkpointsRaw: string | null,
  logger?: DaemonLogger,
): PhaseCheckpointSummary[] {
  if (!checkpointsRaw) return [];
  try {
    const parsed = JSON.parse(checkpointsRaw) as {
      phases?: Record<string, {
        name?: string;
        status?: string;
        updatedAt?: number;
        tokensUsed?: number;
        costUsd?: number;
        costSource?: string;
      }>;
    };
    return Object.entries(parsed.phases ?? {}).map(([name, phase]) => ({
      name: phase.name ?? name,
      status: phase.status ?? 'pending',
      updatedAt: phase.updatedAt ?? 0,
      ...(phase.tokensUsed !== undefined ? { tokensUsed: phase.tokensUsed } : {}),
      ...(phase.costUsd !== undefined ? { costUsd: phase.costUsd } : {}),
      ...(phase.costSource !== undefined ? { costSource: phase.costSource } : {}),
    }));
  } catch (err) {
    // Corrupt checkpoints JSON — degrade to an empty phase list so the run
    // detail still renders, but surface the parse error so an operator can
    // distinguish "no phases yet" from "blob was truncated mid-write".
    const detail = err instanceof Error ? err.message : String(err);
    logger?.warn('run-serializer.checkpoints-parse-failed', 'checkpoints JSON parse failed', { error: detail });
    return [];
  }
}

// TODO(post-v0.22): remove once no historical agent_runs rows predate the apiKey drop in v0.21. See docs/superpowers/plans/2026-04-18-pre-0.21.0-quality-pass.md Bundle A.
/**
 * Defensive mask for historical execution_overrides rows. Removes any
 * `apiKey` field nested under `provider` (top-level or per-phase) so the
 * stored overrides column cannot echo a pre-patch secret back to the UI.
 *
 * Top-level `apiKey` — if a legacy row somehow stored one — is also
 * stripped as belt-and-braces defense.
 *
 * Structural traversal is delegated to `transformProviderOverrides`; this
 * function only encodes the per-provider transform (delete apiKey).
 */
function scrubExecutionOverrides(
  overrides: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!overrides || typeof overrides !== 'object') return overrides;
  const topLevelStripped: Record<string, unknown> = { ...overrides };
  if ('apiKey' in topLevelStripped) delete topLevelStripped.apiKey;
  return transformProviderOverrides(topLevelStripped, stripApiKey);
}

function stripApiKey(provider: Record<string, unknown>): Record<string, unknown> {
  const cloned = { ...provider };
  if ('apiKey' in cloned) delete cloned.apiKey;
  return cloned;
}

export interface SerializeRunOptions {
  /** Include resume-related fields (resumable/resume_status/resume_mode/resumed_at). Default true. */
  includeResumeFields?: boolean;
  /** Include the embedded `phase_checkpoints` projection. Default true. */
  includePhaseCheckpoints?: boolean;
  /**
   * Per-tool write-intent summary to embed as `write_intents`. Pass `null`
   * (or omit entirely) to skip the field — evaluation child rows populate
   * it, plain run list rows do not.
   */
  writeIntents?: { total: number; by_tool: Record<string, number> } | null;
  /**
   * Duration (milliseconds) to embed as `duration_ms`. Omit entirely to
   * skip; evaluation child rows attach it, plain run rows do not.
   */
  duration_ms?: number | null;
  /**
   * Daemon logger — when provided, checkpoint JSON corruption is logged
   * through it instead of being swallowed. Optional so MCP / test call
   * sites that don't have a logger can still serialize rows.
   */
  logger?: DaemonLogger;
}

/**
 * Serialize a run row to the shape expected by all API consumers. Options
 * toggle the resume/checkpoint fields that only the primary runs endpoint
 * needs, and add the evaluation-only `write_intents` / `duration_ms`
 * fields on demand.
 */
export function serializeRun(run: RunRow, opts: SerializeRunOptions = {}) {
  const {
    includeResumeFields = true,
    includePhaseCheckpoints = true,
    writeIntents,
    duration_ms,
    logger,
  } = opts;

  const base = {
    id: run.id,
    agent_id: run.agent_id,
    task: run.task,
    instruction: run.instruction,
    status: run.status,
    runtime: run.runtime,
    provider: run.provider,
    model: run.model,
    session_ref: run.session_ref,
    started_at: run.started_at,
    completed_at: run.completed_at,
    tokens_used: run.tokens_used,
    cost_usd: run.cost_usd,
    actual_cost_usd: run.actual_cost_usd,
    estimated_cost_usd: run.estimated_cost_usd,
    cost_source: run.cost_source,
    cost_data: run.cost_data,
    actions_taken: run.actions_taken,
    usage_data: run.usage_data,
    error: run.error,
    dry_run: run.dry_run,
    evaluation_id: run.evaluation_id,
    reasoning_level: run.reasoning_level,
    // Strip `apiKey` from historical rows defensively — before this PR the
    // API accepted apiKey in executionOverrides and stored it unmasked.
    execution_overrides: scrubExecutionOverrides(run.execution_overrides),
  };

  return {
    ...base,
    ...(includeResumeFields
      ? {
          resumable: run.resumable === 1,
          resume_status: run.resume_status,
          resume_mode: run.resume_mode,
          resumed_at: run.resumed_at,
          checkpoints: run.checkpoints,
        }
      : {}),
    ...(includePhaseCheckpoints
      ? { phase_checkpoints: buildPhaseCheckpointSummary(run.checkpoints, logger) }
      : {}),
    ...(writeIntents !== undefined && writeIntents !== null
      ? { write_intents: writeIntents }
      : {}),
    ...(duration_ms !== undefined ? { duration_ms } : {}),
  };
}
