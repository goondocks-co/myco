import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import type { JobRunner } from './job-runner.js';
import type {
  ProjectTaskLastRunMap,
  ScheduledJobContext,
  ScheduledJobKicker,
} from './task-scheduler.js';
import { buildScheduledJobs, lastRunKey } from './task-scheduler.js';
import type { RegisteredProjectScope } from './scope-iteration.js';
import {
  buildTaskInstruction,
  getSkillSurveyEligibility,
  isInstructionRequiredTask,
  SKILL_SURVEY_TASK,
} from '@myco/agent/instruction-builders.js';
import { countSkillRecords } from '@myco/db/queries/skill-records.js';
import { countCandidates } from '@myco/db/queries/skill-candidates.js';
import { countPendingCanopyDescribe, canopyDescribeMaxAttempts } from '@myco/db/queries/canopy.js';
import { countUnprocessedSettledBatches, INTELLIGENCE_DEFAULT_ORIGINS } from '@myco/db/queries/batches.js';
import { countTaskRunsSince, getLastCompletedRunsForProject } from '@myco/db/queries/project-activity.js';
import { withDatabase } from '@myco/db/client.js';
import {
  applyRunUpdate,
  getLatestResumableRunForTask,
  incrementRunResumeAttempts,
  refundRunResumeAttempt,
  RESUME_STATUS_EXHAUSTED,
  type RunRow,
} from '@myco/db/queries/runs.js';
import { countToolCallsByRun } from '@myco/db/queries/turns.js';
import { dispatchAgentRun } from '@myco/agent/runner-host.js';
import { loadAllTasks } from '@myco/agent/registry.js';
import { notify } from '@myco/notifications/notify.js';
import { agentRunNotificationLink } from '@myco/notifications/links.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { DEFAULT_AGENT_ID, MS_PER_DAY } from '@myco/constants.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { effectiveTaskScheduleEnabled } from '@myco/config/capabilities.js';
import {
  forEachGrove,
  forEachRegisteredProject,
  isProjectActive,
} from './scope-iteration.js';
import { isProjectPausedInGrove, listRegisteredProjects } from '@myco/grove/registry.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { makeGrovePendingProbe } from './grove-pending-probe.js';
import type { GroveRuntimeCache } from './grove-runtime-cache.js';
import type { ProjectPowerStateTracker } from './project-power-state.js';
import { assertGroveProjectId, isGroveEraId, projectScope as toProjectScope, type GroveProjectId, type ProjectScope } from '@myco/grove/ids.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';

const SCHEDULED_JOB_PREFIX = 'scheduled:';

// ---------------------------------------------------------------------------
// Canopy-pending hold probe
// ---------------------------------------------------------------------------

// Accelerator cap used to bound the per-project COUNT. The hold only needs
// ">0"; stopping at the accelerated threshold avoids an unbounded COUNT on
// large canopy_entries tables.
const CANOPY_PROBE_COUNT_CAP = 50;

export interface CanopyPendingProbeDeps {
  cache: GroveRuntimeCache;
  logger: DaemonLogger;
  mycoHome?: string;
  daemonStateDir: string;
}

// Holds the daemon awake only when canopy-describe will actually drain the
// pending rows. canopy-describe defaults to `schedule.enabled: false` while
// canopy-background-scan ALWAYS populates pending rows — so an ungated hold
// would pin a default install awake for work a disabled task never runs.
// Count pending rows ONLY for projects where canopy-describe is enabled.
export function makeTotalCanopyPendingProbe(deps: CanopyPendingProbeDeps): () => number {
  return makeGrovePendingProbe({
    cache: deps.cache,
    logger: deps.logger,
    daemonStateDir: deps.daemonStateDir,
    mycoHome: deps.mycoHome,
    logKind: LOG_KINDS.CANOPY_ERROR,
    // Runs inside the helper's `withDatabase(groveDb)`, so the ambient db
    // for `countPendingCanopyDescribe` is this Grove's DB.
    countForGrove: ({ grove, mycoHome }) => {
      let grovePending = 0;
      for (const project of listRegisteredProjects(grove.id, mycoHome)) {
        const config = loadMergedConfig(resolveProjectVaultDir(project.root), {
          groveId: grove.id,
          mycoHome,
        });
        if (!effectiveTaskScheduleEnabled(config, 'canopy-describe', false)) continue;
        grovePending += countPendingCanopyDescribe(
          null,
          project.project_id,
          CANOPY_PROBE_COUNT_CAP,
          canopyDescribeMaxAttempts(config),
        );
        if (grovePending > 0) break;
      }
      return grovePending;
    },
  });
}

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

