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
import { listWriteIntents, countWriteIntentsByTool } from '@myco/db/queries/write-intents.js';
import { runDurationMs } from '@myco/agent/run-accounting.js';
import { buildTaskInstruction, isInstructionRequiredTask } from '@myco/agent/instruction-builders.js';
import { hasConfiguredProvider } from '@myco/agent/config-resolver.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { notify } from '@myco/notifications/notify.js';
import { buildPhaseAudit } from '@myco/services/phase-audit.js';
import { ExecutionOverrideBody } from './schemas/execution-overrides.js';
import { serializeRun } from './run-serializer.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';
import type { TeamSyncClient } from '../team-sync.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default limit for listing agent runs in the API. */
export const AGENT_RUNS_DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Per-run execution overrides. Clients (eval CLI, RunTaskDialog, etc.) use
 * these to pin runtime/provider/reasoning/model/phase-config without touching
 * the task YAML. Shape mirrors `RunOptions.executionOverrides` in
 * `@myco/agent/types.ts`. The canonical zod schemas live in
 * `./schemas/execution-overrides.ts` and are reused by the evaluation
 * handler — keep changes in the shared module.
 */

const AgentRunBody = z.object({
  task: z.string().optional(),
  instruction: z.string().optional(),
  agentId: z.string().optional(),
  /**
   * Run in dry-run mode — writes intercepted by the tool surface and
   * recorded to `agent_run_write_intents` instead of mutating the vault.
   */
  dryRun: z.boolean().optional(),
  /** Evaluation matrix this run belongs to, if any. */
  evaluationId: z.string().nullable().optional(),
  /** Per-run runtime/reasoning/model overrides; also per-phase overrides. */
  executionOverrides: ExecutionOverrideBody,
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
  getTeamClient?: () => TeamSyncClient | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentRunHandlers(deps: AgentRunDeps) {
  const { vaultDir, embeddingManager, logger, getTeamClient } = deps;

  /** POST /api/agent/run — trigger an agent run. */
  async function handleRun(req: RouteRequest): Promise<RouteResponse> {
    const {
      task,
      instruction: rawInstruction,
      agentId,
      dryRun,
      evaluationId,
      executionOverrides,
    } = AgentRunBody.parse(req.body);

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
    let runContext: {
      candidate_id?: string;
      cortex_instruction_input_hash?: string;
    } | undefined;
    if (task && !instruction) {
      let built;
      try {
        const taskParams = mycoConfig.agent.tasks?.[task]?.params;
        const projectRoot = resolve(vaultDir, '..');
        built = await buildTaskInstruction(task, taskParams, agentId, projectRoot, embeddingManager, mycoConfig, getTeamClient);
      } catch {
        const projectRoot = resolve(vaultDir, '..');
        built = await buildTaskInstruction(task, undefined, agentId, projectRoot, embeddingManager, mycoConfig, getTeamClient);
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
      dryRun,
      evaluationId,
      executionOverrides,
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

    return { body: { runs: runs.map((run) => serializeRun(run)), total, offset, limit } };
  }

  /**
   * GET /api/agent/runs/:id — get a single run.
   *
   * Emits the same richer shape the evaluation-detail handler uses
   * (`write_intents` + `duration_ms`) so the Comparisons UI can render an
   * ad-hoc comparison over arbitrary runs by fetching them in parallel
   * through this endpoint.
   */
  async function handleGetRun(req: RouteRequest): Promise<RouteResponse> {
    const run = getRun(req.params.id);
    if (!run) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    const byTool = countWriteIntentsByTool(run.id);
    const total = Object.values(byTool).reduce((acc, n) => acc + n, 0);
    return {
      body: {
        run: serializeRun(run, {
          writeIntents: { total, by_tool: byTool },
          duration_ms: runDurationMs(run),
        }),
      },
    };
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

  /**
   * GET /api/agent/runs/:id/write-intents — list the writes a dry-run agent
   * would have performed. Parsed JSON is returned in `tool_input` and
   * `synthetic_output` (see write-intents query helper).
   */
  async function handleGetRunWriteIntents(req: RouteRequest): Promise<RouteResponse> {
    const intents = listWriteIntents(req.params.id);
    return { body: { intents, count: intents.length } };
  }

  /**
   * GET /api/agent/runs/:id/audit
   *
   * Returns a joined per-phase audit view over agent_runs, agent_reports,
   * agent_turns, usage_data JSON, checkpoints JSON, and (for dry runs)
   * agent_run_write_intents. No writes are performed.
   */
  async function handleGetRunAudit(req: RouteRequest): Promise<RouteResponse> {
    const audit = buildPhaseAudit(req.params.id);
    if (!audit) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    return { body: { audit } };
  }

  return {
    handleRun,
    handleListRuns,
    handleGetRun,
    handleResumeRun,
    handleGetRunReports,
    handleGetRunTurns,
    handleGetRunWriteIntents,
    handleGetRunAudit,
  };
}
