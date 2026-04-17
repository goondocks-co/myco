/**
 * Agent run API handlers — trigger runs, list runs, and fetch run details.
 *
 * Factory function injects vaultDir and embeddingManager; returns handlers
 * for the /api/agent/run and /api/agent/runs/* endpoints.
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { listRuns, countRuns, getRun, getLatestRunId } from '@myco/db/queries/runs.js';
import { listReports } from '@myco/db/queries/reports.js';
import { listTurnsByRun } from '@myco/db/queries/turns.js';
import { buildTaskInstruction, isInstructionRequiredTask } from '@myco/agent/instruction-builders.js';
import { hasConfiguredProvider } from '@myco/agent/config-resolver.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { notify } from '@myco/notifications/notify.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';
import type { RunRow } from '@myco/db/queries/runs.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default limit for listing agent runs in the API. */
export const AGENT_RUNS_DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AgentRunBody = z.object({
  task: z.string().optional(),
  instruction: z.string().optional(),
  agentId: z.string().optional(),
});

const ResumeRunBody = z.object({
  mode: z.enum(['manual', 'scheduled']).optional(),
});

// Re-export for backward compatibility
export { buildTaskInstruction, SKILL_GENERATE_TASK, SKILL_EVOLVE_TASK, SKILL_SURVEY_TASK } from '@myco/agent/instruction-builders.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunDeps {
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
}

interface PhaseCheckpointSummary {
  name: string;
  status: string;
  updatedAt: number;
  tokensUsed?: number;
  costUsd?: number;
  costSource?: string;
}

function buildPhaseCheckpointSummary(checkpointsRaw: string | null): PhaseCheckpointSummary[] {
  if (!checkpointsRaw) return [];
  try {
    const parsed = JSON.parse(checkpointsRaw) as {
      phases?: Record<string, { name?: string; status?: string; updatedAt?: number; tokensUsed?: number; costUsd?: number; costSource?: string }>;
    };
    return Object.entries(parsed.phases ?? {}).map(([name, phase]) => ({
      name: phase.name ?? name,
      status: phase.status ?? 'pending',
      updatedAt: phase.updatedAt ?? 0,
      ...(phase.tokensUsed !== undefined ? { tokensUsed: phase.tokensUsed } : {}),
      ...(phase.costUsd !== undefined ? { costUsd: phase.costUsd } : {}),
      ...(phase.costSource !== undefined ? { costSource: phase.costSource } : {}),
    }));
  } catch {
    return [];
  }
}

