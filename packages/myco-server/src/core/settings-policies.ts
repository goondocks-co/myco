/**
 * The settings contract: every live Deployment leaf bound to the policy that acts on it.
 *
 * A policy's `resolve` asks the consumer's own resolver — the function the scheduler, the dispatcher, recall, search
 * or a job calls before it acts — what each of its leaves means now. The settings surface answers from that, so the
 * effective value a person reads is the value the consumer acts on, never a second copy of its default.
 *
 * Stored values are judged by each leaf's rule (`DEPLOYMENT_LEAF_SPECS`). A consumer reads through `settingTexts`,
 * which hands it only values that hold their rule, or through `storedSettings` where a refused value must not fall
 * back to a default that deletes or stops more: retention and backups then keep everything, clamp, or hold. Either
 * way a stored value the rule refuses is reported invalid here, with what applies instead. A self-judged policy
 * reports its own leaves' states whole. Only a policy's `owners` read the settings table.
 */
import {
  DEPLOYMENT_TARGETS, EMBEDDING_CATALOGUE, embeddingProvidersFor,
  type DeploymentTarget, type EffectiveSetting, type EmbeddingChoices, type EmbeddingProviderChoice, type SettingSource, type SettingState,
} from '@goondocks/myco-shared/settings-contract';
import { CONFIGURABLE_PROFILE_HARNESSES, PROFILE_HARNESSES, REASONING_TIERS } from '@goondocks/myco-shared/execution-profile';
import type { ServerEnv } from './adapters.js';
import {
  DEPLOYMENT_LEAF_SPECS, DEPLOYMENT_LEAVES, RETIRED_LEAVES, executionProfileLeafDefault, heldPartitions, leafRuleViolation,
  leafResets, settingsSnapshot, settingsWriter, storedEmbedding, storedSettings, switchUnderWay, taskOverridesResolution, type LeafRecord,
} from './settings.js';
import { scheduleLeaves, scheduleFor, memberRunsPerDay } from './scheduled-tasks.js';
import { TASK_SCHEDULE, TITLING_BACKFILL_SCHEDULE } from './jobs.js';
import { readDispatchLimits, LIMIT_LEAVES } from './limits.js';
import { workerPreference } from './harness.js';
import { readRecallLeaves } from './recall.js';
import { readMapSettings } from './canopy.js';
import { ACCELERATORS, PRE_CONDITIONS } from './schedule-rules.js';
import { TITLING_TASK } from './task-catalogue.js';
import { reconcileIntervalMinutes } from './release-provenance.js';
import { runRetentionDays } from './jobs-run.js';
import { scheduledIntervalHours } from './recovery-schedule.js';
import { keptStagings } from './staging-retention.js';
import { backupRetentionPolicy } from './backup-retention.js';
import { cadenceOf, MAINTENANCE_CHECKS, MAINTENANCE_SETTINGS } from './store-maintenance.js';
import { importPolicy } from './import-policy.js';
import { transcriptRetentionFact } from '../ingest/retention.js';
import { autoCreateProjects } from '../api/member-projects.js';
import { keepsEmbeddingWhileIdle } from './embedding/jobs.js';
import { embeddingResolution, type EmbeddingPlatform } from './embedding/configured-provider.js';
import { SWITCH_REFUSAL, resolveEmbedding, selectionChangeRefusal, tooLargeRefusal, type HeldPartition } from './embedding/policy.js';
import { embeddingSwitchStatus } from './embedding/switch.js';
import { VECTOR_DIMENSIONS } from './embedding/vectors.js';

/** What a policy's consumer makes of one leaf now. Unset fields take the leaf's generic answer. */
export interface LeafAnswer {
  effective: unknown;
  source?: SettingSource;
  state?: SettingState;
  reason?: string | null;
  appliesTo?: readonly DeploymentTarget[];
  /** What applies while the stored value breaks the leaf's rule, in words; absent, the default does. */
  meanwhile?: string;
}

