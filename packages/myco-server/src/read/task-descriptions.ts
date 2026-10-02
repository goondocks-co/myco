/** Read-only descriptions assembled from the definitions that govern task execution. */
import { callWords } from '@goondocks/myco-shared/call-words';
import { isReasoningTier, PROFILE_HARNESSES, type ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import type { ServerEnv } from '../core/adapters.js';
import { readMapSettings } from '../core/canopy.js';
import { PROFILE_SETTING_LEAVES, resolveExecutionProfile, taskOverride, taskTierRefusal } from '../core/execution-profile.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, harnessPreference, RUNTIME_SERVED_TASKS } from '../core/harness.js';
import { EMBEDDING_RETRY_MS } from '../core/embedding/jobs.js';
import { SERVER_JOBS, TASK_SCHEDULE, TITLING_BACKFILL_SCHEDULE, type TaskSchedule } from '../core/jobs.js';
import { readWindowFor, type ReadWindow } from '../core/read-window.js';
import { RUN_CLOSE_RULES } from '../core/run-postconditions.js';
import { ACCELERATORS, effectiveIntervalSeconds, PRE_CONDITIONS, scheduleFor, scheduleLeaves } from '../core/scheduled-tasks.js';
import { leafValues } from '../core/settings.js';
import { RETAINED_TASKS, TASK_TOOLS, TASK_TIERS, TASK_WORDS, runTimeoutForTask, TITLING_TASK } from '../core/task-catalogue.js';
import { inputBuilderFor, type TaskTemplate } from '../core/task-inputs.js';
import { runAllowlist } from '../mcp/run-surface.js';

export interface TaskDescription {
  task: string;
  name: string;
  description: string;
  triggers: readonly string[];
  tools: readonly string[];
  done: readonly string[];
  budget: { timeoutSeconds: number; readWindow: ReadWindow };
  tier: ReasoningTier | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
  profileNote: string | null;
  promptTemplate: string | null;
  standingRules: string | null;
  templateVariants: readonly { name: string; prompt: string }[];
}

/** The launch builder owns its template; runtime tasks carry no server-built prompt. */
export function taskTemplate(task: string, patterns: readonly string[]): TaskTemplate {
  const builder = inputBuilderFor(task);
  if (builder !== null) return builder.template(patterns);
  if (!RUNTIME_SERVED_TASKS.includes(task)) throw new Error(`No task template for ${task}`);
  return { promptTemplate: null, standingRules: null, templateVariants: [] };
}

/** A schedule's effective gates, without exposing its internal names as reader labels. */
export function scheduleWords(schedule: TaskSchedule, enabled: boolean): string[] {
  const minutes = schedule.intervalSeconds / 60;
  const period = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;
  const words = [`At least ${period} between runs; ${enabled && schedule.enabled !== false ? 'on' : 'off'} in Settings.`, `Runs while Myco is ${schedule.runIn.join(' or ')}.`];
  if (schedule.maxRunsPerDay !== undefined) words.push(`At most ${schedule.maxRunsPerDay} runs in a day.`);
  if (schedule.preCondition !== undefined) words.push(PRE_CONDITIONS[schedule.preCondition]?.description ?? 'The chosen condition is unavailable. Correct it in Settings.');
  if (schedule.accelerator !== undefined && Object.hasOwn(ACCELERATORS, schedule.accelerator.name)) {
    const thresholds = schedule.accelerator.thresholds;
    words.push(`With more than ${thresholds.steady} pending items, the wait shortens to ${effectiveIntervalSeconds(schedule.intervalSeconds, thresholds.steady + 1, thresholds)} seconds; with more than ${thresholds.accelerated}, to ${effectiveIntervalSeconds(schedule.intervalSeconds, thresholds.accelerated + 1, thresholds)} seconds.`);
  }
  if (schedule.reservedRunsPerDay !== undefined) {
    words.push(`${schedule.reservedRunsPerDay.count} daily runs are reserved. ${PRE_CONDITIONS[schedule.reservedRunsPerDay.preCondition]?.description ?? 'The chosen condition is unavailable. Correct it in Settings.'}`);
  }
  words.push(schedule.overlap === 'skip' ? 'Waits until the project’s previous run of this task ends.' : 'Another run may wait for its turn.');
  return words;
}

/** The requested profile for the preferred agent under effective settings. */
export function descriptionProfile(task: string, settings: ReadonlyMap<string, string>): Pick<TaskDescription, 'tier' | 'harness' | 'model' | 'effort' | 'profileNote'> {
  if (RUNTIME_SERVED_TASKS.includes(task)) return { tier: null, harness: null, model: null, effort: null, profileNote: 'This task does not use a reasoning tier or a server-built prompt.' };
  if (taskTierRefusal(task, settings) !== null) return { tier: null, harness: null, model: null, effort: null, profileNote: 'This task’s tier is invalid. Correct it in Settings.' };
  const override = taskOverride(settings, task).reasoningLevel;
  const tier = override === undefined ? TASK_TIERS[task] : override;
  const preference = harnessPreference(settings, task);
  const harness = preference.override ?? preference.preferred ?? preference.fallback[0] ?? null;
  const base = { tier: isReasoningTier(tier) ? tier : null, harness, model: null, effort: null };
  if (harness === null) return { ...base, profileNote: 'Choose a preferred agent in Settings to see its model. The worker’s available agents decide at launch.' };
  const defaults = PROFILE_HARNESSES[harness];
  const resolved = resolveExecutionProfile(task, harness, defaults === undefined ? undefined : { model: defaults.allowedEfforts.length === 0 ? 'none' : 'flag', efforts: defaults.allowedEfforts }, settings);
  if ('reason' in resolved) return { ...base, profileNote: 'The requested model cannot be resolved. Check this task’s tier and the agent’s model and effort in Settings.' };
  return { tier: resolved.profile.tier, harness, model: resolved.profile.model, effort: resolved.profile.effort, profileNote: 'Requested for the preferred agent. The worker may use a configured fallback at launch.' };
}

/** Every task the Deployment can run, under its effective settings. */
export async function readTaskDescriptions(env: ServerEnv): Promise<TaskDescription[]> {
  const [settings, leaves, mapSettings] = await Promise.all([
    leafValues(env.db, ['worker.harness', 'worker.harness_fallback', 'agent.tasks', ...PROFILE_SETTING_LEAVES]),
    scheduleLeaves(env), readMapSettings(env.db),
  ]);
  return RETAINED_TASKS.map((task) => {
    const words = TASK_WORDS[task];
    const close = RUN_CLOSE_RULES[task];
    if (words === undefined || close === undefined || close.description.length === 0 || TASK_TOOLS[task] === undefined) throw new Error(`Incomplete task description: ${task}`);
    const declared = TASK_SCHEDULE[task];
    const schedule = declared == null ? null : scheduleFor(task, declared, leaves.overrides);
    const triggers = schedule === null ? [] : [
      ...scheduleWords(schedule, leaves.enabled),
      `Only for projects with session material in the last ${leaves.activeWindowDays} days.`,
      ...(schedule.runWhenCold === true ? [] : [`Waits if the project has been quiet for more than ${leaves.coldThresholdDays} days.`]),
    ];
    if (task === TITLING_TASK) triggers.push('After a session ends and its material is ready.', 'When a person asks for a fresh session title.', ...scheduleWords(scheduleFor(task, TITLING_BACKFILL_SCHEDULE, leaves.overrides), leaves.enabled).map((line) => `Untitled past sessions: ${line}`));
    else if (!RUNTIME_SERVED_TASKS.includes(task)) triggers.push('When a person chooses Run a task.');
    else if (task === 'embedding-reconcile') {
      const job = SERVER_JOBS.find((job) => job.name === task);
      if (job === undefined) throw new Error(`No upkeep job for ${task}`);
      triggers.push(`When the search index has pending work, while Myco is ${job.runsThrough} or more awake. At least ${EMBEDDING_RETRY_MS / 1000} seconds between runs.`);
    }
    const allowlist = runAllowlist(TASK_TOOLS[task], { dryRun: false });
    const tools = [...new Set([...allowlist].flatMap(([tool, ops]) => [...ops].map((op) => callWords(tool, op))))];
    return {
      task, ...words, triggers, tools, done: close.description,
      budget: { timeoutSeconds: runTimeoutForTask(task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS, readWindow: readWindowFor(task) },
      ...descriptionProfile(task, settings), ...taskTemplate(task, [...mapSettings.defaultPatterns, ...mapSettings.userPatterns]),
    };
  });
}