/**
 * Scheduled resume retry budget per run. A run that fails this many resumes
 * is terminal-marked (`resumable=0`, `resume_status='exhausted'`) and the
 * scheduler starts a fresh run in the same tick instead of re-attaching to
 * the failing checkpoint forever. Manual resumes (the API endpoint) do not
 * consume the budget — only scheduler-driven retries count.
 */
export const RESUME_MAX_ATTEMPTS = 3;

export interface ScheduledResumeGateInput {
  run: RunRow;
  taskName: string;
  scope: ProjectScope;
  projectVaultDir: string;
  projectId: GroveProjectId;
  config: MycoConfig;
  logger: DaemonLogger;
}

/**
 * Decide whether a resumable run may consume another scheduled resume.
 *
 * - Under the cap: increments `resume_attempts` (before dispatch, so a
 *   crash mid-resume still counts) and returns 'resume'.
 * - At the cap: terminal-marks the run (`resumable=0` +
 *   `resume_status='exhausted'`), emits the agent.task.failure
 *   notification, and returns 'exhausted' — the caller falls through to a
 *   fresh dispatch in the same tick.
 */
export function gateScheduledResume(input: ScheduledResumeGateInput): 'resume' | 'exhausted' {
  const { run, taskName, scope, projectVaultDir, projectId, config, logger } = input;
  if (run.resume_attempts < RESUME_MAX_ATTEMPTS) {
    incrementRunResumeAttempts(run.id, scope);
    return 'resume';
  }
  applyRunUpdate(run.id, {
    resumable: 0,
    resume_status: RESUME_STATUS_EXHAUSTED,
  }, scope);
  logger.warn(LOG_KINDS.AGENT_ERROR, `Scheduled task ${taskName} resume retries exhausted — starting fresh`, {
    project_id: projectId,
    runId: run.id,
    attempts: run.resume_attempts,
  });
  notify(projectVaultDir, {
    domain: 'agents',
    type: 'agent.task.failure',
    title: `Task failed: ${taskName}`,
    message: `Resume retries exhausted after ${run.resume_attempts} attempts; starting a fresh run`,
    link: agentRunNotificationLink(run.id),
    metadata: { taskName, runId: run.id },
  }, config, { projectId });
  return 'exhausted';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskSchedulingDeps {
  definitionsDir: string | undefined;
  /** Boot vault dir for user-defined tasks under `<vaultDir>/agents/tasks/`. */
  vaultDir?: string;
  /** Resolve the grove EmbeddingManager for a run's request context. Per-run
   *  resolution — never the daemon-bootstrap manager (anchor-leak Variant A:
   *  the agent's vector/canopy search tools must hit the run's grove store). */
  resolveEmbeddingManager: (requestContext: MycoRequestContext | undefined) => EmbeddingManager;
  logger: DaemonLogger;
  getTeamClient?: () => import('./team-sync.js').TeamSyncClient | null;
  cache: GroveRuntimeCache;
  mycoHome: string;
  /** The current daemon's service dir; passed through to `forEachGrove` to enforce the served-by boundary. */
  daemonStateDir: string;
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
  daemonStateDir: string,
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
  }, { mycoHome, daemonStateDir, jobName: 'seed-last-runs' });
  return seed;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerScheduledTasks(
  runner: JobRunner,
  deps: TaskSchedulingDeps,
): Promise<ScheduledJobKicker> {
  const {
    definitionsDir,
    vaultDir,
    resolveEmbeddingManager,
    logger,
    getTeamClient,
    cache,
    mycoHome,
    daemonStateDir,
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
  // forEachProject so flipping the Grove-scoped toggle in Settings takes
  // effect immediately.
  const lastEnabledByProject = new Map<string, boolean>();

  // Per-(grove, project) cold-state log latch — emit warm/cold transition once.
  const lastColdState = new Map<string, 'warm' | 'cold' | null>();
  const lastConfigErrorByProject = new Map<string, string>();

  // Single canonical task list — tasks are project-agnostic, only their queries differ.
  const allTasks = Array.from(loadAllTasks(definitionsDir, vaultDir).values());

  const taskAgentMap = new Map<string, string>();
  for (const task of allTasks) {
    taskAgentMap.set(task.name, task.agent);
  }

  // No scheduler-side memo, deliberately. A previous single-slot memo
  // (keyed on the last-resolved project) only ever invalidated when a
  // DIFFERENT project resolved between calls — on a single-project install
  // the key never changed, so Settings changes (scheduled_tasks_enabled,
  // cold_project_threshold_days, capability gates) were served from boot
  // values until a daemon restart, and a config-load error was latched as
  // permanent. loadMergedConfig carries its own mtime+size-fingerprinted
  // cache, so resolving per call costs a handful of stat()s on the hot
  // path — negligible at tick cadence, and config edits (and error
  // recovery) take effect on the next evaluation, as the gate comment
  // above promises.
  function resolveProjectConfig(scope: RegisteredProjectScope): MycoConfig | null {
    const key = `${scope.grove.id}:${scope.projectId}`;
    try {
      const config = loadMergedConfig(scope.projectVaultDir, {
        groveId: scope.grove.id,
        mycoHome,
      });
      if (lastConfigErrorByProject.has(key)) {
        logger.info(LOG_KINDS.AGENT_RUN, 'Tenant config recovered for scheduled tasks', {
          grove_id: scope.grove.id,
          project_id: scope.projectId,
        });
        lastConfigErrorByProject.delete(key);
      }
      return config;
    } catch (err) {
      const message = errorMessage(err);
      if (lastConfigErrorByProject.get(key) !== message) {
        logger.error(LOG_KINDS.AGENT_ERROR, 'Failed to load tenant config for scheduled tasks; skipping project tick', {
          grove_id: scope.grove.id,
          project_id: scope.projectId,
          error: message,
        });
        lastConfigErrorByProject.set(key, message);
      }
      return null;
    }
  }

  // Boot-time seed across all registered Groves, keyed by
  // `${projectId}:${taskName}` so warm projects don't double-fire on
  // restart. Failures are best-effort; an empty seed is fine.
  const initialLastRuns = await seedInitialLastRuns(cache, logger, mycoHome, daemonStateDir).catch((err) => {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to seed scheduled-task lastRun map', {
      error: errorMessage(err),
    });
    return {} as ProjectTaskLastRunMap;
  });

  async function dispatchScheduledTask(
    scope: RegisteredProjectScope,
    taskName: string,
  ): Promise<void> {
    const config = resolveProjectConfig(scope);
    if (!config) return;
    const { requestContext, projectRoot, projectVaultDir, projectId } = scope;
    // Grove-scoped manager for this project's run — never the bootstrap anchor.
    const embeddingManager = resolveEmbeddingManager(requestContext);
    const readScope: ProjectScope = toProjectScope(projectId);
    const resumableRun = NON_RESUMABLE_SCHEDULED_TASKS.has(taskName)
      ? null
      : getLatestResumableRunForTask(DEFAULT_AGENT_ID, taskName, readScope);

    if (resumableRun) {
      const gate = gateScheduledResume({
        run: resumableRun,
        taskName,
        scope: readScope,
        projectVaultDir,
        projectId,
        config,
        logger,
      });
      if (gate === 'resume') {
        const resumed = await dispatchAgentRun(projectVaultDir, {
          agentId: DEFAULT_AGENT_ID,
          task: taskName,
          resumeRunId: resumableRun.id,
          resumeMode: 'scheduled',
          embeddingManager,
          requestContext,
          logger,
        });
        if (resumed.status === 'skipped') {
          // The executor never started the resume (another run of the task
          // is active — e.g. a long manual run; the runningTasks set only
          // covers scheduler dispatches). Only dispatches that actually
          // start a resume consume budget, so hand the attempt back —
          // otherwise ticks during that run would exhaust the budget with
          // zero resumes executed.
          refundRunResumeAttempt(resumableRun.id, readScope);
        }
        logger.info(LOG_KINDS.AGENT_RUN, `Scheduled task ${taskName} resumed`, {
          project_id: projectId,
          status: resumed.status,
          runId: resumed.runId,
        });
        return;
      }
      // 'exhausted' — fall through to a fresh run in the same tick.
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

    const result = await dispatchAgentRun(projectVaultDir, {
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
        link: agentRunNotificationLink(result.runId),
        metadata: { taskName, runId: result.runId },
      }, config, { projectId });
    } else if (result.status === 'completed') {
      notify(projectVaultDir, {
        domain: 'agents',
        type: 'agent.task.success',
        title: `Task completed: ${taskName}`,
        link: agentRunNotificationLink(result.runId),
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
      await forEachRegisteredProject(
        cache,
        logger,
        async (scope) => {
          await visit(scope);
        },
        {
          mycoHome,
          daemonStateDir,
          machineId,
          shouldVisit: (scope) => {
            const config = resolveProjectConfig(scope);
            if (!config) return false;
            const enabled = config.agent.scheduled_tasks_enabled !== false;
            const enabledKey = coldStateKey(scope.grove.id, scope.projectId);
            const previousEnabled = lastEnabledByProject.get(enabledKey);
            if (previousEnabled !== enabled) {
              logger.info(
                LOG_KINDS.AGENT_RUN,
                enabled
                  ? 'Scheduled agent tasks enabled for project'
                  : 'Scheduled agent tasks disabled for project',
                {
                  grove_id: scope.grove.id,
                  project_id: scope.projectId,
                },
              );
              lastEnabledByProject.set(enabledKey, enabled);
            }
            if (!enabled) return false;

            // Long-running ops (move, vacuum) take a per-project pause;
            // skip the project so its DB stays untouched for the op.
            const paused = isProjectPausedInGrove(scope.grove.id, scope.projectId, mycoHome);
            if (paused.paused) {
              logger.debug(
                LOG_KINDS.AGENT_RUN,
                'Skipping scheduled tasks for paused project',
                {
                  grove_id: scope.grove.id,
                  project_id: scope.projectId,
                  reason: paused.reason,
                  owner_op: paused.owner_op,
                },
              );
              return false;
            }
            // Long-term cost backstop, separate from the per-project sleep
            // timer — keeps cold projects registered without burning tokens.
            const thresholdDays = config.agent.cold_project_threshold_days ?? 14;
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
    getTaskConfig: (scope, taskName) => {
      const config = resolveProjectConfig(scope);
      if (!config) return { schedule: { enabled: false } };
      return config.agent.tasks?.[taskName];
    },
    getTaskScheduleEnabled: (scope, taskName, yamlScheduleEnabled) =>
      effectiveTaskScheduleEnabled(resolveProjectConfig(scope), taskName, yamlScheduleEnabled),
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
        countUnprocessedSettledBatches(toProjectScope(scope.projectId), {
          origins: INTELLIGENCE_DEFAULT_ORIGINS,
        }) > 0,
      'has-pending-canopy-rows': (scope) =>
        countPendingCanopyDescribe(
          null,
          scope.projectId,
          undefined,
          canopyDescribeMaxAttempts(resolveProjectConfig(scope)),
        ) > 0,
      'has-active-skills': (scope) =>
        countSkillRecords({ status: 'active', scope: toProjectScope(scope.projectId) }) > 0,
      'has-approved-candidates': (scope) =>
        countCandidates({ status: 'approved', scope: toProjectScope(scope.projectId) }) > 0,
      'has-skill-survey-evidence': (scope) =>
        getSkillSurveyEligibility(
          taskAgentMap.get(SKILL_SURVEY_TASK),
          scope.requestContext,
        ).eligible,
    },
    accelerators: {
      'canopy-pending-describe': (scope, limit) =>
        countPendingCanopyDescribe(
          null,
          scope.projectId,
          limit,
          canopyDescribeMaxAttempts(resolveProjectConfig(scope)),
        ),
      'unprocessed-settled-batches': (scope, limit) =>
        countUnprocessedSettledBatches(toProjectScope(scope.projectId), {
          limit,
          origins: INTELLIGENCE_DEFAULT_ORIGINS,
        }),
    },
    getRecentTaskRunCount: (scope, taskName, windowSeconds) => {
      const sinceSeconds = Math.floor(Date.now() / 1000) - windowSeconds;
      return countTaskRunsSince(scope.db, scope.projectId, taskName, sinceSeconds);
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
    canopyPendingProbe: makeTotalCanopyPendingProbe({ cache, logger, mycoHome, daemonStateDir }),
  };

  const { jobs, kicker } = buildScheduledJobs(
    allTasks,
    scheduledContext,
    initialLastRuns,
  );
  runner.replaceGroup(SCHEDULED_JOB_PREFIX, jobs);
  logger.info(LOG_KINDS.DAEMON_START, `Synced ${jobs.length} scheduled task(s)`, {
    tasks: jobs.map((j) => j.name),
  });
  return kicker;
}
