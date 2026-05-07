import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from './power.js';
import type {
  ProjectTaskLastRunMap,
  ScheduledJobContext,
  ScheduledJobKicker,
} from './task-scheduler.js';
import { buildScheduledJobs, lastRunKey } from './task-scheduler.js';
import type { ProjectScope } from './scope-iteration.js';
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
import { getLastCompletedRunsForProject } from '@myco/db/queries/project-activity.js';
import { withDatabase } from '@myco/db/client.js';
import { getLatestResumableRunForTask } from '@myco/db/queries/runs.js';
import { countToolCallsByRun } from '@myco/db/queries/turns.js';
import { runAgent } from '@myco/agent/executor.js';
import { loadAllTasks } from '@myco/agent/registry.js';
import { notify } from '@myco/notifications/notify.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { DEFAULT_AGENT_ID, MS_PER_DAY } from '@myco/constants.js';
import { errorMessage } from '@myco/utils/error-message.js';
import {
  forEachGrove,
  forEachRegisteredProject,
  isProjectActive,
} from './scope-iteration.js';
import type { GroveRuntimeCache } from './grove-runtime-cache.js';
import type { ProjectPowerStateTracker } from './project-power-state.js';
import { assertGroveProjectId, isGroveEraId, type GroveProjectId } from '@myco/grove/ids.js';
import type { EmbeddingManager } from './embedding/manager.js';

const SCHEDULED_JOB_PREFIX = 'scheduled:';

// ---------------------------------------------------------------------------
// Cold-project gate
// ---------------------------------------------------------------------------

export interface ColdProjectGateDecision {
  should_run: boolean;
  state: 'warm' | 'cold' | null;
}

export interface ColdProjectGateInput {
  /** Open Grove DB handle for the project's home Grove. */
  db: import('bun:sqlite').Database;
  /** Project id from the daemon's request context (any string is accepted). */
  projectId: string | null;
  /**
   * Threshold in days; values <= 0 disable the gate so a vault can opt
   * out without flipping `scheduled_tasks_enabled`.
   */
  thresholdDays: number;
  /** Optional clock injection for tests. Defaults to `Date.now()`. */
  now?: number;
}

// Lenient by default: any input that makes activity undeterminable
// (zero threshold, null id, non-Grove id) returns should_run=true so a
// misconfigured boot path never starves the scheduler.
export function decideColdProjectGate(input: ColdProjectGateInput): ColdProjectGateDecision {
  if (input.thresholdDays <= 0) return { should_run: true, state: null };
  if (!input.projectId || !isGroveEraId(input.projectId, 'project')) {
    return { should_run: true, state: null };
  }
  const branded = assertGroveProjectId(input.projectId);
  const now = input.now ?? Date.now();
  const cutoffSeconds = Math.floor((now - input.thresholdDays * MS_PER_DAY) / 1000);
  const active = isProjectActive(input.db, branded, cutoffSeconds);
  return active ? { should_run: true, state: 'warm' } : { should_run: false, state: 'cold' };
}

