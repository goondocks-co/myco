/**
 * Agent evaluation (matrix) API handlers — create, list, and fetch
 * evaluations. An evaluation fans out a single task across a cartesian
 * product of (runtime × reasoning × model) cells so we can compare
 * outputs side-by-side.
 *
 * Cells execute sequentially in a fire-and-forget background task; the
 * POST responds immediately with the evaluation id + cell count.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { epochSeconds } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import {
  insertEvaluation,
  getEvaluation,
  listEvaluations,
  updateEvaluationStatus,
  EVAL_STATUS_COMPLETED,
  EVAL_STATUS_FAILED,
  EVAL_STATUS_RUNNING,
} from '@myco/db/queries/evaluations.js';
import { listRunsForEvaluation } from '@myco/db/queries/runs.js';
import { countWriteIntentsByToolForEvaluation } from '@myco/db/queries/write-intents.js';
import { enumerateMatrixCells } from '@myco/agent/evaluation-matrix.js';
import { runDurationMs } from '@myco/agent/run-accounting.js';
import {
  ReasoningLevelEnum,
  RuntimeIdEnum,
  PhaseExecutionOverrideBody,
} from './schemas/execution-overrides.js';
import { serializeRun } from './run-serializer.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';
import type { RunOptions } from '@myco/agent/types.js';
import type { RunRow } from '@myco/db/queries/runs.js';

// Re-export for backward compatibility — tests and external consumers
// imported `enumerateMatrixCells` from this module before the helper
// moved to `@myco/agent/evaluation-matrix.ts`.
export { enumerateMatrixCells };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateEvaluationBody = z.object({
  taskId: z.string(),
  matrix: z.object({
    runtimes: z.array(RuntimeIdEnum).optional(),
    reasoningLevels: z.array(ReasoningLevelEnum).optional(),
    models: z.array(z.string()).optional(),
    dryRun: z.boolean().optional(),
    notes: z.string().optional(),
    /**
     * Phase-level overrides applied to EVERY cell in the matrix. The matrix
     * dimensions (runtimes / reasoningLevels / models) vary the top-level
     * execution per cell; phase overrides here let you pin specific phases
     * to fixed reasoning/model/provider/maxTurns regardless of what the cell
     * is varying at the top level.
     *
     * Merged into each cell's `executionOverrides.phases` before runAgent
     * is invoked. Unknown phase names are ignored by the executor (a
     * one-shot warning is logged at run startup).
     */
    phases: z.record(z.string(), PhaseExecutionOverrideBody).optional(),
  }),
  notes: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentEvaluationDeps {
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shape returned by the GET /:id aggregate. */
interface Aggregate {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  totalTokens: number;
  totalCostUsd: number;
}

function aggregateRuns(runs: RunRow[]): Aggregate {
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const run of runs) {
    if (run.status === 'completed') completed++;
    else if (run.status === 'failed') failed++;
    else if (run.status === 'skipped') skipped++;
    totalTokens += run.tokens_used ?? 0;
    totalCostUsd += run.cost_usd ?? 0;
  }
  return {
    total: runs.length,
    completed,
    failed,
    skipped,
    totalTokens,
    totalCostUsd,
  };
}

/**
 * Per-run write-intent summary attached to each evaluation child.
 * `total` is the sum of counts across every tool; `by_tool` is the raw map
 * returned by `countWriteIntentsByToolForEvaluation` (indexed by run id).
 * Non-dry-run children are serialized with `{ total: 0, by_tool: {} }` so
 * the UI doesn't need to special-case them.
 */
interface WriteIntentsSummary {
  total: number;
  by_tool: Record<string, number>;
}