export interface SettingPolicy {
  id: string;
  leaves: readonly string[];
  /** The modules, under the server's `src`, that read these leaves from the settings table: the consumers' own resolvers. */
  owners: readonly string[];
  /** The policy reports its leaves' states whole, judging stored values itself. */
  selfJudged?: true;
  resolve(env: ServerEnv): Promise<Readonly<Record<string, LeafAnswer>>>;
}

const SCHEDULE_OFF = 'Work on a schedule is off, so this waits until it is turned on.';

/** The embedding platform a Deployment resolves against. */
export const embeddingPlatformOf = (env: ServerEnv): EmbeddingPlatform => env.embeddingPlatform ?? { target: env.platform.name };

const scheduling: SettingPolicy = {
  id: 'scheduling',
  owners: ['core/schedule-rules.ts'],
  leaves: ['agent.scheduled_tasks_enabled', 'agent.scheduled_tasks_active_window_days', 'agent.cold_project_threshold_days',
    'cortex.canopy.refresh.background_enabled', 'cortex.canopy.refresh.background_period_minutes'],
  async resolve(env) {
    const leaves = await scheduleLeaves(env);
    const off = leaves.enabled ? {} : { state: 'inactive' as const, reason: SCHEDULE_OFF };
    const map = leaves.mapRefresh;
    const minutes = map.intervalSeconds / 60;
    return {
      'agent.scheduled_tasks_enabled': { effective: leaves.enabled },
      'agent.scheduled_tasks_active_window_days': { effective: leaves.activeWindowDays, ...off },
      'agent.cold_project_threshold_days': { effective: leaves.coldThresholdDays, ...off },
      'cortex.canopy.refresh.background_enabled': map.overridden.enabled
        ? { effective: false, source: 'task-override', state: 'inactive', reason: 'The code map task’s own schedule is off under Per-task overrides.' }
        : { effective: map.enabled, ...off },
      'cortex.canopy.refresh.background_period_minutes': map.overridden.interval
        ? { effective: minutes, source: 'task-override', state: 'inactive', reason: `Per-task overrides set the code map to every ${minutes} minutes.` }
        : !map.enabled ? { effective: minutes, state: 'inactive', reason: leaves.enabled ? 'The map is not updated on its own.' : SCHEDULE_OFF }
          : { effective: minutes, meanwhile: `The map updates every ${minutes} minutes` },
    };
  },
};

const limits: SettingPolicy = {
  id: 'limits',
  owners: ['core/limits.ts'],
  leaves: Object.values(LIMIT_LEAVES),
  async resolve(env) {
    const set = await readDispatchLimits(env);
    const answer = (n: number | null): LeafAnswer => ({ effective: n, meanwhile: 'No limit applies', ...(n === null ? { reason: 'No limit applies.' } : {}) });
    return {
      [LIMIT_LEAVES.concurrent_runs]: answer(set.concurrent_runs),
      [LIMIT_LEAVES.task_concurrent_runs]: answer(set.task_concurrent_runs),
      [LIMIT_LEAVES.task_runs_per_hour]: answer(set.task_runs_per_hour),
    };
  },
};

const workers: SettingPolicy = {
  id: 'workers',
  owners: ['core/worker-selection.ts'],
  leaves: ['worker.harness', 'worker.harness_fallback'],
  async resolve(env) {
    const { preferred, fallback } = await workerPreference(env);
    return {
      'worker.harness': { effective: preferred, ...(preferred === null ? { reason: 'Myco uses the first agent this machine is signed in to.' } : {}) },
      'worker.harness_fallback': { effective: fallback },
    };
  },
};

