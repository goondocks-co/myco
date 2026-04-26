/**
 * Dynamic task scheduling registration.
 *
 * Extracted from main.ts — loads task definitions, seeds last-run times
 * from the database, builds the ScheduledJobContext (pre-conditions,
 * runTask with notifications), and registers scheduled jobs with the
 * PowerManager.
 */

import { resolve } from 'node:path';
import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from './power.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { ScheduledJobContext } from './task-scheduler.js';
import { buildScheduledJobs } from './task-scheduler.js';
import {
  buildTaskInstruction,
  getSkillSurveyEligibility,
  isInstructionRequiredTask,
  SKILL_SURVEY_TASK,
} from '@myco/agent/instruction-builders.js';
import { countSkillRecords } from '@myco/db/queries/skill-records.js';
import { countCandidates } from '@myco/db/queries/skill-candidates.js';
import { getDatabase } from '@myco/db/client.js';
import { getLatestResumableRunForTask } from '@myco/db/queries/runs.js';
import { notify } from '@myco/notifications/notify.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';

const SCHEDULED_JOB_PREFIX = 'scheduled:';

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
): Promise<void> {
  const { definitionsDir, vaultDir, embeddingManager, logger, liveConfig, getTeamClient } = deps;
  const runningTasks = new Set<string>();

  if (!definitionsDir) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Skipping dynamic task scheduling — definitions directory unavailable');
    return;
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
      const resumableRun = getLatestResumableRunForTask(DEFAULT_AGENT_ID, taskName);
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
      const projectRoot = resolve(vaultDir, '..');
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
      'has-unprocessed-batches': () => {
        // Only count unprocessed batches from sessions that have settled
        // (status != 'active'). Otherwise vault-evolve fires on every
        // live prompt and then filters everything out — wasted agent runs.
        const row = getDatabase().prepare(
          `SELECT 1 FROM prompt_batches pb
           WHERE pb.processed = 0
             AND EXISTS (
               SELECT 1 FROM sessions s
               WHERE s.id = pb.session_id AND s.status != 'active'
             )
           LIMIT 1`,
        ).get();
        return row !== undefined;
      },
      'has-active-skills': () => {
        return countSkillRecords({ status: 'active' }) > 0;
      },
      'has-approved-candidates': () => {
        return countCandidates({ status: 'approved' }) > 0;
      },
      'has-skill-survey-evidence': () => {
        return getSkillSurveyEligibility(taskAgentMap.get(SKILL_SURVEY_TASK)).eligible;
      },
      'has-pending-canopy-rows': () => {
        const row = getDatabase().prepare(
          `SELECT 1 FROM canopy_entries
            WHERE llm_description IS NULL
               OR llm_updated_at < mechanical_updated_at
            LIMIT 1`,
        ).get();
        return row !== undefined;
      },
    },
    onTaskError: (taskName, err) => {
      logger.error(LOG_KINDS.AGENT_ERROR, `Detached task "${taskName}" threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  };

  const scheduledJobs = buildScheduledJobs(
    allTasks,
    liveConfig.current.agent.tasks ?? {},
    scheduledContext,
    initialLastRuns,
  );
  powerManager.replaceGroup(SCHEDULED_JOB_PREFIX, scheduledJobs);
  logger.info(LOG_KINDS.DAEMON_START, `Synced ${scheduledJobs.length} scheduled task(s)`, {
    tasks: scheduledJobs.map((j) => j.name),
  });
}