function summarizeFromByTool(
  byTool: Record<string, number> | undefined,
): WriteIntentsSummary {
  const tools = byTool ?? {};
  let total = 0;
  for (const count of Object.values(tools)) total += count;
  return { total, by_tool: tools };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentEvaluationHandlers(deps: AgentEvaluationDeps) {
  const { vaultDir, embeddingManager, logger } = deps;

  /**
   * POST /api/agent/evaluations — create an evaluation and fan out one
   * run per matrix cell. Responds immediately with the evaluation id +
   * total cell count; cell execution runs in the background.
   */
  async function handleCreate(req: RouteRequest): Promise<RouteResponse> {
    const parsed = CreateEvaluationBody.safeParse(req.body);
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: 'Invalid request body', details: parsed.error.flatten() },
      };
    }
    const body = parsed.data;

    const cells = enumerateMatrixCells(body.matrix);
    if (cells.length === 0) {
      // enumerateMatrixCells guarantees at least one cell; this is defensive.
      return {
        status: 400,
        body: { error: 'Matrix produced zero cells' },
      };
    }

    const evalId = crypto.randomUUID();
    insertEvaluation({
      id: evalId,
      taskId: body.taskId,
      matrix: body.matrix,
      notes: body.notes ?? null,
    });

    const dryRun = body.matrix.dryRun ?? false;

    // Fire-and-forget cell execution. Cells run sequentially to reduce
    // flakiness (the plan explicitly avoids parallel execution). Per-cell
    // failures are logged but do not abort subsequent cells.
    void (async () => {
      const { runAgent } = await import('@myco/agent/executor.js');
      let anyCompleted = false;
      let transitionedToRunning = false;
      const sharedPhases = body.matrix.phases;
      for (const cell of cells) {
        const cellOptions: RunOptions = {
          task: body.taskId,
          evaluationId: evalId,
          dryRun,
          embeddingManager,
          logger,
          executionOverrides: {
            ...(cell.runtime ? { runtime: cell.runtime } : {}),
            ...(cell.reasoningLevel ? { reasoningLevel: cell.reasoningLevel } : {}),
            ...(cell.model ? { model: cell.model } : {}),
            ...(sharedPhases && Object.keys(sharedPhases).length > 0
              ? { phases: sharedPhases }
              : {}),
          },
        };
        // Flip pending → running exactly once, right before the first cell.
        // Consumers need this signal to distinguish "actively executing"
        // from "not yet started"; without it the status only changes at the
        // terminal transition.
        if (!transitionedToRunning) {
          updateEvaluationStatus(evalId, EVAL_STATUS_RUNNING);
          transitionedToRunning = true;
        }
        try {
          const result = await runAgent(vaultDir, cellOptions);
          if (result.status === 'completed') {
            anyCompleted = true;
          }
          logger.info(LOG_KINDS.AGENT_RUN, 'Evaluation cell finished', {
            evaluationId: evalId,
            runId: result.runId,
            status: result.status,
            runtime: cell.runtime,
            reasoningLevel: cell.reasoningLevel,
            model: cell.model,
          });
        } catch (err) {
          logger.error(LOG_KINDS.AGENT_ERROR, 'Evaluation cell threw', {
            evaluationId: evalId,
            runtime: cell.runtime,
            reasoningLevel: cell.reasoningLevel,
            model: cell.model,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const status = anyCompleted ? EVAL_STATUS_COMPLETED : EVAL_STATUS_FAILED;
      updateEvaluationStatus(evalId, status, epochSeconds());
      logger.info(LOG_KINDS.AGENT_RUN, 'Evaluation finished', {
        evaluationId: evalId,
        status,
        cellCount: cells.length,
      });
    })().catch((err) => {
      logger.error(LOG_KINDS.AGENT_ERROR, 'Evaluation fan-out failed', {
        evaluationId: evalId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { body: { evaluationId: evalId, cellCount: cells.length } };
  }

  /** GET /api/agent/evaluations/:id — evaluation + child runs + aggregate. */
  async function handleGet(req: RouteRequest): Promise<RouteResponse> {
    const evaluation = getEvaluation(req.params.id);
    if (!evaluation) {
      return { status: 404, body: { error: 'Evaluation not found' } };
    }
    const runs = listRunsForEvaluation(evaluation.id);
    // One JOIN'd aggregate query in place of N per-run COUNT queries.
    const writeIntentsByRun = countWriteIntentsByToolForEvaluation(evaluation.id);
    return {
      body: {
        evaluation: {
          id: evaluation.id,
          taskId: evaluation.task_id,
          matrix: evaluation.matrix,
          notes: evaluation.notes,
          status: evaluation.status,
          createdAt: evaluation.created_at,
          completedAt: evaluation.completed_at,
        },
        runs: runs.map((run) =>
          serializeRun(run, {
            includeResumeFields: false,
            includePhaseCheckpoints: false,
            writeIntents: summarizeFromByTool(writeIntentsByRun[run.id]),
            duration_ms: runDurationMs(run),
          }),
        ),
        aggregate: aggregateRuns(runs),
      },
    };
  }

  /** GET /api/agent/evaluations — newest-first list with pagination. */
  async function handleList(req: RouteRequest): Promise<RouteResponse> {
    const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIMIT;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const evaluations = listEvaluations({ limit, offset });
    return {
      body: {
        evaluations: evaluations.map((e) => ({
          id: e.id,
          taskId: e.task_id,
          matrix: e.matrix,
          notes: e.notes,
          status: e.status,
          createdAt: e.created_at,
          completedAt: e.completed_at,
        })),
        total: evaluations.length,
      },
    };
  }

  return { handleCreate, handleGet, handleList };
}
