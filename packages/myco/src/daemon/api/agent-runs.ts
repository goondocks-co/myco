/**
 * Agent run API handlers — trigger runs, list runs, and fetch run details.
 *
 * Factory function injects vaultDir and embeddingManager; returns handlers
 * for the /api/agent/run and /api/agent/runs/* endpoints.
 */

import { z } from 'zod';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { listRuns, countRuns, getRun, getLatestRunId } from '@myco/db/queries/runs.js';
import { getRunActivityBuckets, getRunBranches } from '@myco/db/queries/activity-buckets.js';
import { listReports } from '@myco/db/queries/reports.js';
import { listTurnsByRun } from '@myco/db/queries/turns.js';
import { listWriteIntents, countWriteIntents, countWriteIntentsByTool } from '@myco/db/queries/write-intents.js';
import { runDurationMs } from '@myco/agent/run-accounting.js';
import { buildTaskInstruction, isInstructionRequiredTask } from '@myco/agent/instruction-builders.js';
import { hasConfiguredProvider } from '@myco/agent/config-resolver.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { notify } from '@myco/notifications/notify.js';
import { buildPhaseAudit } from '@myco/services/phase-audit.js';
import { ExecutionOverrideBody } from './schemas/execution-overrides.js';
import { transformProviderOverrides } from './schemas/execution-overrides-traversal.js';
import { serializeRun } from './run-serializer.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';
import type { TeamSyncClient } from '../team-sync.js';
import { projectScopeFromRequestContext } from '@myco/tools/request-context.js';

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
 * these to pin harness/provider/reasoning/model/phase-config without touching
 * the task YAML. Shape mirrors `RunOptions.executionOverrides` in
 * `@myco/agent/types.ts`. The canonical zod schemas live in
 * `./schemas/execution-overrides.ts` and are reused by the evaluation
 * handler — keep changes in the shared module.
 */

/**
 * Strip caller-supplied `baseUrl` from remote-provider overrides so the
 * daemon's stored OpenAI/OpenRouter key can never be sent to an
 * attacker-controlled host. Local providers (ollama, lmstudio,
 * openai-compatible) legitimately need custom base URLs.
 */
const REMOTE_PROVIDER_TYPES = new Set(['openai', 'openrouter']);

function stripBaseUrlForRemoteProviders(
  provider: Record<string, unknown>,
): Record<string, unknown> {
  const type = provider.type;
  if (typeof type === 'string' && REMOTE_PROVIDER_TYPES.has(type)) {
    const { baseUrl: _dropped, ...rest } = provider;
    return rest;
  }
  return provider;
}

function sanitizeExecutionOverrides(
  overrides: z.infer<typeof ExecutionOverrideBody>,
): z.infer<typeof ExecutionOverrideBody> {
  if (!overrides) return overrides;
  // Delegates structural traversal (top-level provider + phases) to the
  // shared helper so adding future override fields is a one-line change
  // per transform, not a parallel rewrite here and in run-serializer.
  const result = transformProviderOverrides(
    overrides as unknown as Record<string, unknown>,
    stripBaseUrlForRemoteProviders,
  );
  return result as unknown as z.infer<typeof ExecutionOverrideBody>;
}