const context: SettingPolicy = {
  id: 'context',
  owners: ['core/recall.ts', 'core/injection.ts'],
  leaves: ['instructions.template', 'cortex.instructions.inject_on_session_start', 'cortex.instructions.inject_on_subagent_start',
    'cortex.spores.inject_on_prompt_submit', 'cortex.spores.max_per_prompt', 'cortex.plans.inject_intent_nudge_on_prompt_submit'],
  async resolve(env) {
    const recall = await readRecallLeaves(env.db);
    const noText = recall.instructionsTemplate === '' ? { state: 'inactive' as const, reason: 'No session-start instructions are written.' } : {};
    const sporesOff = recall.injection.enabled ? {} : { state: 'inactive' as const, reason: 'Spores on every prompt is off.' };
    return {
      'instructions.template': { effective: recall.instructionsTemplate },
      'cortex.instructions.inject_on_session_start': { effective: recall.instructionsAtSessionStart, ...noText },
      'cortex.instructions.inject_on_subagent_start': { effective: recall.instructionsAtSubagentStart, ...noText },
      'cortex.spores.inject_on_prompt_submit': { effective: recall.injection.enabled },
      'cortex.spores.max_per_prompt': { effective: recall.injection.maxPerPrompt, ...sporesOff },
      'cortex.plans.inject_intent_nudge_on_prompt_submit': { effective: recall.planNudge },
    };
  },
};

const codeMap: SettingPolicy = {
  id: 'code-map',
  owners: ['core/canopy.ts'],
  leaves: ['cortex.canopy.exclude.patterns'],
  async resolve(env) {
    return { 'cortex.canopy.exclude.patterns': { effective: (await readMapSettings(env.db)).userPatterns } };
  },
};

const releases: SettingPolicy = {
  id: 'releases',
  owners: ['core/release-provenance.ts'],
  leaves: ['release_provenance.reconcile_interval_minutes'],
  async resolve(env) {
    return { 'release_provenance.reconcile_interval_minutes': { effective: await reconcileIntervalMinutes(env.db) } };
  },
};

const records: SettingPolicy = {
  id: 'records',
  owners: ['core/jobs-run.ts', 'ingest/retention.ts'],
  leaves: ['agent.run_retention_days', 'retention.transcripts','retention.raw_days'],
  async resolve(env) {
    const fact = await transcriptRetentionFact(env.db);
    const days = await runRetentionDays(env);
    return {
      'agent.run_retention_days': { effective: days, meanwhile: `Task records are kept for ${days} days` },
      'retention.transcripts': fact.state === 'days' ? { effective: fact.days, meanwhile:'Raw content is preserved in archive storage.' } : { effective: null, reason: fact.state==='forever'?'A legacy forever choice holds archival.':fact.reason, meanwhile:'Raw content remains held.' },
      'retention.raw_days': fact.state==='days' ? { effective:fact.days,reason:fact.compatibility==='default'?'The default raw window is 90 days.':fact.compatibility==='legacy-finite'?'The finite legacy window supplies this value.':undefined } : { effective:null,reason:fact.state==='forever'?'Set a finite raw window to release the legacy hold.':fact.reason,meanwhile:'Raw content remains held.' },
    };
  },
};

const backups: SettingPolicy = {
  id: 'backups',
  owners: ['core/recovery-schedule.ts', 'core/staging-retention.ts', 'core/backup-retention.ts'],
  leaves: ['backup.auto_interval_hours', 'backup.recovery.keep_stagings', 'backup.retention.keep_daily', 'backup.retention.keep_weekly'],
  async resolve(env) {
    const interval = await scheduledIntervalHours(env);
    const noProducer = env.recovery === undefined ? { state: 'inactive' as const, reason: 'This server makes no recovery copies.' } : {};
    const retention = await backupRetentionPolicy(env.db);
    const kept = await keptStagings(env.db);
    const off = retention.keepDaily < 1 ? { effective: null, meanwhile: 'No manual export is removed' } : null;
    return {
      'backup.auto_interval_hours': { effective: interval, meanwhile: `Backups run every ${interval} hours`, ...(interval === null ? { reason: 'Automatic backups are off.' } : {}), ...noProducer },
      'backup.recovery.keep_stagings': { effective: kept, meanwhile: 'No recovery copy is released', ...noProducer },
      'backup.retention.keep_daily': off ?? { effective: retention.keepDaily },
      'backup.retention.keep_weekly': off ?? { effective: retention.keepWeekly },
    };
  },
};

