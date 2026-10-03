/**
 * The clock's own dispatches: every task the Deployment schedules, considered
 * for every Project it holds, on each wake.
 *
 * The gates run in the order the 1.4 daemon applied them — a Deployment-wide
 * switch, the Project's own recency, whether the task is already live, the
 * interval (shortened under backlog), the state the task runs in, a named
 * precondition, the per-day ceiling — and the dispatcher takes what passes,
 * launching or queueing as the limits say. Nothing here is held between
 * wakes: every gate reads its answer from the store, so a wake delivered
 * twice schedules nothing twice.
 *
 * A dispatch limit and a per-day ceiling answer differently, and the difference
 * is the point: a limit QUEUES, a ceiling REFUSES (`ceilingSkipId`).
 */
import type { ServerEnv } from './adapters.js';
import { AlreadyRunning, dispatchPrepared, HARNESS_AGENT_ID, prepareDispatch, type LaunchSpec } from './harness.js';
import { buildTaskInput } from './task-inputs.js';
import type { PowerState } from './power.js';
import { ensureAgent, INPUT_UNCHANGED, recordSkipped, taskFactsKey, taskRunFacts, type TaskRunFacts } from './runs.js';
import { enabledCapabilities, type ProjectCapability } from './settings.js';
import { type TaskSchedule } from './jobs.js';
import { declared } from './declared.js';
import { admissionForTask, runTimeoutForTask } from './task-catalogue.js';
import { listProjects } from '../read/sessions.js';
import { emit } from '../telemetry.js';
import {
  ACCELERATORS, ACTIVE_WINDOW_DAYS_DEFAULT, COLD_PROJECT_THRESHOLD_DAYS_DEFAULT, effectiveIntervalSeconds, hasUnprocessedPrompts, MEMBER_RUNS_PER_DAY_DEFAULT,
  memberRunsPerDay, PRE_CONDITIONS, resolveSchedule, scheduledTasks, scheduleFor, scheduleLeaves, scheduleOverride, type ScheduleLeaves,
} from './schedule-rules.js';

export {
  ACCELERATORS, ACTIVE_WINDOW_DAYS_DEFAULT, COLD_PROJECT_THRESHOLD_DAYS_DEFAULT, effectiveIntervalSeconds, hasUnprocessedPrompts, MEMBER_RUNS_PER_DAY_DEFAULT,
  memberRunsPerDay, PRE_CONDITIONS, resolveSchedule, scheduledTasks, scheduleFor, scheduleLeaves, scheduleOverride, type ScheduleLeaves,
};

const DAY_MS = 86_400_000;

/**
 * A ceiling refuses dispatch until the trailing 24-hour window has room.
 * Refusals share an id keyed by project, task and the window's filling instant.
 * Separate episodes can fill on the same UTC day; one episode can span midnight.
 * Replaced entries affect the filling instant but not the count, so a replacement
 * can produce an additional refusal row during an episode.
 * A zero ceiling uses one id for a project and task with no prior entry.
 * Skipped rows are excluded from the ceiling count; task names contain no `_`.
 */
const NO_ENTRY = 0;
const ceilingSkipId = (projectId: string, task: string, filledAt: number | null): string =>
  `run_ceiling_${projectId}_${task}_${filledAt ?? NO_ENTRY}`;

/**
 * A skip the clock records, carrying the harness identity its row points at.
 *
 * A skipped run names the harness agent as every other run does, and that row is
 * a foreign key. A Deployment that has never dispatched holds no such row —
 * a ceiling of zero refuses before any dispatch can declare it — so the identity
 * is declared here where none exists. An owner's own registration of it keeps
 * every field: this declares, it never edits.
 */
async function recordClockSkip(env: ServerEnv, projectId: string, task: string, reason: string, id: string, now: number): Promise<void> {
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: null, model: null, enabled: true }, now);
  await recordSkipped(env.db, { projectId }, { id, agentId: HARNESS_AGENT_ID, task, reason, at: now });
}

