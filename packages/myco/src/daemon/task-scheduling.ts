/**
 * Dynamic task scheduling registration.
 *
 * Extracted from main.ts — loads task definitions, seeds last-run times
 * from the database, builds the ScheduledJobContext (pre-conditions,
 * runTask with notifications), and registers scheduled jobs with the
 * PowerManager.
 */

import { resolveProjectRoot } from '@myco/vault/resolve.js';
import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from './power.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { ScheduledJobContext, ScheduledJobKicker } from './task-scheduler.js';
import { buildScheduledJobs } from './task-scheduler.js';
import {
  buildTaskInstruction,
  getSkillSurveyEligibility,
  isInstructionRequiredTask,
  SKILL_SURVEY_TASK,
} from '@myco/agent/instruction-builders.js';
import { countSkillRecords } from '@myco/db/queries/skill-records.js';
import { countCandidates } from '@myco/db/queries/skill-candidates.js';
import { countPendingCanopyDescribe } from '@myco/db/queries/canopy.js';
import { countUnprocessedSettledBatches } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';
import { resolveCanopyProjectId } from '@myco/canopy/identity.js';
import { getLatestResumableRunForTask } from '@myco/db/queries/runs.js';
import { notify } from '@myco/notifications/notify.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';

const SCHEDULED_JOB_PREFIX = 'scheduled:';