const maintenance: SettingPolicy = {
  id: 'maintenance',
  owners: ['core/store-maintenance.ts'],
  leaves: MAINTENANCE_CHECKS.flatMap((check) => [MAINTENANCE_SETTINGS[check].enabled, MAINTENANCE_SETTINGS[check].interval]),
  async resolve(env) {
    const out: Record<string, LeafAnswer> = {};
    const unsupported = env.storeMaintenance === undefined ? { state: 'inactive' as const, reason: 'This server runs no store checks.' } : {};
    for (const check of MAINTENANCE_CHECKS) {
      const spec = MAINTENANCE_SETTINGS[check];
      const cadence = await cadenceOf(env, check);
      const on = cadence.state === 'on' || (cadence.state === 'not_configured' && cadence.leaf === spec.interval)
        || (cadence.state === 'invalid' && cadence.leaf === spec.interval);
      out[spec.enabled] = { effective: on, ...(on && cadence.state !== 'on' ? { state: 'inactive', reason: 'Nothing runs until an interval is set.' } : {}), ...unsupported };
      out[spec.interval] = cadence.state === 'on' ? { effective: cadence.intervalHours, ...unsupported }
        : { effective: null, state: 'inactive', reason: on ? 'Not set: nothing runs until an interval is set.' : 'The check is off.' };
    }
    return out;
  },
};

const capture: SettingPolicy = {
  id: 'capture',
  owners: ['api/member-projects.ts', 'core/import-policy.ts'],
  leaves: ['capture.auto_create_projects', 'import.enabled', 'import.window_days', 'import.max_sessions_per_harness'],
  async resolve(env) {
    const policy = await importPolicy(env.db);
    const off = policy.enabled ? {} : { state: 'inactive' as const, reason: 'Importing past sessions is off.' };
    return {
      'capture.auto_create_projects': { effective: await autoCreateProjects(env.db) },
      'import.enabled': { effective: policy.enabled },
      'import.window_days': { effective: policy.windowDays, ...off },
      'import.max_sessions_per_harness': { effective: policy.maxPerAgent, ...off },
    };
  },
};

const embedding: SettingPolicy = {
  id: 'embedding',
  owners: ['core/embedding/configured-provider.ts', 'core/embedding/jobs.ts', 'core/embedding/switch.ts'],
  leaves: ['embedding.provider', 'embedding.model', 'embedding.base_url', 'embedding.prevent_deep_sleep'],
  selfJudged: true,
  async resolve(env) {
    const resolution = await embeddingResolution(env.db, env.wrappingKey, embeddingPlatformOf(env));
    const keep = await keepsEmbeddingWhileIdle(env.db);
    const applies = (leaf: 'embedding.provider' | 'embedding.model' | 'embedding.base_url'): readonly DeploymentTarget[] =>
      leaf === 'embedding.base_url' ? DEPLOYMENT_TARGETS.filter((t) => embeddingProvidersFor(t).some((id) => EMBEDDING_CATALOGUE[id].endpoint.editable)) : DEPLOYMENT_TARGETS;
    const keepHeld = (await storedSettings(env.db, ['embedding.prevent_deep_sleep'])).get('embedding.prevent_deep_sleep');
    const keepViolation = keepHeld?.violation ?? null;
    return {
      ...Object.fromEntries((['embedding.provider', 'embedding.model', 'embedding.base_url'] as const).map((leaf) => [leaf, { ...resolution.leaves[leaf], appliesTo: applies(leaf) }])),
      'embedding.prevent_deep_sleep': keepViolation !== null
        ? { effective: keep, source: 'invalid', state: 'invalid', reason: `${keepViolation}. Reset it to keep embedding while idle, or correct it.` }
        : { effective: keep, source: keepHeld === undefined ? 'default' : 'configured',
          ...(resolution.selection === null ? { state: 'inactive', reason: resolution.reason ?? `No embedding provider is in use on this server.` } : { state: 'active' }) },
    };
  },
};

