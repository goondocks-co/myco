/** Read-only descriptions assembled from the definitions that govern task execution. */
import { callWords } from '@goondocks/myco-shared/call-words';
import { isReasoningTier, OFFERABLE_PROFILE_HARNESSES, PROFILE_HARNESSES, type ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import { holdSentence } from '@goondocks/myco-shared/run-holds';
import { POWER_STATE_DEPTH, type PowerState } from '../core/power.js';
import { listProjects } from './sessions.js';
import type { ProjectSet } from './scope.js';
import type { ServerEnv } from '../core/adapters.js';
import { readMapSettings } from '../core/canopy.js';
import { resolveExecutionProfile, taskOverride, taskTierRefusal } from '../core/execution-profile.js';
import { capabilityOf, claimSettings, DEFAULT_DISPATCH_TIMEOUT_SECONDS, harnessPreference, RUNTIME_SERVED_TASKS } from '../core/worker-selection.js';
import { EMBEDDING_RETRY_MS } from '../core/embedding/task.js';
import { SERVER_JOBS, TASK_SCHEDULE, TITLING_BACKFILL_SCHEDULE, type TaskSchedule } from '../core/jobs.js';
import { readWindowFor, type ReadWindow } from '../core/read-window.js';
import { RUN_CLOSE_RULES } from '../core/run-postconditions.js';
import { ACCELERATORS, effectiveIntervalSeconds, PRE_CONDITIONS, scheduleFor, scheduleLeaves } from '../core/schedule-rules.js';
import { enabledCapabilities } from '../core/settings.js';
import { RETAINED_TASKS, TASK_TOOLS, TASK_TIERS, TASK_WORDS, runTimeoutForTask, TITLING_TASK } from '../core/task-catalogue.js';
import { inputBuilderFor, type TaskTemplate } from '../core/task-inputs.js';
import { runAllowlist } from '../mcp/run-allowlist.js';

export interface TaskDescription {
  task: string;
  name: string;
  description: string;
  triggers: readonly string[];
  tools: readonly string[];
  done: readonly string[];
  budget: { timeoutSeconds: number; readWindow: ReadWindow } | null;
  tier: ReasoningTier | null;
  profiles: readonly { harness: string; model: string | null; effort: string | null; note: string | null }[];
  availabilityNote: string | null;
  /** A person may start it by hand from Run a task. */
  startable: boolean;
  /** The capability a project turns on for it to run there, or null for a task no capability gates. */
  capability: string | null;
  profileNote: string | null;
  promptTemplate: string | null;
  standingRules: string | null;
  templateVariants: readonly { name: string; prompt: string }[];
}

/** Whether a person may start the task by hand from Run a task: every worker-served task but titling, which a person asks for one session at a time. */
export const startableByHand = (task: string): boolean => (RETAINED_TASKS as readonly string[]).includes(task) && !RUNTIME_SERVED_TASKS.includes(task) && task !== TITLING_TASK;

/** The launch builder owns its template; runtime tasks carry no server-built prompt. */
export function taskTemplate(task: string, patterns: readonly string[]): TaskTemplate {
  const builder = inputBuilderFor(task);
  if (builder !== null) return builder.template(patterns);
  if (!RUNTIME_SERVED_TASKS.includes(task)) throw new Error(`No task template for ${task}`);
  return { promptTemplate: null, standingRules: null, templateVariants: [] };
}

/** A count and its unit in reader words. */
export const unitWords = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`;
const STATE_WORDS: Readonly<Record<PowerState, string>> = { active: 'in use', idle: 'idle', sleep: 'asleep', deep_sleep: 'deeply asleep' };

/** A schedule's effective gates in reader words. */
export function scheduleWords(schedule: TaskSchedule, enabled: boolean): string[] {
  const minutes = schedule.intervalSeconds / 60;
  const period = minutes >= 60 && minutes % 60 === 0 ? unitWords(minutes / 60, 'hour') : unitWords(minutes, 'minute');
  const words = [`At least ${period} between runs; ${enabled && schedule.enabled !== false ? 'on' : 'off'} in Settings.`, `Runs while Myco is ${schedule.runIn.map((state) => STATE_WORDS[state]).join(' or ')}.`];
  if (schedule.maxRunsPerDay !== undefined) words.push(`At most ${schedule.maxRunsPerDay} runs in a day.`);
  if (schedule.preCondition !== undefined) words.push(PRE_CONDITIONS[schedule.preCondition]?.description ?? 'The chosen condition is unavailable. Correct it in Settings.');
  if (schedule.accelerator !== undefined && Object.hasOwn(ACCELERATORS, schedule.accelerator.name)) {
    const thresholds = schedule.accelerator.thresholds;
    words.push(`With more than ${thresholds.steady} pending items, the wait shortens to ${unitWords(effectiveIntervalSeconds(schedule.intervalSeconds, thresholds.steady + 1, thresholds), 'second')}; with more than ${thresholds.accelerated}, to ${unitWords(effectiveIntervalSeconds(schedule.intervalSeconds, thresholds.accelerated + 1, thresholds), 'second')}.`);
  }
  if (schedule.reservedRunsPerDay !== undefined) {
    words.push(`${schedule.reservedRunsPerDay.count} daily runs are reserved. ${PRE_CONDITIONS[schedule.reservedRunsPerDay.preCondition]?.description ?? 'The chosen condition is unavailable. Correct it in Settings.'}`);
  }
  words.push(schedule.overlap === 'skip' ? 'Waits until the project’s previous run of this task ends.' : 'Another run may wait for its turn.');
  return words;
}

/** The requested profiles for the preferred agent or every offerable agent. */
export function descriptionProfile(task: string, settings: ReadonlyMap<string, string>): Pick<TaskDescription, 'tier' | 'profiles' | 'profileNote'> {
  if (RUNTIME_SERVED_TASKS.includes(task)) return { tier: null, profiles: [], profileNote: 'This task does not use a reasoning tier or a server-built prompt.' };
  const refusal = taskTierRefusal(task, settings);
  if (refusal !== null) return { tier: null, profiles: [], profileNote: holdSentence(refusal) };
  const override = taskOverride(settings, task).reasoningLevel;
  const tier = override === undefined ? TASK_TIERS[task] : override;
  const preference = harnessPreference(settings, task);
  const harness = preference.override ?? preference.preferred;
  const profiles = (harness === null ? OFFERABLE_PROFILE_HARNESSES : [harness]).map((harness) => {
    const defaults = PROFILE_HARNESSES[harness];
    const choice = defaults !== undefined && defaults.allowedEfforts.length > 0;
    const resolved = resolveExecutionProfile(task, harness, defaults === undefined ? undefined : { model: choice ? 'flag' : 'none', efforts: defaults.allowedEfforts }, settings);
    if ('reason' in resolved) return { harness, model: null, effort: null, note: holdSentence(resolved.reason) };
    return { harness, model: resolved.profile.model, effort: resolved.profile.effort, note: null };
  });
  return { tier: isReasoningTier(tier) ? tier : null, profiles, profileNote: harness === null
    ? 'Which agent runs it depends on what is signed in on your machines.'
    : 'A machine without this agent signed in may run it with the next agent in your fallback order.' };
}

/** Capability and admission gates for the Projects covered by this read. */
async function availabilityNotes(env: ServerEnv, set: ProjectSet): Promise<Map<string, string | null>> {
  const ids = set.all ? (await listProjects(env.db)).map((project) => project.projectId) : set.projectIds;
  const required = [...new Set(RETAINED_TASKS.map(capabilityOf).filter((capability) => capability !== null))];
  const capabilities = enabledCapabilities(env.db, required);
  const enabled = capabilities.read((await capabilities.statement.all<Record<string, unknown>>()).results);
  const projectsByCapability = new Map(required.map((capability) => [capability, new Set(enabled.filter((row) => row.capability === capability).map((row) => row.projectId))]));
  const embeddingAvailable = env.vectors !== undefined && await env.embeddingProvider?.() != null;
  const notes = await Promise.all(RETAINED_TASKS.map(async (task) => {
    const capability = capabilityOf(task);
    if (capability === null) {
      if (task === 'embedding-reconcile') return [task, embeddingAvailable ? null : 'Search for similar knowledge is unavailable on this server.'] as const;
      return [task, null] as const;
    }
    const off = ids.filter((projectId) => !projectsByCapability.get(capability)?.has(projectId)).length;
    const note = off === 0 ? null : ids.length === 1 ? 'Switched off for this project'
      : off === ids.length ? 'Switched off for every project' : `Switched off for ${off} of ${ids.length} selected projects`;
    return [task, note] as const;
  }));
  return new Map(notes);
}

/** A lightweight projection of the canonical task words. */
export const readTaskNames = () => RETAINED_TASKS.map((task) => ({ task, name: TASK_WORDS[task].name }));

/** Every task the Deployment can run, under its effective settings. */
export async function readTaskDescriptions(env: ServerEnv, set: ProjectSet): Promise<TaskDescription[]> {
  const [settings, leaves, mapSettings, availability] = await Promise.all([
    claimSettings(env),
    scheduleLeaves(env), readMapSettings(env.db), availabilityNotes(env, set),
  ]);
  return RETAINED_TASKS.map((task) => {
    const words = TASK_WORDS[task];
    const close = RUN_CLOSE_RULES[task];
    if (words === undefined || close === undefined || close.description.length === 0 || TASK_TOOLS[task] === undefined) throw new Error(`Incomplete task description: ${task}`);
    const runtimeServed = RUNTIME_SERVED_TASKS.includes(task);
    const declared = TASK_SCHEDULE[task];
    const schedule = declared == null ? null : scheduleFor(task, declared, leaves.overrides);
    const triggers = schedule === null ? [] : [
      ...scheduleWords(schedule, leaves.enabled),
      ...(runtimeServed ? [] : [`Only for projects with session material in the last ${leaves.activeWindowDays} days.`,
        ...(schedule.runWhenCold === true ? [] : [`Waits if the project has been quiet for more than ${leaves.coldThresholdDays} days.`])]),
    ];
    if (task === TITLING_TASK) triggers.push('After a session ends and its material is ready.', 'When a person asks for a fresh session title.', ...scheduleWords(scheduleFor(task, TITLING_BACKFILL_SCHEDULE, leaves.overrides), leaves.enabled).map((line) => `Untitled past sessions: ${line}`));
    else if (startableByHand(task)) triggers.push('When a person chooses Run a task.');
    else if (task === 'embedding-reconcile') {
      const job = SERVER_JOBS.find((job) => job.name === task);
      if (job === undefined) throw new Error(`No upkeep job for ${task}`);
      const states = Object.keys(POWER_STATE_DEPTH).filter((state) => POWER_STATE_DEPTH[state as PowerState] <= POWER_STATE_DEPTH[job.runsThrough]).reverse().map((state) => STATE_WORDS[state as PowerState]);
      triggers.push(`When the search index has pending work and Myco is ${states.join(' or ')}. At least ${unitWords(EMBEDDING_RETRY_MS / 1000, 'second')} between runs.`);
    } else triggers.push('When a person requests this task.');
    const allowlist = runAllowlist(TASK_TOOLS[task], { dryRun: false });
    const tools = runtimeServed ? [] : [...new Set([...allowlist].flatMap(([tool, ops]) => [...ops].map((op) => callWords(tool, op))))];
    return {
      task, ...words, triggers, tools, done: close.description, startable: startableByHand(task), capability: capabilityOf(task),
      availabilityNote: availability.get(task) ?? null,
      budget: runtimeServed ? null : { timeoutSeconds: runTimeoutForTask(task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS, readWindow: readWindowFor(task) },
      ...descriptionProfile(task, settings), ...taskTemplate(task, [...mapSettings.defaultPatterns, ...mapSettings.userPatterns]),
    };
  });
}
