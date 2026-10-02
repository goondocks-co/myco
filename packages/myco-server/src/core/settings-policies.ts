/**
 * The settings contract: every live Deployment leaf bound to the policy that acts on it.
 *
 * A policy's `resolve` asks the consumer's own resolver — the function the scheduler, the dispatcher, recall, search
 * or a job calls before it acts — what each of its leaves means now. The settings surface answers from that, so the
 * effective value a person reads is the value the consumer acts on, never a second copy of its default.
 *
 * Stored values are judged by each leaf's rule (`DEPLOYMENT_LEAF_SPECS`); a consumer reads through `settingTexts`,
 * which hands it only values that hold their rule, so a stored value the rule refuses is reported invalid here and
 * ignored there. A self-judged policy reports its own leaves' states whole.
 */
import {
  DEPLOYMENT_TARGETS, EMBEDDING_CATALOGUE, embeddingProvidersFor,
  type DeploymentTarget, type EffectiveSetting, type EmbeddingChoices, type EmbeddingProviderChoice, type SettingSource, type SettingState,
} from '@goondocks/myco-shared/settings-contract';
import { CONFIGURABLE_PROFILE_HARNESSES, PROFILE_HARNESSES, REASONING_TIERS } from '@goondocks/myco-shared/execution-profile';
import type { ServerEnv } from './adapters.js';
import {
  DEPLOYMENT_LEAF_SPECS, DEPLOYMENT_LEAVES, RETIRED_LEAVES, executionProfileLeafDefault, heldPartitions, leafRuleViolation, leafValues,
  leafResets, settingsWriter, storedEmbedding, taskOverridesMetadata, type LeafRecord,
} from './settings.js';
import { scheduleLeaves } from './scheduled-tasks.js';
import { readDispatchLimits, LIMIT_LEAVES } from './limits.js';
import { workerPreference } from './harness.js';
import { readRecallLeaves } from './recall.js';
import { readMapSettings } from './canopy.js';
import { reconcileIntervalMinutes } from './release-provenance.js';
import { runRetentionDays } from './jobs-run.js';
import { scheduledIntervalHours } from './recovery-schedule.js';
import { keptStagings } from './staging-retention.js';
import { backupRetentionPolicy } from './backup-retention.js';
import { cadenceOf, MAINTENANCE_CHECKS, MAINTENANCE_SETTINGS } from './store-maintenance.js';
import { importPolicy } from './import-policy.js';
import { transcriptRetentionDays } from '../ingest/retention.js';
import { autoCreateProjects } from '../api/member-projects.js';
import { keepsEmbeddingWhileIdle } from './embedding/jobs.js';
import { embeddingResolution, type EmbeddingPlatform } from './embedding/configured-provider.js';
import { dimensionRefusal, resolveEmbedding, type HeldPartition } from './embedding/policy.js';
import { VECTOR_DIMENSIONS } from './embedding/vectors.js';

/** What a policy's consumer makes of one leaf now. Unset fields take the leaf's generic answer. */
export interface LeafAnswer {
  effective: unknown;
  source?: SettingSource;
  state?: SettingState;
  reason?: string | null;
  appliesTo?: readonly DeploymentTarget[];
}

export interface SettingPolicy {
  id: string;
  leaves: readonly string[];
  /** The policy reports its leaves' states whole, judging stored values itself. */
  selfJudged?: true;
  resolve(env: ServerEnv): Promise<Readonly<Record<string, LeafAnswer>>>;
}

const SCHEDULE_OFF = 'Work on a schedule is off, so this waits until it is turned on.';

/** The embedding platform a Deployment resolves against. */
export const embeddingPlatformOf = (env: ServerEnv): EmbeddingPlatform => env.embeddingPlatform ?? { target: env.platform.name };

const scheduling: SettingPolicy = {
  id: 'scheduling',
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
          : { effective: minutes },
    };
  },
};

const limits: SettingPolicy = {
  id: 'limits',
  leaves: Object.values(LIMIT_LEAVES),
  async resolve(env) {
    const set = await readDispatchLimits(env);
    const answer = (n: number | null): LeafAnswer => ({ effective: n, ...(n === null ? { reason: 'No limit' } : {}) });
    return {
      [LIMIT_LEAVES.concurrent_runs]: answer(set.concurrent_runs),
      [LIMIT_LEAVES.task_concurrent_runs]: answer(set.task_concurrent_runs),
      [LIMIT_LEAVES.task_runs_per_hour]: answer(set.task_runs_per_hour),
    };
  },
};