/** Execution profiles hold the task they name while a stored value is unusable, so they report it as nothing in effect. */
const executionProfiles: SettingPolicy = {
  id: 'execution-profiles',
  owners: ['core/worker-selection.ts', 'core/runtime-probe.ts'],
  leaves: CONFIGURABLE_PROFILE_HARNESSES.flatMap((harness) => [
    ...REASONING_TIERS.flatMap((tier) => [`agent.reasoning_map.${harness}.${tier}`, `agent.effort_map.${harness}.${tier}`]),
    `agent.harnesses.${harness}.credential`,
  ]),
  selfJudged: true,
  async resolve(env) {
    const stored = await settingsWriter(env.db).leaves();
    return Object.fromEntries(executionProfiles.leaves.map((leaf) => {
      const fallback = executionProfileLeafDefault(leaf, env.harnessCredentialSource)!;
      const held = stored[leaf];
      const violation = held === undefined ? null : held.malformed ? 'The stored value does not read' : leafRuleViolation(DEPLOYMENT_LEAF_SPECS[leaf]!, held.value);
      if (violation !== null) return [leaf, { effective: null, source: 'invalid', state: 'invalid', reason: `${violation}. Correct this setting or reset it.` }];
      if (held !== undefined) return [leaf, { effective: held.value, source: 'configured', state: 'active' }];
      return [leaf, fallback.present
        ? { effective: fallback.value, source: 'default', state: 'active' }
        : { effective: null, source: 'unset', state: 'inactive', reason: `Runs at this tier wait until a model is set. ${PROFILE_HARNESSES[leaf.split('.')[2]!]?.modelHint ?? ''}`.trim() }];
    }));
  },
};

/** Task overrides apply entry by entry; a malformed entry holds its own task, as `taskTiers` reports. */
const taskOverrides: SettingPolicy = {
  id: 'task-overrides',
  owners: ['core/worker-selection.ts', 'core/schedule-rules.ts'],
  leaves: ['agent.tasks'],
  selfJudged: true,
  async resolve(env) {
    const held = (await settingsWriter(env.db).leaves())['agent.tasks'];
    if (held === undefined) return { 'agent.tasks': { effective: {}, source: 'default', state: 'active', reason: 'No task overrides are stored.' } };
    if (held.malformed) return { 'agent.tasks': { effective: null, source: 'invalid', state: 'invalid', reason: 'The stored value does not read. Worker tasks wait for a valid overrides object; scheduling uses the declared task defaults. Clear or reset the stored value to restore defaults.' } };
    const resolution = taskOverridesResolution(held.value);
    if (resolution.effective !== null && typeof resolution.effective === 'object') {
      const tasks = resolution.effective as Record<string, Record<string, unknown> | null>;
      const schedules = await scheduleLeaves(env);
      for (const [task, entry] of Object.entries(tasks)) {
        if (entry === null || entry.schedule === undefined) continue;
        const declared = task === TITLING_TASK ? TITLING_BACKFILL_SCHEDULE : TASK_SCHEDULE[task];
        if (declared === undefined || declared === null) {
          delete entry.schedule;
          resolution.reasons.push(`${task}.schedule: this task has no declared schedule; the stored schedule does not apply.`);
          continue;
        }
        const original = entry.schedule as Record<string, unknown>;
        const accelerator = original.accelerator;
        if (accelerator !== null && typeof accelerator === 'object' && !Object.hasOwn(ACCELERATORS, String((accelerator as Record<string, unknown>).name))) {
          delete original.accelerator;
          resolution.reasons.push(`${task}.schedule.accelerator: no accelerator named ${JSON.stringify((accelerator as Record<string, unknown>).name)} exists; the ordinary interval applies.`);
        }
        if (typeof original.preCondition === 'string' && !Object.hasOwn(PRE_CONDITIONS, original.preCondition)) {
          original.preCondition = null;
          resolution.invalid = true;
          resolution.reasons.push(`${task}.schedule.preCondition: this condition does not exist; scheduled work waits for a valid condition.`);
        }
        const reserved = original.reservedRunsPerDay;
        const invalidReserve = reserved !== null && typeof reserved === 'object' && typeof (reserved as Record<string, unknown>).preCondition === 'string'
          && !Object.hasOwn(PRE_CONDITIONS, (reserved as Record<string, unknown>).preCondition as string);
        if (invalidReserve) {
          original.reservedRunsPerDay = { ...(reserved as Record<string, unknown>), preCondition: null };
          resolution.invalid = true;
          resolution.reasons.push(`${task}.schedule.reservedRunsPerDay.preCondition: this condition does not exist; the reserved slots wait for a valid condition.`);
        }
        const actual = scheduleFor(task, declared, schedules.overrides) as unknown as Record<string, unknown>;
        const storedSchedule = entry.schedule as Record<string, unknown>;
        for (const [key, value] of Object.entries(storedSchedule)) {
          if ((key === 'preCondition' && value === null) || (key === 'reservedRunsPerDay' && invalidReserve)) continue;
          const running = key === 'memberRunsPerDay' ? await memberRunsPerDay(env, task) : actual[key] ?? null;
          if (JSON.stringify(value) !== JSON.stringify(running)) {
            storedSchedule[key] = running;
            resolution.invalid = true;
            resolution.reasons.push(`${task}.schedule.${key}: stored ${JSON.stringify(value)} does not apply; the scheduler uses ${JSON.stringify(running)}.`);
          }
        }
      }
    }
    return { 'agent.tasks': { effective: resolution.effective, source: resolution.invalid ? 'invalid' : 'configured', state: resolution.invalid ? 'invalid' : resolution.reasons.length > 0 ? 'not-applicable' : 'active',
      reason: resolution.reasons.length > 0 ? resolution.reasons.join(' ') : null } };
  },
};