/** Who a scheduled run is attributed to: the Deployment's own clock. */
export const CLOCK_ACTOR = 'clock';
/** Why the clock left a task alone this wake; a ceiling met is recorded on a run row, the rest are told. */
export type ScheduleSkip = 'disabled' | 'already_running' | 'not_yet' | 'not_in_state' | 'precondition' | 'max_runs_per_day' | 'reserved_runs_per_day' | 'capability_off' | 'cold' | 'quiet' | 'refused' | 'input_unchanged' | 'uninstructed';

export interface ScheduleReport {
  /** Dispatches the clock made, launched or queued. */
  dispatched: number;
  /** Per-day ceilings met, each recorded as a skipped run. */
  skipped: number;
}

/**
 * What one wake's schedule reads of the Deployment's Projects before it decides anything: each Project's runs of each
 * scheduled task, and the capabilities those tasks are admitted by. It is read once for every Project, in one round
 * trip, so the clock's cost does not grow with the Projects it holds. A wake's own dispatches and skips change only
 * the Project and task it decided, which it decides once, so one read serves the whole wake.
 */
export interface ScheduleFacts {
  runs: Map<string, TaskRunFacts>;
  /** `taskFactsKey(projectId, capability)` for every capability a Project has turned on. */
  capabilities: Set<string>;
}

const NO_RUNS: TaskRunFacts = { live: false, lastEntryAt: null, entriesSince: 0 };

/** The facts `decideTask` reads for `tasks`, for every Project or the one named. */
export async function readScheduleFacts(env: ServerEnv, tasks: readonly string[], now: number, projectId?: string): Promise<ScheduleFacts> {
  if (tasks.length === 0) return { runs: new Map(), capabilities: new Set() };
  const gated = [...new Set(tasks.flatMap((task) => {
    const gate = admissionForTask(task);
    return gate?.kind === 'capability' ? [gate.capability as ProjectCapability] : [];
  }))];
  const runs = taskRunFacts(env.db, tasks, now - DAY_MS, CLOCK_ACTOR, projectId);
  const capabilities = gated.length === 0 ? null : enabledCapabilities(env.db, gated, projectId);
  const [runRows, capabilityRows] = await env.db.batch([runs.statement, ...(capabilities === null ? [] : [capabilities.statement])]);
  return {
    runs: runs.read(runRows!.results as ReadonlyArray<Record<string, unknown>>),
    capabilities: new Set(capabilities === null ? [] : capabilities.read(capabilityRows!.results as ReadonlyArray<Record<string, unknown>>)
      .map(({ projectId: held, capability }) => taskFactsKey(held, capability))),
  };
}

/**
 * Decide one task for one Project at this wake. Answers the skip by name,
 * or null when the task should be dispatched. Pure over the facts it is handed
 * (read for this Project alone where none are) and the named conditions it asks.
 */
export async function decideTask(env: ServerEnv, projectId: string, lastReceivedAt: number | null, task: string, schedule: TaskSchedule, state: PowerState, leaves: Pick<ScheduleLeaves, 'activeWindowDays' | 'coldThresholdDays'>, now: number, facts?: ScheduleFacts): Promise<ScheduleSkip | null> {
  if (schedule.enabled === false) return 'disabled';
  if (lastReceivedAt === null || now - lastReceivedAt > leaves.activeWindowDays * DAY_MS) return 'quiet';
  if (schedule.runWhenCold !== true && now - lastReceivedAt > leaves.coldThresholdDays * DAY_MS) return 'cold';
  const held = facts ?? await readScheduleFacts(env, [task], now, projectId);
  const runs = held.runs.get(taskFactsKey(projectId, task)) ?? NO_RUNS;
  const gate = admissionForTask(task);
  if (gate?.kind === 'capability' && !held.capabilities.has(taskFactsKey(projectId, gate.capability))) return 'capability_off';
  if (schedule.overlap === 'skip' && runs.live) return 'already_running';

  const accelerator = schedule.accelerator === undefined ? undefined : declared(ACCELERATORS, schedule.accelerator.name);
  const count = schedule.accelerator !== undefined && accelerator !== undefined
    ? await accelerator({ db: env.db, projectId, limit: schedule.accelerator.thresholds.accelerated + 1 })
    : null;
  const intervalMs = effectiveIntervalSeconds(schedule.intervalSeconds, count, schedule.accelerator?.thresholds) * 1000;
  const last = runs.lastEntryAt;
  if (last !== null && now - last < intervalMs) return 'not_yet';

  if (!(schedule.runIn as readonly string[]).includes(state)) return 'not_in_state';
  if (schedule.preCondition !== undefined) {
    const check = declared(PRE_CONDITIONS, schedule.preCondition);
    if (check === undefined || !(await check({ db: env.db, projectId, now }))) return 'precondition';
  }
  if (schedule.maxRunsPerDay !== undefined) {
    const used = runs.entriesSince;
    if (used >= schedule.maxRunsPerDay) return 'max_runs_per_day';
    const reserve = schedule.reservedRunsPerDay;
    if (reserve !== undefined && used >= Math.max(0, schedule.maxRunsPerDay - reserve.count)) {
      const check = declared(PRE_CONDITIONS, reserve.preCondition);
      if (check === undefined || !(await check({ db: env.db, projectId, now }))) return 'reserved_runs_per_day';
    }
  }
  return null;
}

