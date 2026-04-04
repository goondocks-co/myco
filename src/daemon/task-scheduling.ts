/**
 * Dynamic task scheduling registration.
 *
 * Extracted from main.ts — loads task definitions, seeds last-run times
 * from the database, builds the ScheduledJobContext (pre-conditions,
 * runTask with notifications), and registers scheduled jobs with the
 * PowerManager.
 */

import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from './power.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { ScheduledJobContext } from './task-scheduler.js';
import { buildScheduledJobs } from './task-scheduler.js';
import { buildSkillGenerateInstruction, SKILL_GENERATE_TASK } from './api/agent-runs.js';
import { countSkillRecords } from '@myco/db/queries/skill-records.js';
import { countCandidates } from '@myco/db/queries/skill-candidates.js';
import { getDatabase } from '@myco/db/client.js';
import { notify } from '@myco/notifications/notify.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskSchedulingDeps {
  definitionsDir: string | undefined;
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
  config: MycoConfig;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerScheduledTasks(
  powerManager: PowerManager,
  deps: TaskSchedulingDeps,
): Promise<void> {
  const { definitionsDir, vaultDir, embeddingManager, logger, config } = deps;
  const runningTasks = new Set<string>();

  if (!definitionsDir) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Skipping dynamic task scheduling — definitions directory unavailable');
    return;
  }

  // Global agent toggle — skip all scheduled task registration when disabled
  if (config.agent.scheduled_tasks_enabled === false) {
    logger.info(LOG_KINDS.AGENT_RUN, 'Scheduled agent tasks disabled globally (agent.scheduled_tasks_enabled: false)');
    return;
  }

  const { loadAllTasks } = await import('@myco/agent/registry.js');
  const allTasks = Array.from(loadAllTasks(definitionsDir, vaultDir).values());

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
      const { runAgent } = await import('@myco/agent/executor.js');

      // For skill-generate: inject the specific candidate ID so the agent
      // processes exactly one skill per run (structural enforcement, not prompt-based).
      const instruction = taskName === SKILL_GENERATE_TASK
        ? buildSkillGenerateInstruction()
        : undefined;

      const result = await runAgent(vaultDir, { task: taskName, instruction, embeddingManager });
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
        const row = getDatabase().prepare(
          'SELECT 1 FROM prompt_batches WHERE processed = 0 LIMIT 1'
        ).get();
        return row !== undefined;
      },
      'has-active-skills': () => {
        return countSkillRecords({ status: 'active' }) > 0;
      },
      'has-approved-candidates': () => {
        return countCandidates({ status: 'approved' }) > 0;
      },
    },
  };

  const scheduledJobs = buildScheduledJobs(
    allTasks,
    config.agent.tasks ?? {},
    scheduledContext,
    initialLastRuns,
  );
  for (const job of scheduledJobs) {
    powerManager.register(job);
  }
  logger.info(LOG_KINDS.DAEMON_START, `Registered ${scheduledJobs.length} scheduled task(s)`, {
    tasks: scheduledJobs.map((j) => j.name),
  });
}