/** Every live leaf's policy. A leaf belongs to exactly one, and every live leaf to one: the contract gate holds both. */
export const SETTING_POLICIES: readonly SettingPolicy[] = [
  scheduling, limits, workers, context, codeMap, releases, records, backups, maintenance, capture, embedding, executionProfiles, taskOverrides,
];

/** The live leaves: every Deployment leaf not retired. */
export const LIVE_LEAVES: readonly string[] = DEPLOYMENT_LEAVES.filter((leaf) => !RETIRED_LEAVES.has(leaf));

/** One leaf's revision: the instant of its last write or reset, or `0` where neither happened. */
const revisionOf = (held: LeafRecord | undefined, resetAt: number | undefined): string =>
  held !== undefined ? `w${held.updatedAt}` : resetAt !== undefined ? `r${resetAt}` : '0';

/** The effective answer for every live leaf, from the policy each is bound to. */
export async function effectiveSettings(env: ServerEnv): Promise<Map<string, EffectiveSetting>> {
  const db = await settingsSnapshot(env.db);
  const read: ServerEnv = { ...env, db };
  const [stored, resets] = await Promise.all([settingsWriter(db).leaves(), leafResets(db)]);
  const resolved = await Promise.all(SETTING_POLICIES.map(async (policy) => {
    try { return { policy, answers: await policy.resolve(read) }; }
    catch (error) { return { policy, error: error instanceof Error ? error.message : String(error) }; }
  }));
  const out = new Map<string, EffectiveSetting>();
  for (const result of resolved) {
    const { policy } = result;
    for (const leaf of policy.leaves) {
      const held = stored[leaf];
      const revision = revisionOf(held, resets.get(leaf));
      if ('error' in result) {
        out.set(leaf, { stored: held?.value ?? null, effective: null, source: 'unset', state: 'unknown', reason: `Myco could not tell what this setting does now: ${result.error}`, appliesTo: DEPLOYMENT_TARGETS, revision });
        continue;
      }
      const answer = result.answers[leaf];
      if (answer === undefined) throw new Error(`the ${policy.id} policy does not resolve ${leaf}`);
      const base = { stored: held?.value ?? null, effective: answer.effective, appliesTo: answer.appliesTo ?? DEPLOYMENT_TARGETS, revision };
      if (policy.selfJudged === true) {
        out.set(leaf, { ...base, source: answer.source ?? 'default', state: answer.state ?? 'active', reason: answer.reason ?? null });
        continue;
      }
      const violation = held === undefined ? null : held.malformed ? 'The stored value does not read' : leafRuleViolation(DEPLOYMENT_LEAF_SPECS[leaf]!, held.value);
      if (violation !== null) {
        const sentence = violation.charAt(0).toUpperCase() + violation.slice(1);
        out.set(leaf, { ...base, source: 'invalid', state: 'invalid', reason: `${sentence}. ${answer.meanwhile ?? 'The default applies'} until it is corrected or reset.${answer.reason === undefined || answer.reason === null ? '' : ` ${answer.reason}`}` });
        continue;
      }
      const source: SettingSource = answer.source ?? (held !== undefined ? 'configured' : answer.effective === null ? 'unset' : 'default');
      out.set(leaf, { ...base, source, state: answer.state ?? 'active', reason: answer.reason ?? null });
    }
  }
  for (const [leaf, answer] of out) {
    const held = stored[leaf];
    const applies = held === undefined ? null : answer.source === 'configured'
      && answer.state === 'active' && JSON.stringify(held.value) === JSON.stringify(answer.effective);
    out.set(leaf, { ...answer, storedApplies: applies, reason: held !== undefined && JSON.stringify(held.value) !== JSON.stringify(answer.effective)
      ? `${answer.reason ?? 'The stored value does not apply.'} The effective value is shown by this control.` : answer.reason });
  }
  return out;
}

