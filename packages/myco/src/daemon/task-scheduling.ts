import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { projectTreeAvailable } from '@myco/vault/resolve.js';
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
  hasNewerCompletedEquivalentRun,
  incrementRunResumeAttempts,
  refundRunResumeAttempt,
  RESUME_STATUS_EXHAUSTED,
  RESUME_STATUS_SUPERSEDED,
  type RunRow,
} from '@myco/db/queries/runs.js';
import { countToolCallsByRun } from '@myco/db/queries/turns.js';
import { dispatchAgentRun } from '@myco/agent/runner-host.js';
import { loadAllTasks } from '@myco/agent/registry.js';
import type { AgentRunResult } from '@myco/agent/types.js';
import { notify } from '@myco/notifications/notify.js';
import { agentRunNotificationLink } from '@myco/notifications/links.js';
import { HARNESS_HEALTH_TASK_NAME, notifyHarnessHealthFindings } from '@myco/notifications/harness-health-consumer.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { DEFAULT_AGENT_ID, MS_PER_DAY } from '@myco/constants.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { effectiveTaskScheduleEnabled, isCaptureOnly } from '@myco/config/capabilities.js';
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
import { ProjectVault } from '@myco/vault/project-vault.js';
import { okfSynthesizeDue } from '@myco/okf/schedule.js';
import { latestOkfGeneration } from '@myco/db/queries/okf.js';

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
        // A served project's working tree lives on the member's machine —
        // degrade to machine+grove tiers (empty project tier). Without this,
        // one tree-unavailable project throws out of countForGrove and the
        // probe's per-Grove catch discards the count for EVERY project in
        // the Grove.
        const projectVaultDir = resolveProjectVaultDir(project.root);
        const config = loadMergedConfig(projectVaultDir, {
          groveId: grove.id,
          mycoHome,
          projectTierOptional: !projectTreeAvailable(projectVaultDir),
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

// canopy-describe / canopy-map derive their work queue from durable state,
// so resuming a failed run would collapse history onto a single agent_runs
// row and erase the failure signal we use to tune turn budgets. Always
// start fresh. harness-health is non-resumable for a different reason: the
// scheduled resume branch (dispatchScheduledTask's resumableRun path) emits
// no completion notifications on its own, so a resumed run would silently
// skip the harness-health-consumer notification seam — and a stale health
// report from an old window isn't worth resuming toward anyway. A fresh
// run always starts a new window.
const NON_RESUMABLE_SCHEDULED_TASKS = new Set<string>(['canopy-describe', 'canopy-map', 'harness-health']);

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
 * - Superseded belt (Part 1 secondary): if a completed equivalent run
 *   (same agent/task/project scope/dry_run — same scheduled job) finished
 *   AFTER this run's own ORIGINAL dispatch (`started_at`), terminal-marks
 *   (`resumable=0`, `resume_status='superseded'`) and returns 'superseded'
 *   — the caller falls through to a fresh dispatch. Defends legacy rows
 *   written before the completion-time sweep existed, and any race the
 *   sweep's single-completion trigger can't see. No side effects live in
 *   the db/queries read helper (`hasNewerCompletedEquivalentRun`) —
 *   `gateScheduledResume` already owns terminal-marking for this run, so
 *   the write happens here.
 * - Under the cap: increments `resume_attempts` (before dispatch, so a
 *   crash mid-resume still counts) and returns 'resume'.
 * - At the cap: terminal-marks the run (`resumable=0` +
 *   `resume_status='exhausted'`), emits the agent.task.failure
 *   notification, and returns 'exhausted' — the caller falls through to a
 *   fresh dispatch in the same tick.
 */
export function gateScheduledResume(input: ScheduledResumeGateInput): 'resume' | 'exhausted' | 'superseded' {
  const { run, taskName, scope, projectVaultDir, projectId, config, logger } = input;

  if (hasNewerCompletedEquivalentRun(run, {
    agentId: run.agent_id,
    taskName,
    scope,
    dryRun: run.dry_run,
  })) {
    applyRunUpdate(run.id, {
      resumable: 0,
      resume_status: RESUME_STATUS_SUPERSEDED,
    }, scope);
    logger.warn(LOG_KINDS.AGENT_ERROR, `Scheduled task ${taskName} resume superseded by a newer completed run — starting fresh`, {
      project_id: projectId,
      runId: run.id,
    });
    return 'superseded';
  }

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

export interface ScheduledRunOutcomeInput {
  result: Pick<AgentRunResult, 'runId' | 'status' | 'error'>;
  taskName: string;
  projectVaultDir: string;
  projectId: GroveProjectId;
  config: MycoConfig;
  logger: DaemonLogger;
}

/**
 * Emit the post-dispatch notifications for a scheduled run: task
 * failure/success, spore/digest activity (from the run's tool calls), and —
 * for a completed harness-health sentinel — the findings notification
 * derived from the run's `harness-health` report. Skipped dispatches
 * (`status: 'skipped'`) emit nothing.
 */
export async function notifyScheduledRunOutcome(input: ScheduledRunOutcomeInput): Promise<void> {
  const { result, taskName, projectVaultDir, projectId, config, logger } = input;

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

    if (taskName === HARNESS_HEALTH_TASK_NAME) {
      await notifyHarnessHealthFindings({
        runId: result.runId,
        projectVaultDir,
        config,
        projectId,
        logger,
      });
    }
  }
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
// Task-admission gate
// ---------------------------------------------------------------------------

/**
 * Effective schedule-enablement for one (project config, task) pair.
 *
 * harness-health has no governing capability in the capability map, so
 * `effectiveTaskScheduleEnabled` fails open for it; this additionally
 * disables it on a capture-only project (every opt-in capability off).
 */
export function resolveTaskScheduleEnabled(
  config: MycoConfig | null,
  taskName: string,
  yamlScheduleEnabled: boolean,
): boolean {
  if (taskName === HARNESS_HEALTH_TASK_NAME && isCaptureOnly(config)) return false;
  return effectiveTaskScheduleEnabled(config, taskName, yamlScheduleEnabled);
}

// ---------------------------------------------------------------------------
// Scheduled-task preConditions
// ---------------------------------------------------------------------------

/**
 * Free variables `preConditions` closes over from `registerScheduledTasks`.
 * Extracted to a module-level factory (rather than an inline object literal
 * in the closure) so a test can assert every `PreConditionSchema` member has
 * a registry key here — the scheduler's `if (!check) continue;` means an
 * unregistered precondition name silently means the task never runs, which
 * only a membership test (not a runtime error) catches.
 */
export interface PreConditionRegistryDeps {
  resolveProjectConfig: (scope: RegisteredProjectScope) => MycoConfig | null;
  taskAgentMap: Map<string, string>;
}

/** Registry of scheduled-task preCondition checks, keyed by `PreConditionSchema` member. */
export function buildPreConditions(
  deps: PreConditionRegistryDeps,
): Record<string, (scope: RegisteredProjectScope) => boolean> {
  const { resolveProjectConfig, taskAgentMap } = deps;
  return {
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
    'okf-synthesize-due': (scope) => {
      const config = resolveProjectConfig(scope);
      if (!config) return false;
      return okfSynthesizeDue(
        toProjectScope(scope.projectId),
        config,
        scope.projectRoot,
        scope.projectId,
        scope.requestContext.machineId,
        latestOkfGeneration(toProjectScope(scope.projectId), ['published']),
      );
    },
  };
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
        // A Team Host iterating a member's registered project has no local
        // working tree — degrade to machine+grove tiers (empty project tier)
        // instead of throwing "myco.yaml not found" and silently skipping
        // the project via shouldVisit's catch below.
        projectTierOptional: !scope.treeAvailable,
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
    const { requestContext, projectRoot, projectVaultDir, projectId, treeAvailable } = scope;
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
          treeAvailable,
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
      // 'exhausted' or 'superseded' — fall through to a fresh run in the
      // same tick (Part 4: the interval-clock stamp above is deliberately
      // pre-dispatch, so this fall-through keeps the tick from being a
      // no-op even though gateScheduledResume already terminal-marked the
      // old run).
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
      treeAvailable,
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
      treeAvailable,
    });
    logger.info(LOG_KINDS.AGENT_RUN, `Scheduled task ${taskName} completed`, {
      project_id: projectId,
      status: result.status,
      runId: result.runId,
    });

    await notifyScheduledRunOutcome({
      result,
      taskName,
      projectVaultDir,
      projectId,
      config,
      logger,
    });
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
    getTaskScheduleEnabled: (scope, taskName, yamlScheduleEnabled) => {
      const config = resolveProjectConfig(scope);
      const enabled = resolveTaskScheduleEnabled(config, taskName, yamlScheduleEnabled);
      if (!enabled && taskName === HARNESS_HEALTH_TASK_NAME && isCaptureOnly(config)) {
        logger.debug(LOG_KINDS.AGENT_RUN, 'Skipping harness-health — project is capture-only', {
          grove_id: scope.grove.id,
          project_id: scope.projectId,
        });
      }
      return enabled;
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
    preConditions: buildPreConditions({ resolveProjectConfig, taskAgentMap }),
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