// These tasks derive their work queue from durable state, so resuming
// a failed run would collapse history onto a single agent_runs row and
// erase the failure signal we use to tune turn budgets. Always start fresh.
const NON_RESUMABLE_SCHEDULED_TASKS = new Set<string>(['canopy-describe', 'canopy-map']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskSchedulingDeps {
  definitionsDir: string | undefined;
  /** Boot vault dir for user-defined tasks under `<vaultDir>/agents/tasks/`. */
  vaultDir?: string;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
  // Holder so toggle flips (agent.scheduled_tasks_enabled) take effect without restart.
  liveConfig: { current: MycoConfig };
  getTeamClient?: () => import('./team-sync.js').TeamSyncClient | null;
  cache: GroveRuntimeCache;
  mycoHome: string;
  machineId: string;
  projectStateTracker: ProjectPowerStateTracker;
}

// ---------------------------------------------------------------------------
// Boot-time seeding
// ---------------------------------------------------------------------------

// Cap the seed scan at the most recent SEED_FLOOR_DAYS of agent_runs so
// daemons with months of history don't pay a full-table GROUP at boot.
// Older rows are uninformative for the interval gate.
const SEED_FLOOR_DAYS = 30;

async function seedInitialLastRuns(
  cache: GroveRuntimeCache,
  logger: DaemonLogger,
  mycoHome: string,
): Promise<ProjectTaskLastRunMap> {
  const seed: ProjectTaskLastRunMap = {};
  const floorSeconds = Math.floor((Date.now() - SEED_FLOOR_DAYS * MS_PER_DAY) / 1000);
  await forEachGrove(cache, logger, ({ db, grove }) => {
    const rows = db.prepare(
      `SELECT project_id, task, MAX(completed_at) AS last_completed
       FROM agent_runs
       WHERE status IN ('completed', 'failed')
         AND completed_at IS NOT NULL
         AND completed_at >= ?
         AND task IS NOT NULL
         AND project_id IS NOT NULL
       GROUP BY project_id, task`,
    ).all(floorSeconds) as Array<{ project_id: string; task: string; last_completed: number }>;
    for (const row of rows) {
      const projectId = assertGroveProjectId(row.project_id);
      seed[lastRunKey(grove.id, projectId, row.task)] = row.last_completed * 1000;
    }
  }, { mycoHome, jobName: 'seed-last-runs' });
  return seed;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerScheduledTasks(
  powerManager: PowerManager,
  deps: TaskSchedulingDeps,
): Promise<ScheduledJobKicker> {
  const {
    definitionsDir,
    vaultDir,
    embeddingManager,
    logger,
    liveConfig,
    getTeamClient,
    cache,
    mycoHome,
    machineId,
    projectStateTracker,
  } = deps;

  if (!definitionsDir) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Skipping dynamic task scheduling — definitions directory unavailable');
    return { kick: () => {} };
  }

  // Per-(grove, project, task) running flags so one project's 20-minute
  // run never blocks another's tick.
  const runningTasks = new Set<string>();

  // Jobs always register. The scheduled_tasks_enabled gate lives inside
  // forEachProject so flipping the toggle in Settings takes effect
  // immediately — registration-time gating would lock the scheduler to
  // its startup value.
  let lastEnabled = liveConfig.current.agent.scheduled_tasks_enabled !== false;
  if (!lastEnabled) {
    logger.info(LOG_KINDS.AGENT_RUN, 'Scheduled agent tasks disabled (agent.scheduled_tasks_enabled: false) — jobs registered but will no-op until enabled');
  }

  // Per-(grove, project) cold-state log latch — emit warm/cold transition once.
  const lastColdState = new Map<string, 'warm' | 'cold' | null>();

  // Single canonical task list — tasks are project-agnostic, only their queries differ.
  const allTasks = Array.from(loadAllTasks(definitionsDir, vaultDir).values());

  const taskAgentMap = new Map<string, string>();
  for (const task of allTasks) {
    taskAgentMap.set(task.name, task.agent);
  }

  // Boot-time seed across all registered Groves, keyed by
  // `${projectId}:${taskName}` so warm projects don't double-fire on
  // restart. Failures are best-effort; an empty seed is fine.
  const initialLastRuns = await seedInitialLastRuns(cache, logger, mycoHome).catch((err) => {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to seed scheduled-task lastRun map', {
      error: errorMessage(err),
    });
    return {} as ProjectTaskLastRunMap;
  });

  async function dispatchScheduledTask(
    scope: ProjectScope,
    taskName: string,
  ): Promise<void> {
    const config = liveConfig.current;
    const { requestContext, projectRoot, projectVaultDir, projectId } = scope;
    const resumableRun = NON_RESUMABLE_SCHEDULED_TASKS.has(taskName)
      ? null
      : getLatestResumableRunForTask(DEFAULT_AGENT_ID, taskName, projectId);

    if (resumableRun) {
      const resumed = await runAgent(projectVaultDir, {
        agentId: DEFAULT_AGENT_ID,
        task: taskName,
        resumeRunId: resumableRun.id,
        resumeMode: 'scheduled',
        embeddingManager,
        requestContext,
        logger,
      });
      logger.info(LOG_KINDS.AGENT_RUN, `Scheduled task ${taskName} resumed`, {
        project_id: projectId,
        status: resumed.status,
        runId: resumed.runId,
      });
      return;
    }

    const taskConfig = config.agent.tasks?.[taskName];
    const built = await buildTaskInstruction(
      taskName,
      taskConfig?.params,
      taskAgentMap.get(taskName),
      projectRoot,
      embeddingManager,
      config,
      getTeamClient,
      requestContext,
    );

    // Without this guard, instruction-required tasks (e.g. skill-generate)
    // dispatch with no approved candidates and the agent picks arbitrary work.
    if (isInstructionRequiredTask(taskName) && !built) {
      logger.info(
        LOG_KINDS.AGENT_RUN,
        `Scheduled task ${taskName} skipped — no work to do`,
        { project_id: projectId, task: taskName, reason: 'no-work' },
      );
      return;
    }

    const result = await runAgent(projectVaultDir, {
      task: taskName,
      instruction: built?.instruction,
      runContext: built?.context,
      embeddingManager,
      requestContext,
      logger,
    });
    logger.info(LOG_KINDS.AGENT_RUN, `Scheduled task ${taskName} completed`, {
      project_id: projectId,
      status: result.status,
      runId: result.runId,
    });

    if (result.status === 'failed') {
      notify(projectVaultDir, {
        domain: 'agents',
        type: 'agent.task.failure',
        title: `Task failed: ${taskName}`,
        message: result.error ?? 'Unknown error',
        link: `/agent?run=${result.runId}`,
        metadata: { taskName, runId: result.runId },
      }, config, { projectId });
    } else if (result.status === 'completed') {
      notify(projectVaultDir, {
        domain: 'agents',
        type: 'agent.task.success',
        title: `Task completed: ${taskName}`,
        link: `/agent?run=${result.runId}`,
        metadata: { taskName, runId: result.runId },
      }, config, { projectId });

      const counts = countToolCallsByRun(result.runId, ['vault_create_spore', 'vault_write_digest']);
      const sporeCount = counts['vault_create_spore'] ?? 0;
      const digestCount = counts['vault_write_digest'] ?? 0;

      if (sporeCount > 0) {
        notify(projectVaultDir, {
          domain: 'mycelium',
          type: 'mycelium.spore.created',
          title: sporeCount === 1 ? 'Extracted 1 observation' : `Extracted ${sporeCount} observations`,
          message: `From ${taskName} run`,
          link: '/mycelium?tab=spores',
          metadata: { count: sporeCount, taskName, runId: result.runId },
        }, config, { projectId });
      }
      if (digestCount > 0) {
        notify(projectVaultDir, {
          domain: 'mycelium',
          type: 'mycelium.digest.completed',
          title: `Digest updated (${digestCount} ${digestCount === 1 ? 'tier' : 'tiers'})`,
          link: '/mycelium?tab=digest',
          metadata: { tierCount: digestCount, taskName, runId: result.runId },
        }, config, { projectId });
      }
    }
  }

  const coldStateKey = (groveId: string, projectId: GroveProjectId) => `${groveId}:${projectId}`;
  const runningKey = (groveId: string, projectId: GroveProjectId, name: string) =>
    lastRunKey(groveId, projectId, name);

  const scheduledContext: ScheduledJobContext = {
    forEachProject: async (visit) => {
      const config = liveConfig.current;
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

      const thresholdDays = config.agent.cold_project_threshold_days ?? 14;

      await forEachRegisteredProject(
        cache,
        logger,
        async (scope) => {
          await visit(scope);
        },
        {
          mycoHome,
          machineId,
          shouldVisit: (scope) => {
            // Long-term cost backstop, separate from the per-project sleep
            // timer — keeps cold projects registered without burning tokens.
            const decision = decideColdProjectGate({
              db: scope.db,
              projectId: scope.projectId,
              thresholdDays,
            });
            const key = coldStateKey(scope.grove.id, scope.projectId);
            const previous = lastColdState.get(key) ?? null;
            if (decision.state && decision.state !== previous) {
              logger.info(
                LOG_KINDS.AGENT_RUN,
                decision.state === 'cold'
                  ? `Project cold (${thresholdDays}d inactive) — pausing scheduled tasks`
                  : 'Project warm — resuming scheduled tasks',
                {
                  grove_id: scope.grove.id,
                  project_id: scope.projectId,
                  threshold_days: thresholdDays,
                },
              );
              lastColdState.set(key, decision.state);
            }
            return decision.should_run;
          },
        },
      );
    },
    isTaskRunning: (groveId, projectId, name) =>
      runningTasks.has(runningKey(groveId, projectId, name)),
    setTaskRunning: (groveId, projectId, name, running) => {
      const key = runningKey(groveId, projectId, name);
      if (running) runningTasks.add(key);
      else runningTasks.delete(key);
    },
    getProjectPowerState: (scope, hold) =>
      projectStateTracker.getStateWithHold(scope.grove.id, scope.projectId, hold),
    runTask: async (scope, taskName) => {
      // Pin across the detached run so cache eviction can't invalidate
      // the handle that runTask's continuations read via getDatabase().
      await cache.withPinned(scope.databasePath, () =>
        withDatabase(scope.db, () => dispatchScheduledTask(scope, taskName)),
      );
    },
    preConditions: {
      'has-unprocessed-batches': (scope) =>
        countUnprocessedSettledBatches(undefined, scope.projectId) > 0,
      'has-pending-canopy-rows': (scope) =>
        countPendingCanopyDescribe(null, scope.projectId) > 0,
      'has-active-skills': (scope) =>
        countSkillRecords({ status: 'active', project_id: scope.projectId }) > 0,
      'has-approved-candidates': (scope) =>
        countCandidates({ status: 'approved', project_id: scope.projectId }) > 0,
      'has-skill-survey-evidence': (scope) =>
        getSkillSurveyEligibility(
          taskAgentMap.get(SKILL_SURVEY_TASK),
          scope.requestContext,
        ).eligible,
    },
    accelerators: {
      'canopy-pending-describe': (scope, limit) =>
        countPendingCanopyDescribe(null, scope.projectId, limit),
      'unprocessed-settled-batches': (scope, limit) =>
        countUnprocessedSettledBatches(limit, scope.projectId),
    },
    onTaskError: (taskName, groveId, projectId, err) => {
      logger.error(LOG_KINDS.AGENT_ERROR, `Detached task "${taskName}" threw`, {
        grove_id: groveId,
        project_id: projectId,
        error: errorMessage(err),
      });
    },
    seedMissingLastRuns: (scope) => {
      const floor = Math.floor((Date.now() - SEED_FLOOR_DAYS * MS_PER_DAY) / 1000);
      const rows = getLastCompletedRunsForProject(scope.db, scope.projectId, floor);
      const out = new Map<string, number>();
      for (const row of rows) out.set(row.task, row.last_completed_seconds * 1000);
      return out;
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