/**
 * One wake's scheduling. Every Project the Deployment holds is visited for
 * every scheduled task; a dispatch goes through the dispatcher like any other
 * and lands launched or queued. Deep sleep never reaches here: the tick runs
 * nothing at that depth.
 */
export async function runScheduledTasks(env: ServerEnv, state: PowerState, now: number, serverUrl: string): Promise<ScheduleReport> {
  const report: ScheduleReport = { dispatched: 0, skipped: 0 };
  const leaves = await scheduleLeaves(env);
  if (!leaves.enabled) return report;
  const tasks = scheduledTasks(leaves.overrides);
  if (tasks.length === 0) return report;
  const facts = await readScheduleFacts(env, tasks.map(({ task }) => task), now);
  for (const project of await listProjects(env.db)) {
    for (const { task, schedule } of tasks) {
      const skip = await decideTask(env, project.projectId, project.lastActivityAt, task, schedule, state, leaves, now, facts);
      if (skip === 'max_runs_per_day' || skip === 'reserved_runs_per_day') {
        // The entry that filled the window names the episode; it cannot move while the window stays full.
        const filledAt = facts.runs.get(taskFactsKey(project.projectId, task))?.lastEntryAt ?? null;
        await recordClockSkip(env, project.projectId, task, skip, ceilingSkipId(project.projectId, task, filledAt) + (skip === 'reserved_runs_per_day' ? '_reserved' : ''), now);
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip });
        report.skipped += 1;
        continue;
      }
      if (skip !== null) {
        if (skip !== 'not_yet' && skip !== 'quiet') emit({ kind: 'task_skipped', task, projectId: project.projectId, skip });
        continue;
      }
      const prepared = await prepareDispatch(env, task, project.projectId);
      if (!prepared.ok) {
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip: 'refused', refusal: prepared.refusal });
        continue;
      }
      // A task whose prompt the server builds is compared against the artifact
      // it last wrote: a Project that has not moved leaves a skipped row naming
      // that, and no model is called.
      const built = await buildTaskInput(env, task, project.projectId, now);
      if (built !== null && built.unchanged) {
        await recordClockSkip(env, project.projectId, task, INPUT_UNCHANGED, `run_${crypto.randomUUID()}`, now);
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip: INPUT_UNCHANGED });
        report.skipped += 1;
        continue;
      }
      const input: Pick<LaunchSpec, 'instruction' | 'inputHash' | 'counts'> = built === null || built.unchanged
        ? {}
        : { instruction: built.input.instruction, inputHash: built.input.inputHash, counts: built.input.counts };
      try {
        // A skip-overlap task's write refuses beside another live run of it: two wakes deciding at once write one row.
        const budget = runTimeoutForTask(task);
        const outcome = await dispatchPrepared(env, prepared.prepared, {
          serverUrl, actor: CLOCK_ACTOR, ...input, ...(budget === null ? {} : { timeoutSeconds: budget }),
        }, now, { singleFlight: schedule.overlap === 'skip' });
        emit({ kind: 'task_scheduled', task, projectId: project.projectId, runId: outcome.runId, queued: outcome.queued });
        report.dispatched += 1;
      } catch (err) {
        if (!(err instanceof AlreadyRunning)) throw err;
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip: 'already_running' });
      }
    }
  }
  return report;
}