const workers: SettingPolicy = {
  id: 'workers',
  leaves: ['worker.harness', 'worker.harness_fallback'],
  async resolve(env) {
    const { preferred, fallback } = await workerPreference(env);
    return {
      'worker.harness': { effective: preferred, ...(preferred === null ? { reason: 'The first agent a machine is signed in to' } : {}) },
      'worker.harness_fallback': { effective: fallback },
    };
  },
};

const context: SettingPolicy = {
  id: 'context',
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
  leaves: ['cortex.canopy.exclude.patterns'],
  async resolve(env) {
    return { 'cortex.canopy.exclude.patterns': { effective: (await readMapSettings(env.db)).userPatterns } };
  },
};

const releases: SettingPolicy = {
  id: 'releases',
  leaves: ['release_provenance.reconcile_interval_minutes'],
  async resolve(env) {
    return { 'release_provenance.reconcile_interval_minutes': { effective: await reconcileIntervalMinutes(env.db) } };
  },
};

const records: SettingPolicy = {
  id: 'records',
  leaves: ['agent.run_retention_days', 'retention.transcripts'],
  async resolve(env) {
    const window = transcriptRetentionDays((await leafValues(env.db, ['retention.transcripts'])).get('retention.transcripts'));
    return {
      'agent.run_retention_days': { effective: await runRetentionDays(env) },
      'retention.transcripts': window === 'unreadable' || window === null ? { effective: null, reason: 'Kept forever' } : { effective: window },
    };
  },
};

const backups: SettingPolicy = {
  id: 'backups',
  leaves: ['backup.auto_interval_hours', 'backup.recovery.keep_stagings', 'backup.retention.keep_daily', 'backup.retention.keep_weekly'],
  async resolve(env) {
    const interval = await scheduledIntervalHours(env);
    const noProducer = env.recovery === undefined ? { state: 'inactive' as const, reason: 'This server has no recovery producer, so it makes no recovery copies.' } : {};
    const retention = await backupRetentionPolicy(env.db);
    return {
      'backup.auto_interval_hours': { effective: interval, ...(interval === null ? { reason: 'Off' } : {}), ...noProducer },
      'backup.recovery.keep_stagings': { effective: await keptStagings(env.db), ...noProducer },
      'backup.retention.keep_daily': { effective: retention.keepDaily },
      'backup.retention.keep_weekly': { effective: retention.keepWeekly },
    };
  },
};

const maintenance: SettingPolicy = {
  id: 'maintenance',
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
  leaves: ['embedding.provider', 'embedding.model', 'embedding.base_url', 'embedding.prevent_deep_sleep'],
  selfJudged: true,
  async resolve(env) {
    const resolution = await embeddingResolution(env.db, env.wrappingKey, embeddingPlatformOf(env));
    const keep = await keepsEmbeddingWhileIdle(env.db);
    const applies = (leaf: 'embedding.provider' | 'embedding.model' | 'embedding.base_url'): readonly DeploymentTarget[] =>
      leaf === 'embedding.base_url' ? DEPLOYMENT_TARGETS.filter((t) => embeddingProvidersFor(t).some((id) => EMBEDDING_CATALOGUE[id].endpoint.editable)) : DEPLOYMENT_TARGETS;
    const stored = await leafValues(env.db, ['embedding.prevent_deep_sleep']);
    const keepText = stored.get('embedding.prevent_deep_sleep');
    const keepViolation = keepText === undefined ? null : leafRuleViolation(DEPLOYMENT_LEAF_SPECS['embedding.prevent_deep_sleep']!, safeParse(keepText));
    return {
      ...Object.fromEntries((['embedding.provider', 'embedding.model', 'embedding.base_url'] as const).map((leaf) => [leaf, { ...resolution.leaves[leaf], appliesTo: applies(leaf) }])),
      'embedding.prevent_deep_sleep': keepViolation !== null
        ? { effective: keep, source: 'invalid', state: 'invalid', reason: `${keepViolation}. Reset it to keep embedding while idle, or correct it.` }
        : { effective: keep, source: keepText === undefined ? 'default' : 'configured',
          ...(resolution.selection === null ? { state: 'inactive', reason: resolution.reason ?? `No embedding provider is in use on this server.` } : { state: 'active' }) },
    };
  },
};

