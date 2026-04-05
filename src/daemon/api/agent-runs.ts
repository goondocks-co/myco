/**
 * Agent run API handlers — trigger runs, list runs, and fetch run details.
 *
 * Factory function injects vaultDir and embeddingManager; returns handlers
 * for the /api/agent/run and /api/agent/runs/* endpoints.
 */

import { z } from 'zod';
import { listRuns, countRuns, getRun, getLatestRunId } from '@myco/db/queries/runs.js';
import { listReports } from '@myco/db/queries/reports.js';
import { listTurnsByRun } from '@myco/db/queries/turns.js';
import { buildSkillGenerateInstruction, SKILL_GENERATE_TASK, buildSkillEvolveInstruction, SKILL_EVOLVE_TASK } from '@myco/agent/instruction-builders.js';
import { loadConfig } from '@myco/config/loader.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';

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

// Re-export for backward compatibility with existing import paths
export { buildSkillGenerateInstruction, SKILL_GENERATE_TASK, buildSkillEvolveInstruction, SKILL_EVOLVE_TASK } from '@myco/agent/instruction-builders.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunDeps {
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentRunHandlers(deps: AgentRunDeps) {
  const { vaultDir, embeddingManager, logger } = deps;

  /** POST /api/agent/run — trigger an agent run. */
  async function handleRun(req: RouteRequest): Promise<RouteResponse> {
    const { task, instruction: rawInstruction, agentId } = AgentRunBody.parse(req.body);

    // Instruction builders for tasks that need pre-assembled context.
    // Same structural enforcement as the scheduler.
    let instruction = rawInstruction;
    if (task === SKILL_GENERATE_TASK && !instruction) {
      instruction = buildSkillGenerateInstruction();
    } else if (task === SKILL_EVOLVE_TASK && !instruction) {
      try {
        const mycoConfig = loadConfig(vaultDir);
        const taskConfig = mycoConfig.agent.tasks?.[task];
        instruction = buildSkillEvolveInstruction(taskConfig?.params);
      } catch {
        instruction = buildSkillEvolveInstruction();
      }
    }

    const { runAgent } = await import('@myco/agent/executor.js');
    const resultPromise = runAgent(vaultDir, { task, instruction, agentId, embeddingManager });

    // runAgent inserts the run row synchronously before the first await.
    // Query for the most recently created run matching this task to get
    // the correct ID — not getRunningRun which may return a different task.
    const effectiveAgentId = agentId ?? 'myco-agent';
    const runId = getLatestRunId(effectiveAgentId, task);

    resultPromise
      .then((result) => {
        if (result.status === 'failed') {
          logger.error(LOG_KINDS.AGENT_ERROR, 'Agent run failed', {
            runId: result.runId,
            error: result.error ?? 'No error message',
            phases: result.phases?.map(p => `${p.name}:${p.status}`) ?? [],
          });
        } else {
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

    return { body: { runs, total, offset, limit } };
  }

  /** GET /api/agent/runs/:id — get a single run. */
  async function handleGetRun(req: RouteRequest): Promise<RouteResponse> {
    const run = getRun(req.params.id);
    if (!run) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    return { body: { run } };
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
    handleGetRunReports,
    handleGetRunTurns,
  };
}