function serializeRun(run: RunRow) {
  return {
    id: run.id,
    agent_id: run.agent_id,
    task: run.task,
    instruction: run.instruction,
    status: run.status,
    runtime: run.runtime,
    provider: run.provider,
    model: run.model,
    session_ref: run.session_ref,
    resumable: run.resumable === 1,
    resume_status: run.resume_status,
    resume_mode: run.resume_mode,
    resumed_at: run.resumed_at,
    checkpoints: run.checkpoints,
    usage_data: run.usage_data,
    started_at: run.started_at,
    completed_at: run.completed_at,
    tokens_used: run.tokens_used,
    cost_usd: run.cost_usd,
    actual_cost_usd: run.actual_cost_usd,
    estimated_cost_usd: run.estimated_cost_usd,
    cost_source: run.cost_source,
    cost_data: run.cost_data,
    actions_taken: run.actions_taken,
    error: run.error,
    phase_checkpoints: buildPhaseCheckpointSummary(run.checkpoints),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentRunHandlers(deps: AgentRunDeps) {
  const { vaultDir, embeddingManager, logger } = deps;

  /** POST /api/agent/run — trigger an agent run. */
  async function handleRun(req: RouteRequest): Promise<RouteResponse> {
    const { task, instruction: rawInstruction, agentId } = AgentRunBody.parse(req.body);

    // Guard: ensure a provider is configured before allowing a run.
    // Uses the same per-task-over-global precedence as the executor's resolver.
    const mycoConfig = loadMergedConfig(vaultDir);
    if (!hasConfiguredProvider(mycoConfig, task)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'No agent provider configured. Configure one in Settings.',
        },
      };
    }

    let instruction = rawInstruction;
    let runContext: { candidate_id?: string } | undefined;
    if (task && !instruction) {
      let built;
      try {
        const taskParams = mycoConfig.agent.tasks?.[task]?.params;
        const projectRoot = resolve(vaultDir, '..');
        built = buildTaskInstruction(task, taskParams, agentId, projectRoot, embeddingManager);
      } catch {
        const projectRoot = resolve(vaultDir, '..');
        built = buildTaskInstruction(task, undefined, agentId, projectRoot, embeddingManager);
      }
      instruction = built?.instruction;
      runContext = built?.context;

      // Short-circuit: instruction-required tasks (skill-generate,
      // skill-evolve) must not run when there's no work to do. For a
      // manual trigger via the API, surface this as a 200 with a
      // skipped status rather than a failed run row — the caller
      // should see "nothing to do" as a valid outcome.
      if (task && isInstructionRequiredTask(task) && !built) {
        return {
          body: {
            ok: true,
            message: `Task ${task} skipped — no work to do`,
            status: 'skipped',
            reason: 'no-work',
          },
        };
      }
    }

    const { runAgent } = await import('@myco/agent/executor.js');
    const resultPromise = runAgent(vaultDir, {
      task,
      instruction,
      agentId,
      embeddingManager,
      runContext,
    });

    // runAgent inserts the run row synchronously before the first await.
    // Query for the most recently created run matching this task to get
    // the correct ID — not getRunningRun which may return a different task.
    const effectiveAgentId = agentId ?? 'myco-agent';
    const runId = getLatestRunId(effectiveAgentId, task);

    resultPromise
      .then((result) => {
        const taskName = task ?? 'agent run';
        if (result.status === 'failed') {
          notify(vaultDir, {
            domain: 'agents',
            type: 'agent.task.failure',
            title: `Task failed: ${taskName}`,
            message: result.error ?? 'Unknown error',
            link: `/agent?run=${result.runId}`,
            metadata: { taskName: task ?? null, runId: result.runId },
          }, mycoConfig);
          logger.error(LOG_KINDS.AGENT_ERROR, 'Agent run failed', {
            runId: result.runId,
            error: result.error ?? 'No error message',
            phases: result.phases?.map(p => `${p.name}:${p.status}`) ?? [],
          });
        } else {
          notify(vaultDir, {
            domain: 'agents',
            type: 'agent.task.success',
            title: `Task completed: ${taskName}`,
            link: `/agent?run=${result.runId}`,
            metadata: { taskName: task ?? null, runId: result.runId },
          }, mycoConfig);
          logger.info(LOG_KINDS.AGENT_RUN, 'Agent run completed', {
            runId: result.runId,
            status: result.status,
            phases: result.phases?.map(p => `${p.name}:${p.status}`) ?? [],
          });
        }
      })
      .catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'Agent run threw unhandled error', {
          error: (err as Error).message ?? String(err),
          stack: (err as Error).stack?.split('\n').slice(0, 3).join(' | '),
        });
      });

    return { body: { ok: true, message: 'Agent started', runId } };
  }

  /** GET /api/agent/runs — list runs with filtering. */
  async function handleListRuns(req: RouteRequest): Promise<RouteResponse> {
    const limit = req.query.limit ? Number(req.query.limit) : AGENT_RUNS_DEFAULT_LIMIT;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const agentId = req.query.agentId || undefined;
    const status = req.query.status || undefined;
    const task = req.query.task || undefined;
    const search = req.query.search || undefined;

    const filterOpts = { agent_id: agentId, status, task, search };
    const runs = listRuns({ ...filterOpts, limit, offset });
    const total = countRuns(filterOpts);

    return { body: { runs: runs.map(serializeRun), total, offset, limit } };
  }

  /** GET /api/agent/runs/:id — get a single run. */
  async function handleGetRun(req: RouteRequest): Promise<RouteResponse> {
    const run = getRun(req.params.id);
    if (!run) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    return { body: { run: serializeRun(run) } };
  }

  /** POST /api/agent/runs/:id/resume — resume a failed/interrupted run. */
  async function handleResumeRun(req: RouteRequest): Promise<RouteResponse> {
    const run = getRun(req.params.id);
    if (!run) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    if (run.resumable !== 1 || run.status !== 'failed') {
      return { status: 400, body: { error: 'Run is not resumable' } };
    }

    const { mode } = ResumeRunBody.parse(req.body ?? {});
    const { runAgent } = await import('@myco/agent/executor.js');
    const resultPromise = runAgent(vaultDir, {
      agentId: run.agent_id,
      task: run.task ?? undefined,
      instruction: run.instruction ?? undefined,
      resumeRunId: run.id,
      resumeMode: mode ?? 'manual',
      embeddingManager,
    });

    resultPromise
      .then((result) => {
        logger.info(LOG_KINDS.AGENT_RUN, 'Agent run resumed', {
          runId: result.runId,
          status: result.status,
          runtime: result.runtime,
          provider: result.provider,
          model: result.model,
        });
      })
      .catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'Agent run resume threw unhandled error', {
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return { body: { ok: true, message: 'Agent resume started', runId: run.id } };
  }

  /** GET /api/agent/runs/:id/reports — list reports for a run. */
  async function handleGetRunReports(req: RouteRequest): Promise<RouteResponse> {
    const reports = listReports(req.params.id);
    return { body: { reports } };
  }

  /** GET /api/agent/runs/:id/turns — list turns for a run. */
  async function handleGetRunTurns(req: RouteRequest): Promise<RouteResponse> {
    const turns = listTurnsByRun(req.params.id);
    return { body: turns };
  }

  return {
    handleRun,
    handleListRuns,
    handleGetRun,
    handleResumeRun,
    handleGetRunReports,
    handleGetRunTurns,
  };
}