const safeParse = (text: string): unknown => { try { return JSON.parse(text); } catch { return { malformed: text }; } };

/** Execution profiles hold the task they name while a stored value is unusable, so they report it as nothing in effect. */
const executionProfiles: SettingPolicy = {
  id: 'execution-profiles',
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
      const violation = held === undefined ? null : held.malformed ? 'Stored value is not valid JSON' : leafRuleViolation(DEPLOYMENT_LEAF_SPECS[leaf]!, held.value);
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
  leaves: ['agent.tasks'],
  selfJudged: true,
  async resolve(env) {
    const held = (await settingsWriter(env.db).leaves())['agent.tasks'];
    if (held === undefined) return { 'agent.tasks': { effective: {}, source: 'default', state: 'active', reason: 'No overrides' } };
    const violation = held.malformed ? 'Stored value is not valid JSON' : leafRuleViolation(DEPLOYMENT_LEAF_SPECS['agent.tasks']!, held.value);
    if (violation !== null) {
      return { 'agent.tasks': { effective: null, source: 'invalid', state: 'invalid', reason: `${violation}. Correct this setting${held.malformed ? ' or reset it.' : '.'}` } };
    }
    return { 'agent.tasks': { effective: taskOverridesMetadata(held.value).editableValue, source: 'configured', state: 'active' } };
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
  const stored = await settingsWriter(env.db).leaves();
  const resets = await leafResets(env.db);
  const out = new Map<string, EffectiveSetting>();
  for (const policy of SETTING_POLICIES) {
    const answers = await policy.resolve(env);
    for (const leaf of policy.leaves) {
      const answer = answers[leaf];
      if (answer === undefined) throw new Error(`the ${policy.id} policy does not resolve ${leaf}`);
      const held = stored[leaf];
      const base = { stored: held?.value ?? null, effective: answer.effective, appliesTo: answer.appliesTo ?? DEPLOYMENT_TARGETS, revision: revisionOf(held, resets.get(leaf)) };
      if (policy.selfJudged === true) {
        out.set(leaf, { ...base, source: answer.source ?? 'default', state: answer.state ?? 'active', reason: answer.reason ?? null });
        continue;
      }
      const violation = held === undefined ? null : held.malformed ? 'Stored value is not valid JSON' : leafRuleViolation(DEPLOYMENT_LEAF_SPECS[leaf]!, held.value);
      if (violation !== null) {
        out.set(leaf, { ...base, source: 'invalid', state: 'invalid', reason: `${violation}. Reset it to use the default, or correct it.` });
        continue;
      }
      const source: SettingSource = answer.source ?? (held !== undefined ? 'configured' : answer.effective === null ? 'unset' : 'default');
      out.set(leaf, { ...base, source, state: answer.state ?? 'active', reason: answer.reason ?? null });
    }
  }
  return out;
}

export async function embeddingChoices(env: ServerEnv): Promise<EmbeddingChoices> {
  const target = env.platform.name;
  const resolution = await embeddingResolution(env.db, env.wrappingKey, embeddingPlatformOf(env));
  const held: HeldPartition[] = await heldPartitions(env.db);
  const stored = await storedEmbedding(env.db);
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
        const refusal = candidate === null || candidate.modelKey === current?.modelKey ? null
          : model.dimensions > VECTOR_DIMENSIONS ? `Produces ${model.dimensions}-dimension vectors; the search index holds at most ${VECTOR_DIMENSIONS}.`
            : dimensionRefusal(candidate, held);
        return { id: model.id, dimensions: model.dimensions, refusal };
      }),
    };
  });
  const selection = resolution.selection ?? current;
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
  };
}

/** Every Deployment leaf's settings row: the live ones from their policies, and retired ones as stored history. */
export function retiredAnswer(held: LeafRecord | undefined): EffectiveSetting {
  return { stored: held?.value ?? null, effective: null, source: 'unset', state: 'not-applicable', reason: 'Nothing on this server reads it any more.', appliesTo: [], revision: held === undefined ? '0' : `w${held.updatedAt}` };
}