// Tasks whose pending queue is fully derivable from durable state — for
// these, "resume the failed run" is not a useful concept: a fresh run
// would do the same work as a resumed one, and the resume path collapses
// every scheduled tick onto a single agent_runs row (executor.ts:264
// skips insertRun when resuming), erasing failure history and making the
// task impossible to tune. Opt them out of getLatestResumableRunForTask
// so each scheduled fire inserts a new row.
// canopy-map: each scheduled fire reuses the inputs_hash short-circuit in
// buildCanopyMapInstruction. Resuming a failed run would replay the LLM phase
// against potentially stale inputs and erase the failure history we use to
// tune turn budgets. Re-fire with a fresh agent_runs row instead.
const NON_RESUMABLE_SCHEDULED_TASKS = new Set<string>(['canopy-describe', 'canopy-map']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskSchedulingDeps {
  definitionsDir: string | undefined;
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
  // Holder so the run-time gate below sees toggle flips
  // (agent.scheduled_tasks_enabled) without a daemon restart.
  liveConfig: { current: MycoConfig };
  getTeamClient?: () => import('./team-sync.js').TeamSyncClient | null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerScheduledTasks(
  powerManager: PowerManager,
  deps: TaskSchedulingDeps,
): Promise<ScheduledJobKicker> {
  const { definitionsDir, vaultDir, embeddingManager, logger, liveConfig, getTeamClient } = deps;
  const runningTasks = new Set<string>();

  if (!definitionsDir) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Skipping dynamic task scheduling — definitions directory unavailable');
    // Return a no-op kicker so callers can wire the same shape regardless
    // of whether scheduling actually started.
    return { kick: () => {} };
  }

  // Jobs always register. The scheduled_tasks_enabled gate lives inside
  // runTask so flipping the toggle in Settings takes effect immediately —
  // registration-time gating would lock the scheduler to its startup value.
  let lastEnabled = liveConfig.current.agent.scheduled_tasks_enabled !== false;
  if (!lastEnabled) {
    logger.info(LOG_KINDS.AGENT_RUN, 'Scheduled agent tasks disabled (agent.scheduled_tasks_enabled: false) — jobs registered but will no-op until enabled');
  }

  const { loadAllTasks } = await import('@myco/agent/registry.js');
  const allTasks = Array.from(loadAllTasks(definitionsDir, vaultDir).values());

  // Map task name → agent id for instruction builders that need it
  const taskAgentMap = new Map<string, string>();
  for (const task of allTasks) {
    taskAgentMap.set(task.name, task.agent);
  }

  // Seed lastRun from DB: find the most recent completed/failed run per task
  const initialLastRuns: Record<string, number> = {};
  try {
    const recentRuns = getDatabase().prepare(
      `SELECT task, MAX(completed_at) as last_completed
       FROM agent_runs
       WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL
       GROUP BY task`
    ).all() as Array<{ task: string; last_completed: number }>;
    for (const row of recentRuns) {
      initialLastRuns[row.task] = row.last_completed * 1000; // epoch seconds → ms
    }
  } catch {
    // Best-effort seeding
  }

  const scheduledContext: ScheduledJobContext = {
    isTaskRunning: (name) => runningTasks.has(name),
    setTaskRunning: (name, running) => {
      if (running) runningTasks.add(name);
      else runningTasks.delete(name);
    },
    runTask: async (taskName) => {
      const config = liveConfig.current;

      // Runtime gate — honors the toggle flipped since startup. We log once
      // per transition so the log doesn't repeat on every scheduler tick.
      const enabled = config.agent.scheduled_tasks_enabled !== false;
      if (enabled !== lastEnabled) {
        logger.info(
          LOG_KINDS.AGENT_RUN,
          enabled
            ? 'Scheduled agent tasks re-enabled — resuming'
            : 'Scheduled agent tasks disabled — skipping until re-enabled',
        );
        lastEnabled = enabled;
      }
      if (!enabled) return;

      const { runAgent } = await import('@myco/agent/executor.js');
      const resumableRun = NON_RESUMABLE_SCHEDULED_TASKS.has(taskName)
        ? null
        : getLatestResumableRunForTask(DEFAULT_AGENT_ID, taskName);
      if (resumableRun) {
        const resumed = await runAgent(vaultDir, {
          agentId: DEFAULT_AGENT_ID,
          task: taskName,
          resumeRunId: resumableRun.id,
          resumeMode: 'scheduled',
          embeddingManager,
          logger,
        });
        logger.info(LOG_KINDS.AGENT_RUN, `Scheduled task ${taskName} resumed`, {
          status: resumed.status,
          runId: resumed.runId,
        });
        return;
      }

      const taskConfig = config.agent.tasks?.[taskName];
      const projectRoot = resolveProjectRoot(vaultDir);
      const built = await buildTaskInstruction(
        taskName,
        taskConfig?.params,
        taskAgentMap.get(taskName),
        projectRoot,
        embeddingManager,
        config,
        getTeamClient,
      );

      // Short-circuit: instruction-required tasks must not dispatch
      // the agent when there's no work. For skill-generate this means
      // no approved candidates — without the guard the agent falls
      // back to its default prompt and picks whatever it finds.
      if (isInstructionRequiredTask(taskName) && !built) {
        logger.info(
          LOG_KINDS.AGENT_RUN,
          `Scheduled task ${taskName} skipped — no work to do`,
          { task: taskName, reason: 'no-work' },
        );
        return;
      }

      const result = await runAgent(vaultDir, {
        task: taskName,
        instruction: built?.instruction,
        runContext: built?.context,
        embeddingManager,
        logger,
      });
      logger.info(LOG_KINDS.AGENT_RUN, `Scheduled task ${taskName} completed`, {
        status: result.status,
        runId: result.runId,
      });

      if (result.status === 'failed') {
        notify(vaultDir, {
          domain: 'agents',
          type: 'agent.task.failure',
          title: `Task failed: ${taskName}`,
          message: result.error ?? 'Unknown error',
          link: `/agent?run=${result.runId}`,
          metadata: { taskName, runId: result.runId },
        }, config);
      } else if (result.status === 'completed') {
        notify(vaultDir, {
          domain: 'agents',
          type: 'agent.task.success',
          title: `Task completed: ${taskName}`,
          link: `/agent?run=${result.runId}`,
          metadata: { taskName, runId: result.runId },
        }, config);

        // Batched mycelium notifications — emit summaries instead of per-tool-call
        const { countToolCallsByRun } = await import('@myco/db/queries/turns.js');
        const counts = countToolCallsByRun(result.runId, ['vault_create_spore', 'vault_write_digest']);
        const sporeCount = counts['vault_create_spore'] ?? 0;
        const digestCount = counts['vault_write_digest'] ?? 0;

        if (sporeCount > 0) {
          notify(vaultDir, {
            domain: 'mycelium',
            type: 'mycelium.spore.created',
            title: sporeCount === 1 ? 'Extracted 1 observation' : `Extracted ${sporeCount} observations`,
            message: `From ${taskName} run`,
            link: '/mycelium?tab=spores',
            metadata: { count: sporeCount, taskName, runId: result.runId },
          }, config);
        }
        if (digestCount > 0) {
          notify(vaultDir, {
            domain: 'mycelium',
            type: 'mycelium.digest.completed',
            title: `Digest updated (${digestCount} ${digestCount === 1 ? 'tier' : 'tiers'})`,
            link: '/mycelium?tab=digest',
            metadata: { tierCount: digestCount, taskName, runId: result.runId },
          }, config);
        }
      }
    },
    preConditions: {
      // Boolean preconditions delegate to the same domain-owned count
      // helpers as the accelerator dispatch, so there's a single
      // source of truth for "is there work pending?" per work unit.
      'has-unprocessed-batches': () => countUnprocessedSettledBatches() > 0,
      'has-pending-canopy-rows': () => countPendingCanopyDescribe(null, resolveCanopyProjectId(vaultDir)) > 0,
      'has-active-skills': () => countSkillRecords({ status: 'active' }) > 0,
      'has-approved-candidates': () => countCandidates({ status: 'approved' }) > 0,
      'has-skill-survey-evidence': () => getSkillSurveyEligibility(taskAgentMap.get(SKILL_SURVEY_TASK)).eligible,
    },
    // Dispatch table mapping accelerator names declared in YAML to the
    // domain-owned count functions. Each domain (canopy, batches, …)
    // owns its own SQL — this map is purely the scheduler-side seam, with
    // no schema knowledge. Adding a new accelerator is three small steps
    // in three different files: add a count fn to its domain package,
    // add the name to AcceleratorNameSchema, and add one line here.
    accelerators: {
      'canopy-pending-describe': () =>
        countPendingCanopyDescribe(null, resolveCanopyProjectId(vaultDir)),
      'unprocessed-settled-batches': () => countUnprocessedSettledBatches(),
    },
    onTaskError: (taskName, err) => {
      logger.error(LOG_KINDS.AGENT_ERROR, `Detached task "${taskName}" threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  };

  const { jobs, kicker } = buildScheduledJobs(
    allTasks,
    liveConfig.current.agent.tasks ?? {},
    scheduledContext,
    initialLastRuns,
  );
  powerManager.replaceGroup(SCHEDULED_JOB_PREFIX, jobs);
  logger.info(LOG_KINDS.DAEMON_START, `Synced ${jobs.length} scheduled task(s)`, {
    tasks: jobs.map((j) => j.name),
  });
  return kicker;
}