const AgentRunBody = z.object({
  task: z.string().optional(),
  instruction: z.string().optional(),
  agentId: z.string().optional(),
  /**
   * Run in dry-run mode — writes intercepted by the tool surface and
   * recorded to `agent_run_write_intents` instead of mutating the vault.
   */
  dryRun: z.boolean().optional(),
  /** Per-run harness/reasoning/model overrides; also per-phase overrides. */
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
    const parsedBody = AgentRunBody.safeParse(req.body);
    if (!parsedBody.success) {
      return {
        status: 400,
        body: {
          ok: false,
          error: parsedBody.error.message,
        },
      };
    }

    const {
      task,
      instruction: rawInstruction,
      agentId,
      dryRun,
      executionOverrides: rawExecutionOverrides,
    } = parsedBody.data;
    const scope = projectScopeFromRequestContext(req.requestContext);

    // SSRF defense: strip caller-supplied baseUrl from any remote-provider
    // override. The daemon's bearer key cannot follow a redirected URL.
    const executionOverrides = sanitizeExecutionOverrides(rawExecutionOverrides);

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
        const projectRoot = req.requestContext?.projectRoot ?? resolveProjectRoot(vaultDir);
        built = await buildTaskInstruction(task, taskParams, agentId, projectRoot, embeddingManager, mycoConfig, getTeamClient, req.requestContext);
      } catch {
        const projectRoot = req.requestContext?.projectRoot ?? resolveProjectRoot(vaultDir);
        built = await buildTaskInstruction(task, undefined, agentId, projectRoot, embeddingManager, mycoConfig, getTeamClient, req.requestContext);
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

    const { dispatchAgentRun } = await import('@myco/agent/runner-host.js');
    const resultPromise = dispatchAgentRun(vaultDir, {
      task,
      instruction,
      agentId,
      embeddingManager,
      requestContext: req.requestContext,
      runContext,
      dryRun,
      executionOverrides,
      logger,
    });

    // runAgent inserts the run row synchronously before the first await.
    // Query for the most recently created run matching this task to get
    // the correct ID — not getRunningRun which may return a different task.
    const effectiveAgentId = agentId ?? 'myco-agent';
    const runId = getLatestRunId(effectiveAgentId, task, scope);

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
    const scope = projectScopeFromRequestContext(req.requestContext);

    const filterOpts = { scope, agent_id: agentId, status, task, search };
    const runs = listRuns({ ...filterOpts, limit, offset });
    const total = countRuns(filterOpts);
    const runIds = runs.map((r) => r.id);
    const activityBuckets = getRunActivityBuckets(runIds);
    const branches = getRunBranches(runIds);

    return {
      body: {
        runs: runs.map((run) => serializeRun(run, {
          logger,
          activityBuckets: activityBuckets.get(run.id) ?? [],
          branch: branches.get(run.id) ?? null,
        })),
        total,
        offset,
        limit,
      },
    };
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
    const scope = projectScopeFromRequestContext(req.requestContext);
    const run = getRun(req.params.id, scope);
    if (!run) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    const byTool = countWriteIntentsByTool(run.id, scope);
    const total = Object.values(byTool).reduce((acc, n) => acc + n, 0);
    const activityBuckets = getRunActivityBuckets([run.id]);
    const branches = getRunBranches([run.id]);
    return {
      body: {
        run: serializeRun(run, {
          writeIntents: { total, by_tool: byTool },
          duration_ms: runDurationMs(run),
          logger,
          activityBuckets: activityBuckets.get(run.id) ?? [],
          branch: branches.get(run.id) ?? null,
        }),
      },
    };
  }

  /** POST /api/agent/runs/:id/resume — resume a failed/interrupted run. */
  async function handleResumeRun(req: RouteRequest): Promise<RouteResponse> {
    const scope = projectScopeFromRequestContext(req.requestContext);
    const run = getRun(req.params.id, scope);
    if (!run) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    if (run.resumable !== 1 || run.status !== 'failed') {
      return { status: 400, body: { error: 'Run is not resumable' } };
    }

    const { mode } = ResumeRunBody.parse(req.body ?? {});
    const { dispatchAgentRun } = await import('@myco/agent/runner-host.js');
    const resultPromise = dispatchAgentRun(vaultDir, {
      agentId: run.agent_id,
      task: run.task ?? undefined,
      instruction: run.instruction ?? undefined,
      dryRun: run.dry_run,
      resumeRunId: run.id,
      resumeMode: mode ?? 'manual',
      embeddingManager,
      requestContext: req.requestContext,
      logger,
    });

    resultPromise
      .then((result) => {
        logger.info(LOG_KINDS.AGENT_RUN, 'Agent run resumed', {
          runId: result.runId,
          status: result.status,
          harness: result.harness,
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
    const scope = projectScopeFromRequestContext(req.requestContext);
    if (!getRun(req.params.id, scope)) return { status: 404, body: { error: 'Run not found' } };
    const reports = listReports(req.params.id, { scope });
    return { body: { reports } };
  }

  /** GET /api/agent/runs/:id/turns — list turns for a run. */
  async function handleGetRunTurns(req: RouteRequest): Promise<RouteResponse> {
    const scope = projectScopeFromRequestContext(req.requestContext);
    if (!getRun(req.params.id, scope)) return { status: 404, body: { error: 'Run not found' } };
    const turns = listTurnsByRun(req.params.id, { scope });
    return { body: turns };
  }

  /**
   * GET /api/agent/runs/:id/write-intents — list the writes a dry-run agent
   * would have performed. Parsed JSON is returned in `tool_input` and
   * `synthetic_output` (see write-intents query helper).
   */
  async function handleGetRunWriteIntents(req: RouteRequest): Promise<RouteResponse> {
    const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
    const rawOffset = req.query.offset ? Number(req.query.offset) : undefined;
    const limit = Number.isFinite(rawLimit) && rawLimit !== undefined && rawLimit > 0
      ? Math.min(rawLimit, 5000)
      : 500;
    const offset = Number.isFinite(rawOffset) && rawOffset !== undefined && rawOffset >= 0
      ? rawOffset
      : 0;
    const scope = projectScopeFromRequestContext(req.requestContext);
    if (!getRun(req.params.id, scope)) return { status: 404, body: { error: 'Run not found' } };
    const intents = listWriteIntents(req.params.id, { limit, offset, scope });
    const total = countWriteIntents(req.params.id, scope);
    return { body: { intents, count: intents.length, total } };
  }

  /**
   * GET /api/agent/runs/:id/audit
   *
   * Returns a joined per-phase audit view over agent_runs, agent_reports,
   * agent_turns, usage_data JSON, checkpoints JSON, and (for dry runs)
   * agent_run_write_intents. No writes are performed.
   */
  async function handleGetRunAudit(req: RouteRequest): Promise<RouteResponse> {
    const scope = projectScopeFromRequestContext(req.requestContext);
    const audit = buildPhaseAudit(req.params.id, scope);
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