/** What the embedding picker offers on this server: each provider's models, and why one cannot be chosen now. */
export async function embeddingChoices(env: ServerEnv): Promise<EmbeddingChoices> {
  const target = env.platform.name;
  const [resolution, held, stored, underWay] = await Promise.all([
    embeddingResolution(env.db, env.wrappingKey, embeddingPlatformOf(env)), heldPartitions(env.db), storedEmbedding(env.db), embeddingSwitchStatus(env, Date.now()),
  ]);
  const current = resolveEmbedding(stored, target).selection;
  const providers = embeddingProvidersFor(target).map((id): EmbeddingProviderChoice => {
    const spec = EMBEDDING_CATALOGUE[id];
    const endpoint = spec.endpoint.editable && stored['embedding.provider'] === id && typeof stored['embedding.base_url'] === 'string'
      ? stored['embedding.base_url'] : spec.endpoint.url;
    return {
      id, label: spec.label, defaultModel: spec.defaultModel, customModels: spec.customModels, credential: spec.credential,
      endpoint: { editable: spec.endpoint.editable, url: spec.endpoint.url },
      models: spec.models.map((model) => {
        const candidate = resolveEmbedding({ 'embedding.provider': id, 'embedding.model': model.id, ...(spec.endpoint.editable && endpoint !== null ? { 'embedding.base_url': endpoint } : {}) }, target).selection;
        const change = model.dimensions > VECTOR_DIMENSIONS ? tooLargeRefusal(model.id, model.dimensions) : selectionChangeRefusal(current, candidate, held);
        const refusal = underWay === null || candidate?.modelKey === current?.modelKey ? change : switchUnderWay(underWay.model);
        return { id: model.id, dimensions: model.dimensions, refusal, rebuilds: underWay === null && change === SWITCH_REFUSAL };
      }),
    };
  });
  const selection = resolution.selection;
  return {
    target,
    providers,
    selection: selection === null ? null : {
      provider: selection.provider, model: selection.model,
      endpoint: EMBEDDING_CATALOGUE[selection.provider].endpoint.editable ? (resolution.leaves['embedding.base_url'].effective as string | null) : null,
      dimensions: selection.dimensions,
    },
    reason: resolution.reason,
    held: held.map((partition) => ({ model: partition.label, dimensions: partition.dimensions })),
    capacity: VECTOR_DIMENSIONS,
    switchable: held.length === 0 && underWay === null,
    switch: underWay,
  };
}

/** A retired leaf's answer: its stored history, which nothing on the server reads. */
export function retiredAnswer(held: LeafRecord | undefined): EffectiveSetting {
  return { stored: held?.value ?? null, effective: null, source: 'unset', state: 'not-applicable', reason: 'Nothing on this server reads it any more.', appliesTo: [], revision: held === undefined ? '0' : `w${held.updatedAt}` };
}
