import { observedSettingsAssertion } from '../db/meta/settings-observation.js';
import type { Bound } from '../db/index.js';
import { CURATION_DAILY_LIMIT_SETTING } from '@goondocks/myco-shared/settings-contract';
import { BUDGET_LEAF, BUDGET_DEFAULT_USD, BUDGET_MINIMUM_USD } from './budget-policy.js';
import { persistSettings, readEveryLeaf, readLeafValues, readSettingStates, readProjectEditor, projectCurationLimitSql, readCurationLimit, settingRevisions, observedRevisionPredicate, type SettingState } from '../db/settings/leaves.js';
import { DEFAULT_OFF_CAPABILITIES, capabilityOnSql, projectWorkEnabled, readCapabilities, readCapabilityOn, readRetiredCapabilities } from '../db/settings/admission.js';
import type { EmbeddingSwitch } from './embedding/switch-store.js';
import type { PreparedStatement, RelationalStore } from './adapters.js';
import { captureFolderRefusal, planFolderRefusal, ROOT_KEY_PATTERN } from '@goondocks/myco-shared/member-protocol';
import { INSTRUCTIONS_TEMPLATE_MAX_BYTES, IMPORT_MAX_SESSIONS_MAX, IMPORT_WINDOW_DAYS_MAX } from '../constants.js';
import { CONFIGURABLE_PROFILE_HARNESSES, PROFILE_HARNESSES, REASONING_TIERS, isReasoningTier, modelRefusal, effortRefusal, type ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import { TASK_EXECUTION_PROFILES, admissionForTask, OUTCOME_TASKS, RETAINED_TASKS, TITLING_TASK, EXTRACTION_TASK } from './task-catalogue.js';
import { TASK_SCHEDULE } from './jobs.js';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { EMBEDDING_CATALOGUE, isEmbeddingProvider, type DeploymentTarget } from '@goondocks/myco-shared/settings-contract';
import {
  EMBEDDING_SELECTION_LEAVES, embeddingEndpointRefusal, heldPartition, resolveEmbedding, selectionChangeRefusal,
  type EmbeddingSelection, type EmbeddingSelectionLeaf, type StoredEmbedding,
} from './embedding/policy.js';
import { readSwitch } from './embedding/switch-store.js';
import { SWITCH_STANDS_SQL, heldModels } from '../db/embeddings/switch.js';

/**
 * Deployment Settings: one operation every write goes through.
 *
 * 1.4 resolved settings across four tiers; 2.0 keeps two, and the server tier is
 * this one. Every write admits the leaf, authorizes the actor, checks the
 * leaf's own rule, persists, records its actor, and re-arms the schedule that
 * may have moved — in that order, in one place.
 *
 * The order matters more than the steps. A write that persists before it
 * authorizes has already happened when it is refused; one that checks the
 * leaf's rule before authorizing answers a caller it would refuse anyway; one
 * that re-arms before it persists arms against a value the store does not hold; and one that skips the actor leaves an audit
 * trail that cannot answer who changed what. Splitting
 * these across call sites is how three of the four eventually go missing on one
 * path and nobody notices, which is why the gate holds every write to this module.
 */

/** A capability the Deployment may admit a Project to. */
export const PROJECT_CAPABILITIES = ['cortex', 'canopy', 'vault_evolution', 'spore_curation', 'spore_curation_backfill'] as const;
export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

/**
 * The rule a leaf's value satisfies at write.
 *
 * Declarative data rather than a validator function: a gate reads it, and the
 * settings surface reports a stored value that breaks it as invalid, with its
 * remedy, rather than acting on it. A consumer reads a live leaf through
 * `settingTexts`, which hands it only a value that holds its rule.
 *
 * `boolean` means true or false. `integer` with `nullable` also takes null; a declared `default` applies
 * only when no usable stored value exists. `agent` names an agent a worker can run,
 * or null for none; `agent-list` names each such agent once. `pattern-list`
 * is a list of distinct non-empty path patterns. `embedding` is one part of the
 * embedding selection, judged with the other two parts and the target
 * (`core/embedding/policy.ts`).
 *
 * `markdown` means text: a string, no ASCII control character but newline and
 * tab, within `maxBytes` of UTF-8.
 *
 * `task-overrides` means an object of per-task overrides whose schedule
 * counts, where one is given, are whole numbers of 0 or more: a count is bound
 * into SQL as a row limit, and a fraction there refuses the statement.
 */
export type LeafSpec =
  | Record<string, never>
  | { readonly type: 'boolean' }
  | { readonly type: 'number'; readonly min: number; readonly default: number }
  | { readonly type: 'integer'; readonly min: number; readonly max: number; readonly nullable?: true; readonly default?: number | null }
  | { readonly type: 'agent' }
  | { readonly type: 'agent-list' }
  | { readonly type: 'pattern-list'; readonly maxItems: number; readonly maxChars: number }
  | { readonly type: 'embedding'; readonly leaf: EmbeddingSelectionLeaf }
  | { readonly type: 'markdown'; readonly maxBytes: number }
  | { readonly type: 'task-overrides' }
  | { readonly type: 'profile-model'; readonly harness: keyof typeof PROFILE_HARNESSES }
  | { readonly type: 'profile-effort'; readonly harness: keyof typeof PROFILE_HARNESSES }
  | { readonly type: 'credential-source' }
  /**
   * A list of paths, without control characters: plan folders, each absolute, `~/`, or relative to wherever it is
   * resolved (`planFolderRefusal`); or, with `folders: 'capture'`, capture folders (`captureFolderRefusal`).
   */
  | { readonly type: 'path-list'; readonly maxItems: number; readonly maxChars: number; readonly folders?: 'capture' }
  /** Repository keys, each naming the project it connects to or `''` for none chosen: what a machine may join. */
  | { readonly type: 'root-map'; readonly maxItems: number };

const BOOLEAN_SPEC: LeafSpec = { type: 'boolean' };
/** A dispatch limit: a whole number of runs, or null for none. */
const LIMIT_SPEC: LeafSpec = { type: 'integer', min: 1, max: 10_000, nullable: true };

/**
 * The leaves this tier owns, from §7.8 of the architecture ledger.
 *
 * Held here rather than derived from the member's schema: the member package is
 * not a dependency of the server, and a leaf reaching the Deployment tier is a
 * decision the ledger records rather than something the shape of a config file
 * implies. A meta gate holds this list against the ledger so the two cannot drift.
 */
export const DEPLOYMENT_LEAF_SPECS: Readonly<Record<string, LeafSpec>> = {
  [BUDGET_LEAF]: { type: 'number', min: BUDGET_MINIMUM_USD, default: BUDGET_DEFAULT_USD },
  'agent.cold_project_threshold_days': { type: 'integer', min: 0, max: 365 },
  'agent.limits.concurrent_runs': LIMIT_SPEC,
  'agent.limits.task_concurrent_runs': { ...LIMIT_SPEC, default: 2 },
  'agent.limits.task_runs_per_hour': LIMIT_SPEC,
  ...Object.fromEntries(CONFIGURABLE_PROFILE_HARNESSES.flatMap((harness) => [
    ...REASONING_TIERS.map((tier) => [`agent.reasoning_map.${harness}.${tier}`, { type: 'profile-model', harness }]),
    ...REASONING_TIERS.map((tier) => [`agent.effort_map.${harness}.${tier}`, { type: 'profile-effort', harness }]),
    [`agent.harnesses.${harness}.credential`, { type: 'credential-source' }],
  ])),
  'agent.run_retention_days': { type: 'integer', min: 1, max: 365 },
  'agent.scheduled_tasks_active_window_days': { type: 'integer', min: 0, max: 365 },
  'agent.scheduled_tasks_enabled': BOOLEAN_SPEC,
  'agent.learning_history_enabled': BOOLEAN_SPEC,
  'agent.tasks': { type: 'task-overrides' },
  'agent.titling_idle_close_minutes': { type: 'integer', min: 5, max: 10_080 },
  'backup.auto_interval_hours': { type: 'integer', min: 1, max: 720 },
  // #1547: whether a member's machine may create a project for a repository it meets that no project holds. Absent
  // means on; an admin turns it off to keep project creation with admins.
  'capture.auto_create_projects': BOOLEAN_SPEC,
  'backup.recovery.keep_stagings': { type: 'integer', min: 1, max: 30 },
  'backup.retention.keep_daily': { type: 'integer', min: 1, max: 365 },
  'backup.retention.keep_weekly': { type: 'integer', min: 0, max: 52 },
  'cortex.canopy.exclude.patterns': { type: 'pattern-list', maxItems: 100, maxChars: 256 },
  'cortex.canopy.refresh.background_period_minutes': { type: 'integer', min: 1, max: 10_080 },
  'cortex.instructions.inject_on_session_start': BOOLEAN_SPEC,
  'cortex.instructions.inject_on_subagent_start': BOOLEAN_SPEC,
  'cortex.plans.inject_intent_nudge_on_prompt_submit': BOOLEAN_SPEC,
  'cortex.spores.inject_on_prompt_submit': BOOLEAN_SPEC,
  'cortex.spores.max_per_prompt': { type: 'integer', min: 0, max: 10 },
  'embedding.base_url': { type: 'embedding', leaf: 'embedding.base_url' },
  'embedding.model': { type: 'embedding', leaf: 'embedding.model' },
  'embedding.prevent_deep_sleep': BOOLEAN_SPEC,
  'embedding.provider': { type: 'embedding', leaf: 'embedding.provider' },
  // #1148 — bounded import. `enabled` is also an admission on the write path;
  // the window and the per-harness cap are applied where a whole pass is
  // visible, which one event is not.
  'import.enabled': BOOLEAN_SPEC,
  'import.max_sessions_per_harness': { type: 'integer', min: 1, max: IMPORT_MAX_SESSIONS_MAX },
  'import.window_days': { type: 'integer', min: 1, max: IMPORT_WINDOW_DAYS_MAX },
  'instructions.template': { type: 'markdown', maxBytes: INSTRUCTIONS_TEMPLATE_MAX_BYTES },
  'maintenance.auto_integrity_check': BOOLEAN_SPEC,
  'maintenance.auto_integrity_check_interval_hours': { type: 'integer', min: 1, max: 8760 },
  'maintenance.auto_optimize': BOOLEAN_SPEC,
  'maintenance.auto_optimize_interval_hours': { type: 'integer', min: 1, max: 720 },
  'release_provenance.reconcile_interval_minutes': { type: 'integer', min: 1, max: 1440 },
  // An explicit legacy zero holds raw archival; finite writes use the canonical leaf.
  'retention.transcripts': { type: 'integer', min: 0, max: 3650 },
  'retention.raw_days': { type: 'integer', min: 1, max: 3650 },
  // #1151 — worker mode: the harness a worker prefers and the order it falls back through.
  'worker.harness': { type: 'agent' },
  'worker.harness_fallback': { type: 'agent-list' },
};

/** No retired Deployment leaf remains in the active contract. */
export const RETIRED_LEAVES: ReadonlySet<string> = new Set();

/** Secret slots the Deployment still stores that nothing reads. */
export const RETIRED_SECRET_SLOTS: ReadonlySet<string> = new Set(['github']);

/** The leaves this tier owns. Derived from the specs, so a leaf cannot be named in one and missing from the other. */
export const DEPLOYMENT_LEAVES: readonly string[] = Object.keys(DEPLOYMENT_LEAF_SPECS);

/** The built-in value of one execution profile leaf on this Deployment. */
export function executionProfileLeafDefault(leaf: string): { present: boolean; value: string | null } | null {
  const parts = leaf.split('.');
  const [scope, map, harness, tier] = parts;
  if (scope !== 'agent') return null;
  if (parts.length === 4 && (map === 'reasoning_map' || map === 'effort_map') && harness !== undefined && isReasoningTier(tier)
    && CONFIGURABLE_PROFILE_HARNESSES.includes(harness)) {
    const profile = PROFILE_HARNESSES[harness]!;
    const value = map === 'reasoning_map' ? profile.models[tier] : profile.efforts[tier];
    return { present: value !== null, value };
  }
  if (parts.length === 4 && map === 'harnesses' && harness !== undefined && tier === 'credential' && CONFIGURABLE_PROFILE_HARNESSES.includes(harness)) {
    return { present: true, value: 'worker-login' };
  }
  return null;
}

const DEPLOYMENT_LEAF_SET = new Set(DEPLOYMENT_LEAVES);

/** Any ASCII control character but newline and tab; a stored setting is text a person edits, not a control stream. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The fields each retained task's consumers read. */
const TASK_FIELDS = ['harness', 'model', 'reasoningLevel', 'schedule'] as const;
const SCHEDULE_FIELDS = ['enabled', 'intervalSeconds', 'runIn', 'preCondition', 'accelerator', 'maxRunsPerDay', 'memberRunsPerDay', 'reservedRunsPerDay', 'runWhenCold', 'overlap'] as const;
const consumedTaskFields = (task: string): readonly string[] => {
  if (!(OUTCOME_TASKS as readonly string[]).includes(task) || TASK_EXECUTION_PROFILES[task] !== undefined) return [];
  if (task === EXTRACTION_TASK) return ['harness', 'model', 'reasoningLevel', 'enabled', 'memberRunsPerDay'];
  return task === TITLING_TASK || TASK_SCHEDULE[task] != null ? TASK_FIELDS : TASK_FIELDS.filter((field) => field !== 'schedule');
};

/** Keep every live task field the Deployment can use, including values that hold its work pending correction. */
export function cleanTaskDocument(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).flatMap(([task, entry]) => {
    if (!(RETAINED_TASKS as readonly string[]).includes(task)) return [];
    if (!isRecord(entry)) return [[task, entry]];
    const fields = consumedTaskFields(task);
    const kept = Object.fromEntries(Object.entries(entry).flatMap(([field, held]) => {
      if (!fields.includes(field)) return [];
      if (field === 'harness' && (typeof held !== 'string' || !Object.hasOwn(PROFILE_HARNESSES, held))) return [];
      if (field === 'model' && (typeof entry.harness !== 'string' || !Object.hasOwn(PROFILE_HARNESSES, entry.harness))) return [];
      if (field === 'schedule' && isRecord(held)) {
        return [[field, Object.fromEntries(Object.entries(held).filter(([key]) => (SCHEDULE_FIELDS as readonly string[]).includes(key)))]];
      }
      return [[field, held]];
    }));
    return Object.keys(kept).length === 0 ? [] : [[task, kept]];
  }));
}

/** Stored task fields that apply, and the named reasons other fields do not. */
export function taskOverridesResolution(value: unknown): { effective: unknown; reasons: string[]; invalid: boolean } {
  if (!isRecord(value)) return { effective: null, reasons: ['Expected an object of task overrides. Worker tasks wait for a valid object; scheduling uses the declared task defaults.'], invalid: true };
  const effective: Record<string, unknown> = {};
  const reasons: string[] = [];
  let invalid = false;
  for (const [task, entry] of Object.entries(value)) {
    if (!(RETAINED_TASKS as readonly string[]).includes(task)) { reasons.push(`${task}: this task no longer exists; its stored override is not used.`); continue; }
    if (!isRecord(entry)) { effective[task] = null; invalid = true; reasons.push(`${task}: the stored entry is not an object; this task waits for a valid override.`); continue; }
    const applied: Record<string, unknown> = {};
    const fields = consumedTaskFields(task);
    for (const [field, held] of Object.entries(entry)) {
      const path = `${task}.${field}`;
      if (!fields.includes(field)) { reasons.push(`${path}: no consumer uses this field; it does not apply.`); continue; }
      if ((field === 'enabled' && typeof held !== 'boolean') || (field === 'memberRunsPerDay' && !isScheduleCount(held))) {
        applied[field] = null; invalid = true; reasons.push(`${path}: invalid task preference; correct it in Settings.`); continue;
      }
      if (field === 'harness' && (typeof held !== 'string' || !Object.hasOwn(PROFILE_HARNESSES, held))) {
        applied[field] = null; invalid = true; reasons.push(`${path}: the stored agent${typeof held === 'string' ? ` "${held}"` : ''} is not supported; the worker cannot choose it.`); continue;
      }
      if (field === 'reasoningLevel' && !isReasoningTier(held)) {
        applied[field] = null; invalid = true; reasons.push(`${path}: this tier is invalid; the task waits until it is corrected.`); continue;
      }
      if (field === 'model' && task !== 'container-smoke' && (typeof entry.harness !== 'string' || modelRefusal(entry.harness, held) !== null)) {
        applied[field] = null; invalid = true; reasons.push(`${path}: this model cannot be applied by the stored agent; the task waits for a supported execution profile.`); continue;
      }
      if (field === 'schedule') {
        if (!isRecord(held)) { invalid = true; reasons.push(`${path}: not a schedule object; the declared schedule applies.`); continue; }
        const schedule: Record<string, unknown> = {};
        for (const [key, setting] of Object.entries(held)) {
          if (!(SCHEDULE_FIELDS as readonly string[]).includes(key)) { reasons.push(`${path}.${key}: no scheduling consumer uses this field.`); continue; }
          schedule[key] = setting;
        }
        applied[field] = schedule;
      } else applied[field] = held;
    }
    if (Object.keys(applied).length > 0) effective[task] = applied;
  }
  return { effective, reasons, invalid };
}

/** The complete stored document remains editable until the user clears or repairs it. */
export function taskOverridesMetadata(value: unknown): { editableValue: unknown; retiredValue: Record<string, unknown> } {
  return { editableValue: value, retiredValue: {} };
}

/** Retired preferences survive replacement of the live overrides document. */
function preserveRetiredTaskOverrides(value: unknown, previous: unknown): unknown {
  if (!isRecord(value)) return value;
  const retiredValue = isRecord(previous) ? Object.fromEntries(Object.entries(previous).flatMap(([task, entry]) =>
    task === 'container-smoke' ? [[task, entry]] : isRecord(entry) && Object.hasOwn(entry, 'provider') ? [[task, { provider: entry.provider }]] : [])) : {};
  const merged = { ...value };
  for (const [task, archived] of Object.entries(retiredValue)) {
    merged[task] = task === 'container-smoke' ? archived
      : { ...(isRecord(merged[task]) ? merged[task] : {}), ...(isRecord(archived) ? archived : {}) };
  }
  return merged;
}

/**
 * The schedule counts a task override carries, each a whole number of 0 or more when given: the clock's own daily
 * ceiling and a member's daily allowance for starts by hand.
 */
const SCHEDULE_COUNT_FIELDS = ['maxRunsPerDay', 'memberRunsPerDay'] as const;

/** What a changed per-task override violates; unchanged stored fields remain available for a separate repair. */
function taskOverridesViolation(value: unknown, previous?: unknown): string | null {
  if (!isRecord(value)) return 'expected an object of task overrides';
  const prior = isRecord(previous) ? previous : {};
  for (const [task, override] of Object.entries(value)) {
    const before = prior[task];
    const unchanged = JSON.stringify(before) === JSON.stringify(override);
    if (unchanged) continue;
    if (!(RETAINED_TASKS as readonly string[]).includes(task)) return `${task}: unknown task`;
    if (isRecord(override)) {
      const oldEntry = isRecord(before) ? before : {};
      for (const field of Object.keys(override)) {
        if (!consumedTaskFields(task).includes(field) && JSON.stringify(override[field]) !== JSON.stringify(oldEntry[field])) return `${task}.${field}: field is not used by this task`;
      }
      if (override.harness !== undefined && override.harness !== oldEntry.harness && (typeof override.harness !== 'string' || !Object.hasOwn(PROFILE_HARNESSES, override.harness))) return `${task} agent choice: expected a supported agent`;
    }
    if (previous !== undefined && task === 'container-smoke') return `${task}: retired task overrides are read-only`;
    if (previous !== undefined && isRecord(override) && Object.hasOwn(override, 'provider') && JSON.stringify(override.provider) !== JSON.stringify(isRecord(before) ? before.provider : undefined)) return `${task}.provider: provider preferences are retired; choose an execution profile`;
    if (override === before) continue;
    if (!isRecord(override)) return `${task}: expected an object of task overrides`;
    const old = isRecord(before) ? before : {};
    if (task === EXTRACTION_TASK) {
      if (override.enabled !== undefined && override.enabled !== old.enabled && typeof override.enabled !== 'boolean') return `${task}.enabled: expected true or false`;
      if (override.memberRunsPerDay !== undefined && override.memberRunsPerDay !== old.memberRunsPerDay && !isScheduleCount(override.memberRunsPerDay)) return `${task}.memberRunsPerDay: expected a whole number of 0 or more`;
    }
    const tier = override.reasoningLevel;
    if (tier !== undefined && tier !== old.reasoningLevel && !(REASONING_TIERS as readonly unknown[]).includes(tier)) return `${task}.reasoningLevel: expected low, default, or high`;
    if (override.model !== undefined && (override.model !== old.model || override.harness !== old.harness)) {
      if (typeof override.harness !== 'string' || !Object.hasOwn(PROFILE_HARNESSES, override.harness)) {
        return `${task}.model: a fixed model requires a supported agent in the same task override`;
      }
      const refusal = modelRefusal(override.harness as keyof typeof PROFILE_HARNESSES, override.model);
      if (refusal !== null) return `${task}.model: ${refusal}`;
    }
    if (!isRecord(override.schedule)) continue;
    const oldSchedule = isRecord(old.schedule) ? old.schedule : {};
    for (const [field, held] of Object.entries(override.schedule)) {
      if (!(SCHEDULE_FIELDS as readonly string[]).includes(field) && JSON.stringify(held) !== JSON.stringify(oldSchedule[field])) return `${task}.schedule.${field}: field is not used by this task`;
    }
    for (const field of SCHEDULE_COUNT_FIELDS) {
      const count = override.schedule[field];
      if (count !== undefined && count !== oldSchedule[field] && !isScheduleCount(count)) return `${task}.schedule.${field}: expected a whole number of 0 or more`;
    }
  }
  return null;
}

/** A schedule count: a whole number of 0 or more that SQL binds exactly. */
export const isScheduleCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function pathListViolation(spec: { maxItems: number; maxChars: number; folders?: 'capture' }, value: unknown): string | null {
  const refusal = spec.folders === 'capture' ? captureFolderRefusal : planFolderRefusal;
  if (!Array.isArray(value)) return 'expected a list of paths';
  if (value.length > spec.maxItems) return `expected at most ${spec.maxItems} paths`;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') return 'expected each path to be non-empty text';
    if (entry.length > spec.maxChars) return `expected each path to be at most ${spec.maxChars} characters`;
    if (/[\u0000-\u001F\u007F]/.test(entry)) return 'expected each path without control characters';
    const broad = refusal(entry);
    if (broad !== null) return broad;
  }
  return new Set(value).size === value.length ? null : 'expected each path once';
}

/** What a list of worker agents violates: each an agent a machine can run, each once. */
function agentListViolation(value: unknown): string | null {
  if (!Array.isArray(value)) return 'expected a list of agents';
  const unknown = value.filter((agent) => typeof agent !== 'string' || !Object.hasOwn(HARNESS_CREDENTIALS, agent));
  if (unknown.length > 0) return `not an agent a machine can run: ${unknown.map(String).join(', ')}`;
  return new Set(value).size === value.length ? null : 'expected each agent once';
}

/** What a list of path patterns violates: distinct non-empty patterns without control characters, within the bounds. */
function patternListViolation(spec: { maxItems: number; maxChars: number }, value: unknown): string | null {
  if (!Array.isArray(value)) return 'expected a list of path patterns';
  if (value.length > spec.maxItems) return `expected at most ${spec.maxItems} patterns`;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') return 'expected each pattern to be non-empty text';
    if (entry.length > spec.maxChars) return `expected each pattern to be at most ${spec.maxChars} characters`;
    if (/[\u0000-\u001F\u007F]/.test(entry)) return 'expected each pattern without control characters';
  }
  return new Set(value).size === value.length ? null : 'expected each pattern once';
}

/** What one part of the embedding selection violates on its own; the parts are judged together at write. */
function embeddingPartViolation(leaf: EmbeddingSelectionLeaf, value: unknown): string | null {
  if (leaf === 'embedding.provider') return isEmbeddingProvider(value) ? null : 'expected an embedding provider';
  if (leaf === 'embedding.base_url') return embeddingEndpointRefusal(value);
  return typeof value === 'string' && value.trim() !== '' ? null : 'expected a model name';
}

/** A repository key as the member derives one: hex, of a fixed width. */
export const ROOT_KEY = ROOT_KEY_PATTERN;
/** A project id as every project carries one. */
const PROJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

/** What a root map violates: an object of repository keys, each naming a project or `''`, or null when it holds. */
function rootMapViolation(spec: { maxItems: number }, value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'expected an object of repository keys';
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > spec.maxItems) return `expected at most ${spec.maxItems} repositories`;
  for (const [key, project] of entries) {
    if (!ROOT_KEY.test(key)) return `${key} is not a repository key`;
    if (typeof project !== 'string' || (project !== '' && !PROJECT_ID_SHAPE.test(project))) return `${key} names no project`;
  }
  return null;
}

/** What the value violates, or null when it satisfies the leaf's rule. */
export function leafRuleViolation(spec: LeafSpec, value: unknown, previous?: unknown): string | null {
  if (!('type' in spec)) return null;
  if (spec.type === 'boolean') return typeof value === 'boolean' ? null : 'expected on or off';
  if (spec.type === 'number') return typeof value === 'number' && Number.isFinite(value) && value>=spec.min ? null : `expected a finite number of at least ${spec.min}`;
  if (spec.type === 'integer') {
    if (value === null && spec.nullable === true) return null;
    if (typeof value !== 'number' || !Number.isInteger(value)) return 'expected a whole number';
    if (value < spec.min || value > spec.max) return `expected a whole number from ${spec.min} to ${spec.max}`;
    return null;
  }
  if (spec.type === 'task-overrides') return taskOverridesViolation(value, previous);
  if (spec.type === 'profile-model') return modelRefusal(spec.harness, value);
  if (spec.type === 'profile-effort') return effortRefusal(spec.harness, value);
  if (spec.type === 'credential-source') return value === 'deployment' || value === 'worker-login' ? null : 'choose the server login or worker login';
  if (spec.type === 'path-list') return pathListViolation(spec, value);
  if (spec.type === 'root-map') return rootMapViolation(spec, value);
  if (spec.type === 'agent') return value === null || (typeof value === 'string' && Object.hasOwn(HARNESS_CREDENTIALS, value)) ? null : 'expected an agent a machine can run, or none';
  if (spec.type === 'agent-list') return agentListViolation(value);
  if (spec.type === 'pattern-list') return patternListViolation(spec, value);
  if (spec.type === 'embedding') return embeddingPartViolation(spec.leaf, value);
  if (typeof value !== 'string') return 'expected Markdown text';
  if (CONTROL_CHARACTERS.test(value)) return 'expected Markdown text without control characters';
  const bytes = new TextEncoder().encode(value).length;
  return bytes > spec.maxBytes ? `expected at most ${spec.maxBytes} bytes, got ${bytes}` : null;
}

/** The Deployment's session-start instructions, empty where none is written. */
export async function instructionsTemplate(db: RelationalStore): Promise<string> {
  const raw = (await leafValues(db, [INSTRUCTIONS_TEMPLATE_LEAF])).get(INSTRUCTIONS_TEMPLATE_LEAF);
  if (raw === undefined) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

/** The leaf carrying the text every session starts from. */
export const INSTRUCTIONS_TEMPLATE_LEAF = 'instructions.template';

/** Why a settings write did not apply. */
export type SettingsRefusal =
  | { reason: 'not_deployment_tier'; leaf: string }
  | { reason: 'invalid_value'; leaf: string; detail: string; next?: string }
  | { reason: 'unauthorized'; leaf: string }
  | { reason: 'retired'; leaf: string }
  /** Another write changed the leaves this one is judged against before it landed; nothing is written. */
  | { reason: 'conflict'; leaf: string; actual: number; expected: number; next: string }
  | { reason: 'unknown_capability'; capability: string };

/** A stored leaf: its value and who last wrote it. */
export interface LeafRecord {
  value: unknown;
  updatedAt: number;
  updatedBy: string;
  malformed?: true;
}

declare const admittedSettings: unique symbol;
/** A validated and authorized change, minted only by this capability. */
export interface AdmittedSettingsChange {
  readonly [admittedSettings]: true;
  readonly parts: readonly { leaf: string; value: unknown }[];
  readonly expected: Readonly<Record<string, number>>;
  readonly actor: string;
  readonly now: number;
  readonly project?: string;
  readonly capability?: true;
  readonly embeddingEmpty?: boolean;
}
const admittedChange = (change: Omit<AdmittedSettingsChange, typeof admittedSettings>): AdmittedSettingsChange => {
  if (change.parts.some(part => !Object.hasOwn(change.expected, part.leaf))) throw new Error('Every settings mutation requires an observed revision');
  return change as AdmittedSettingsChange;
};

export const settingsRevisions = (db: RelationalStore, scope = ''): Promise<Record<string, number>> =>
  scope === '' && SNAPSHOT_REVISIONS.has(db) ? Promise.resolve(SNAPSHOT_REVISIONS.get(db)!) : settingRevisions(db, scope);

/** The call that puts a refused write right: read the leaf's current revision, then repeat the change with it. */
function afterConflict(leaf: string, scope: string, actual: number): string {
  const repeat = `then repeat this request with If-Match: ${actual}. Nothing was saved.`;
  if (scope.startsWith('capability:')) return `GET /api/projects/${scope.slice('capability:'.length)}/capabilities and read capabilityRevisions, ${repeat}`;
  if (scope !== '') return `GET /api/projects/${scope}/capabilities and read revisions, ${repeat}`;
  if ((EMBEDDING_SELECTION_LEAVES as readonly string[]).includes(leaf)) return `GET /api/settings for each embedding leaf's revision, then repeat this request with those revisions in If-Match (PUT /api/embedding takes all three as a JSON object). Nothing was saved.`;
  return `GET /api/settings for ${leaf}'s current value and revision, ${repeat}`;
}

async function conflict(db: RelationalStore, leaf: string, expected: Readonly<Record<string, number>>, scope = ''): Promise<SettingsResult> {
  const revisions = await settingRevisions(db, scope);
  const stale = Object.keys(expected).find(name => (revisions[name] ?? 0) !== expected[name]) ?? Object.keys(expected)[0];
  const named = stale === undefined || scope.startsWith('capability:') ? leaf : stale;
  const key = stale ?? leaf;
  const actual = revisions[key] ?? 0;
  return { applied: false, refusal: { reason: 'conflict', leaf: named, actual, expected: expected[key] ?? actual, next: afterConflict(named, scope, actual) } };
}

export type SettingsResult = { applied: true } | { applied: false; refusal: SettingsRefusal };

/**
 * Whether a member may make this particular change.
 *
 * Membership is flat, so every change is admitted and the default answers true.
 * The seam stays: a future guard on a sensitive change — re-authentication of
 * the signed-in member, never a second secret — plugs in here, one place rather
 * than a new branch at each caller.
 */
type SettingsAuthorizer = (change: { leaf: string; value?: unknown; actor: string }) => Promise<boolean>;

/** Re-arms whatever the change may have moved. Supplied by the caller so this module never decides what runs. */
type ScheduleRearm = (change: { leaf: string }) => Promise<void>;

/** The embedding selection one write sets: a provider, and its model and endpoint, each left at its default when absent. */
export interface EmbeddingChoice { provider: unknown; model?: unknown; endpoint?: unknown }

export interface SettingsWriter {
  setProjectLeaf(projectId: string, leaf: string, value: unknown, actor: string, nowMs: number, expectedRevision?: number): Promise<SettingsResult>;
  /** Set one Deployment leaf. */
  setLeaf(leaf: string, value: unknown, actor: string, nowMs: number, expectedRevision?: number): Promise<SettingsResult>;
  /** Set the whole embedding selection at once, so a provider never meets a model or endpoint it does not offer. */
  setEmbedding(choice: EmbeddingChoice, actor: string, nowMs: number, expectedRevisions?: Readonly<Record<string, number>>): Promise<SettingsResult>;
  /** Remove one configured leaf so its built-in value applies. */
  resetLeaf(leaf: string, actor: string, nowMs?: number, expectedRevision?: number): Promise<SettingsResult>;
  /** Clear task entries and fields that have no consumer, while preserving the current live document. */
  repairTaskDocument(actor: string, nowMs: number, expectedRevision?: number): Promise<SettingsResult>;
  /**
   * Set one task's schedule switch in the task overrides document, keeping every other field. An absent task entry or
   * schedule is created; a stored document, entry or schedule that is present and not an object is refused.
   */
  setTaskSwitch(task: string, enabled: boolean, actor: string, nowMs: number, expectedRevision?: number): Promise<SettingsResult>;
  /** Change one task tier in the live task overrides document. */
  setTaskTier(task: string, tier: ReasoningTier | null, actor: string, nowMs: number, expectedRevision?: number): Promise<SettingsResult>;
  /** Admit or withdraw a Project's capability. */
  setCapability(projectId: string, capability: string, enabled: boolean, actor: string, nowMs: number, expectedRevision?: number): Promise<SettingsResult>;
  /** Every stored Deployment leaf. Absent leaves are not defaulted here; a reader layers these over its own defaults. */
  leaves(): Promise<Record<string, LeafRecord>>;
  /** Whether a live Project has this capability on; an absent row is on and an explicit zero is off. */
  capabilityEnabled(projectId: string, capability: ProjectCapability): Promise<boolean>;
  /** Every capability this Project is admitted to. */
  capabilities(projectId: string): Promise<Record<ProjectCapability, boolean>>;
  /** Stored admissions for capabilities outside the live set, for read-only inspection. */
  retiredCapabilities(projectId: string): Promise<Record<string, boolean>>;
}

/** A settings table read once, keyed by leaf. */
type SettingsRows = Map<string, { value: string; updated_at: number; updated_by: string }>;

/** Stores whose settings reads answer from one read made earlier. */
const SNAPSHOTS = new WeakMap<RelationalStore, SettingsRows>();
const SNAPSHOT_REVISIONS = new WeakMap<RelationalStore, Record<string, number>>();

function snapshotRows(states: ReadonlyMap<string, SettingState>): SettingsRows {
  return new Map([...states].flatMap(([leaf, row]) => row.value === null ? [] : [[leaf, { value: row.value, updated_at: row.updated_at!, updated_by: row.updated_by! }] as const]));
}

/**
 * A view of `db` whose settings reads all answer from one read of the settings table, made now; every other
 * statement goes to `db` itself. A request that resolves many policies reads the table once through it.
 */
export async function settingsSnapshot(db: RelationalStore): Promise<RelationalStore> {
  if (SNAPSHOTS.has(db)) return db;
  const states = await readSettingStates(db, DEPLOYMENT_LEAVES);
  const view = new Proxy(db, { get: (target, key) => { const member = Reflect.get(target, key, target) as unknown; return typeof member === 'function' ? member.bind(target) : member; } });
  SNAPSHOTS.set(view, snapshotRows(states));
  SNAPSHOT_REVISIONS.set(view, Object.fromEntries([...states].map(([leaf, row]) => [leaf, row.revision])));
  return view;
}

const revisionUnchanged = observedSettingsAssertion(observedRevisionPredicate({},true).sql);

/** A fresh policy view and its revision assertion for an atomic consumer mutation. */
export async function observedSettingsGuard(db:RelationalStore,leaves:readonly string[],compact=false):Promise<{
  view:RelationalStore;sql:string;params:unknown[];revisions:Record<string,number>;assertion:Bound;
}> {
  const states = await readSettingStates(db, leaves);
  const view = new Proxy(db, { get: (target, key) => {
    const member = Reflect.get(target, key, target) as unknown;
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  SNAPSHOTS.set(view, snapshotRows(states));
  const expected = Object.fromEntries([...states].map(([leaf, row]) => [leaf, row.revision]));
  SNAPSHOT_REVISIONS.set(view, expected);
  return { view, revisions:expected, assertion:revisionUnchanged.bind(JSON.stringify(expected)), ...observedRevisionPredicate(expected, compact) };
}

/** One stored leaf as a policy that judges its own stored values reads it: the value, and what its rule says of it. */
interface StoredSetting { value: unknown; violation: string | null }

/**
 * Each named leaf's stored value with its rule's verdict, for a policy that does not fall back to the default when the
 * stored value is unusable: one that holds, clamps or keeps everything instead. A leaf never written is absent.
 */
export async function storedSettings(db: RelationalStore, leaves: readonly string[]): Promise<Map<string, StoredSetting>> {
  const out = new Map<string, StoredSetting>();
  for (const [leaf, text] of await leafValues(db, leaves)) {
    let value: unknown;
    try { value = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; out.set(leaf, { value: text, violation: 'The stored value does not read' }); continue; }
    const spec = DEPLOYMENT_LEAF_SPECS[leaf];
    out.set(leaf, { value, violation: spec === undefined ? 'not a Deployment leaf' : leafRuleViolation(spec, value) });
  }
  return out;
}

/** The stored value of each named leaf, as the JSON text the settings surface wrote; a leaf never written is absent from the map. */
async function leafValues(db: RelationalStore, leaves: readonly string[]): Promise<Map<string, string>> {
  if (leaves.length === 0) return new Map();
  const snapshot = SNAPSHOTS.get(db);
  if (snapshot !== undefined) return new Map(leaves.flatMap((leaf) => { const row = snapshot.get(leaf); return row === undefined ? [] : [[leaf, row.value] as const]; }));
  return new Map((await readLeafValues(db, leaves)).map((row) => [row.leaf, row.value]));
}

/**
 * Leaf rules whose consumer judges a stored value itself, entry by entry or together with sibling leaves, and reports
 * what it cannot use: task overrides and execution profiles hold the task they name, and the embedding policy falls
 * back to the target's default.
 */
const SELF_JUDGED: ReadonlySet<string> = new Set(['task-overrides', 'profile-model', 'profile-effort', 'credential-source', 'embedding']);

/** Why a stored leaf's text is unusable, or null when it holds its rule. */
function storedLeafViolation(leaf: string, text: string): string | null {
  const spec = DEPLOYMENT_LEAF_SPECS[leaf];
  if (spec === undefined) return 'not a Deployment leaf';
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return 'The stored value does not read'; throw error; }
  return leafRuleViolation(spec, value);
}

/**
 * The text of each named leaf a consumer may act on: a declared default where nothing usable is written,
 * absent for a refused value with no declared default. Consumer defaults apply to absent values, and
 * the settings surface reports the stored value as invalid. Task overrides, execution profiles and the embedding
 * selection pass through whole: their consumers judge them.
 */
export async function settingTexts(db: RelationalStore, leaves: readonly string[]): Promise<Map<string, string>> {
  const held = await leafValues(db, leaves);
  for (const [leaf, text] of held) {
    const spec = DEPLOYMENT_LEAF_SPECS[leaf];
    if (spec !== undefined && 'type' in spec && SELF_JUDGED.has(spec.type)) continue;
    if (storedLeafViolation(leaf, text) !== null) held.delete(leaf);
  }
  for (const leaf of leaves) {
    const spec = DEPLOYMENT_LEAF_SPECS[leaf];
    if (!held.has(leaf) && spec !== undefined && 'default' in spec) held.set(leaf, JSON.stringify(spec.default));
  }
  return held;
}

/** The stored embedding leaves, each parsed; a leaf whose stored text is not JSON reads as an object, which no part accepts. */
export async function storedEmbedding(db: RelationalStore): Promise<StoredEmbedding> {
  const held = await leafValues(db, EMBEDDING_SELECTION_LEAVES);
  const stored: StoredEmbedding = {};
  for (const leaf of EMBEDDING_SELECTION_LEAVES) {
    const text = held.get(leaf);
    if (text === undefined) continue;
    try { stored[leaf] = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; stored[leaf] = { malformed: text }; }
  }
  return stored;
}

/** The models whose vectors the search index holds: every partition with a receipt whose deletion is not yet confirmed. */
export async function heldPartitions(db: RelationalStore) {
  return (await heldModels(db)).map((model) => heldPartition(model));
}

/** The stored embedding leaves as one write reads and conditions on them: each parsed, with its persistent revision. */
async function embeddingRows(db: RelationalStore): Promise<{ stored: StoredEmbedding; revisions: Record<string, number> }> {
  const states = await readSettingStates(db, EMBEDDING_SELECTION_LEAVES);
  const stored: StoredEmbedding = {};
  for (const [leaf, row] of states) {
    if (row.value === null) continue;
    const part = leaf as EmbeddingSelectionLeaf;
    try { stored[part] = JSON.parse(row.value); } catch (error) { if (!(error instanceof SyntaxError)) throw error; stored[part] = { malformed: row.value }; }
  }
  return { stored, revisions: Object.fromEntries([...states].map(([leaf, row]) => [leaf, row.revision])) };
}

function embeddingWriteParts(parts: ReadonlyArray<readonly [EmbeddingSelectionLeaf, unknown]>, before: StoredEmbedding) {
  return parts.filter(([leaf, value]) => value !== undefined || Object.hasOwn(before, leaf))
    .map(([leaf, value]) => ({ leaf, value }));
}

/** Why a candidate embedding selection, with `changes` the parts a write names, cannot be stored on the target; or what it resolves to. */
function judgeEmbeddingCandidate(candidate: StoredEmbedding, changes: StoredEmbedding, target: DeploymentTarget, leaf: string): { refusal: SettingsRefusal } | { refusal: null; resolved: ReturnType<typeof resolveEmbedding> } {
  const fixed = candidate['embedding.base_url'] !== undefined && changes['embedding.base_url'] !== undefined && isEmbeddingProvider(candidate['embedding.provider'])
    && !EMBEDDING_CATALOGUE[candidate['embedding.provider']].endpoint.editable ? EMBEDDING_CATALOGUE[candidate['embedding.provider']] : null;
  if (fixed !== null) {
    return { refusal: { reason: 'invalid_value', leaf, detail: `${fixed.label} uses its own endpoint; choose ${EMBEDDING_CATALOGUE['openai-compatible'].label} to name an endpoint of your own` } };
  }
  const resolved = resolveEmbedding(candidate, target);
  for (const [part, value] of Object.entries(changes) as Array<[EmbeddingSelectionLeaf, unknown]>) {
    if (value === undefined) continue;
    const { state, reason } = resolved.leaves[part];
    if (state === 'invalid' || state === 'not-applicable') return { refusal: { reason: 'invalid_value', leaf, detail: reason ?? 'refused' } };
  }
  return { refusal: null, resolved };
}

/** The leaves a whole embedding choice writes: a provider, and its model and endpoint, each absent where the choice leaves it at its default. */
const embeddingChoiceLeaves = (choice: EmbeddingChoice): StoredEmbedding =>
  ({ 'embedding.provider': choice.provider, 'embedding.model': choice.model, 'embedding.base_url': choice.endpoint });

/**
 * A whole embedding choice judged as `setEmbedding` judges it on the target, before the model change itself is: the
 * selection it resolves to, or why it cannot be stored.
 */
export function judgeEmbeddingChoice(choice: EmbeddingChoice, target: DeploymentTarget): { refusal: SettingsRefusal } | { refusal: null; selection: EmbeddingSelection | null; stored: StoredEmbedding } {
  const leaf = 'embedding.provider';
  const changes = embeddingChoiceLeaves(choice);
  for (const [part, value] of Object.entries(changes) as Array<[EmbeddingSelectionLeaf, unknown]>) {
    const violation = value === undefined ? null : embeddingPartViolation(part, value);
    if (violation !== null) return { refusal: { reason: 'invalid_value', leaf: part, detail: violation } };
  }
  const stored = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as StoredEmbedding;
  const judged = judgeEmbeddingCandidate(stored, changes, target, leaf);
  return judged.refusal !== null ? judged : { refusal: null, selection: judged.resolved.selection, stored };
}

/** Why the embedding selection cannot change while a switch stands. */
export const switchUnderWay = (model: string): string => `A switch to ${model} is under way. Cancel it under Search embeddings to choose another model`;

/** Judge the selection, then assert its revisions, switch state and held partitions in the write batch. */
async function writeEmbedding(db: RelationalStore, input: { target: DeploymentTarget | undefined; changes: StoredEmbedding; actor: string; now: number; leaf: string; expected?: Readonly<Record<string, number>> }): Promise<SettingsResult> {
  const { target, changes, actor, now: nowMs, leaf, expected: expectedRevisions } = input;
  if (target === undefined) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'this write names no server type, so the embedding choice cannot be judged' } };
  const underWay = await readSwitch(db);
  if (underWay !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: switchUnderWay(underWay.model) } };
  const { stored: before, revisions } = await embeddingRows(db);
  const candidate: StoredEmbedding = { ...before };
  const parts = Object.entries(changes) as Array<[EmbeddingSelectionLeaf, unknown]>;
  for (const [part, value] of parts) {
    if (value === undefined) delete candidate[part];
    else candidate[part] = value;
  }
  const judged = judgeEmbeddingCandidate(candidate, changes, target, leaf);
  if (judged.refusal !== null) return { applied: false, refusal: judged.refusal };
  const resolved = judged.resolved;
  const held = await heldPartitions(db);
  const refusal = selectionChangeRefusal(resolveEmbedding(before, target).selection, resolved.selection, held);
  if (refusal !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: refusal } };

  const expected = { ...revisions, ...expectedRevisions };
  const written = await persistSettings(db, admittedChange({
    parts: embeddingWriteParts(parts, before), expected, actor, now: nowMs, embeddingEmpty: held.length === 0,
  }));
  if (written === 'switch_started') {
    const started = await readSwitch(db);
    return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: switchUnderWay(started?.model ?? 'another model'), next: 'GET /api/embedding/switch shows how far it has got; nothing was saved. Change the selection once it finishes or is cancelled.' } };
  }
  return written === 'applied' ? { applied: true } : conflict(db, leaf, expected);
}

/** Atomically publish a completed selection and end its still-complete switch. */
export async function writeSwitchedEmbedding(
  db: RelationalStore, choice: StoredEmbedding, actor: string, nowMs: number, sw: EmbeddingSwitch,
): Promise<boolean> {
  const { stored: before, revisions } = await embeddingRows(db);
  const written = await persistSettings(db, admittedChange({
    parts: embeddingWriteParts(EMBEDDING_SELECTION_LEAVES.map(leaf => [leaf, choice[leaf]] as const), before),
    expected: revisions, actor, now: nowMs,
  }), { sw, now: nowMs });
  return written === 'applied';
}

/** Current task capabilities and live-project admission for the retained run protocol. */
export async function taskWorkEnabled(db: RelationalStore, projectId: string, task: string | null): Promise<boolean> {
  const gate = task === null ? null : admissionForTask(task);
  return gate?.kind === 'capability'
    ? settingsWriter(db).capabilityEnabled(projectId, gate.capability)
    : projectWorkEnabled(db, projectId);
}

function requestedCapabilities(capabilities: readonly ProjectCapability[]): string {
  return capabilities.map(() => 'SELECT ? AS capability').join(' UNION ALL ');
}

/** Enabled capabilities for every stored Project or the Project named, in one statement. */
export function enabledCapabilities(db: RelationalStore, capabilities: readonly ProjectCapability[], projectId?: string): {
  statement: PreparedStatement;
  read: (rows: ReadonlyArray<Record<string, unknown>>) => Array<{ projectId: string; capability: string }>;
} {
  const statement = db.prepare(
    capabilities.length === 0
      ? 'SELECT project_id AS projectId, NULL AS capability FROM projects WHERE 0'
      : `SELECT p.project_id AS projectId, requested.capability FROM projects p
         CROSS JOIN (${requestedCapabilities(capabilities)}) requested
         WHERE ${capabilityOnSql('p.project_id', 'requested.capability')}${projectId === undefined ? '' : ' AND p.project_id = ?'}`,
  ).bind(...capabilities, ...(capabilities.length === 0 || projectId === undefined ? [] : [projectId]));
  return { statement, read: (rows) => rows.map((row) => ({ projectId: String(row.projectId), capability: String(row.capability) })) };
}

/**
 * `target` is the Deployment target the writes land on. A write of an embedding leaf is judged against it and is
 * refused where none is named.
 */
export function settingsWriter(
  db: RelationalStore,
  opts: { authorize?: SettingsAuthorizer; rearm?: ScheduleRearm; target?: DeploymentTarget } = {},
): SettingsWriter {
  const authorize = opts.authorize ?? (async () => true);
  const rearm = opts.rearm ?? (async () => {});
  const apply = async (leaf: string, change: Omit<AdmittedSettingsChange, typeof admittedSettings>): Promise<SettingsResult> => {
    const outcome = await persistSettings(db, admittedChange(change));
    if (outcome === 'inactive') return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'Project is not active' } };
    if (outcome === 'conflict') return conflict(db, leaf, change.expected, change.capability ? `capability:${change.project!}` : change.project ?? '');
    if (change.parts.length > 0) await rearm({ leaf });
    return { applied: true };
  };
  const observed = async (leaves: readonly string[], expectedRevision?: number, scope = '') => {
    const states = await readSettingStates(db, leaves, scope);
    return { states, expected: Object.fromEntries([...states].map(([leaf, row], index) => [leaf, index === 0 ? expectedRevision ?? row.revision : row.revision])) };
  };
  const withLeafWrite = async (change: Parameters<SettingsAuthorizer>[0], write: () => Promise<SettingsResult>): Promise<SettingsResult> => {
    const { leaf } = change;
    if (!DEPLOYMENT_LEAF_SET.has(leaf)) return { applied: false, refusal: { reason: 'not_deployment_tier', leaf } };
    if (!(await authorize(change))) return { applied: false, refusal: { reason: 'unauthorized', leaf } };
    if (RETIRED_LEAVES.has(leaf)) return { applied: false, refusal: { reason: 'retired', leaf } };
    return write();
  };

  const TASK_PATCH_ATTEMPTS = 2;
  /** Per-key patches retry once only when the caller supplies no revision. */
  const patchTask = async (task: string, actor: string, nowMs: number, expectedRevision: number | undefined,
    patch: (entry: Record<string, unknown>) => Record<string, unknown> | null, repairEntry = false, validate?: () => string | null): Promise<SettingsResult> => {
    const leaf = 'agent.tasks';
    return withLeafWrite({ leaf, value: { task }, actor }, async () => {
      const invalid = validate?.();
      if (invalid != null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: invalid } };
      let last: Readonly<Record<string, number>> = {};
      for (let attempt = 0; attempt < TASK_PATCH_ATTEMPTS; attempt++) {
        const { states, expected } = await observed([leaf], attempt === 0 ? expectedRevision : undefined);
        last = expected;
        let held: unknown = {};
        const text = states.get(leaf)!.value;
        try { if (text !== null) held = JSON.parse(text); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; held = null; }
        const unreadable: SettingsResult = { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'the task overrides held by the server cannot be read' } };
        if (!isRecord(held)) return unreadable;
        const current = Object.hasOwn(held, task) ? held[task] : {};
        if (!isRecord(current) && !repairEntry) return unreadable;
        const entry = patch(isRecord(current) ? current : {});
        if (entry === null) return unreadable;
        const value = { ...held };
        if (Object.keys(entry).length === 0) delete value[task];
        else value[task] = entry;
        const detail = leafRuleViolation(DEPLOYMENT_LEAF_SPECS[leaf]!, value, held);
        if (detail !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail } };
        const written = await apply(leaf, { parts: [{ leaf, value }], expected, actor, now: nowMs });
        if (written.applied || written.refusal.reason !== 'conflict' || expectedRevision !== undefined) return written;
      }
      return conflict(db, leaf, last);
    });
  };

  return {
    async setProjectLeaf(projectId, leaf, value, actor, nowMs, expectedRevision) {
      const spec = PROJECT_LEAF_SPECS[leaf];
      if (spec === undefined) return { applied: false, refusal: { reason: 'not_deployment_tier', leaf } };
      if (!(await authorize({ leaf, value, actor }))) return { applied: false, refusal: { reason: 'unauthorized', leaf } };
      const detail = leafRuleViolation(spec, value);
      if (detail !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail } };
      const { expected } = await observed([leaf], expectedRevision, projectId);
      return apply(leaf, { project: projectId, parts: [{ leaf, value }], expected, actor, now: nowMs });
    },
    async setLeaf(leaf, value, actor, nowMs, expectedRevision) {
      return withLeafWrite({ leaf, value, actor }, async () => {
        const spec = DEPLOYMENT_LEAF_SPECS[leaf]!;
        if ('type' in spec && spec.type === 'embedding') {
          const detail = leafRuleViolation(spec, value);
          if (detail !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail } };
          const written = await writeEmbedding(db, { target: opts.target, changes: { [spec.leaf]: value }, actor, now: nowMs, leaf,
            ...(expectedRevision === undefined ? {} : { expected: { [leaf]: expectedRevision } }) });
          if (written.applied) await rearm({ leaf });
          return written;
        }
        const retention = leaf === 'retention.raw_days' || leaf === 'retention.transcripts';
        const { states, expected } = await observed(retention ? [leaf, leaf === 'retention.raw_days' ? 'retention.transcripts' : 'retention.raw_days'] : [leaf], expectedRevision);
        const previousRaw = states.get(leaf)?.value;
        let previous: unknown = leaf === 'agent.tasks' ? {} : undefined;
        if (previousRaw != null) {
          try { previous = JSON.parse(previousRaw) as unknown; }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
        const detail = leafRuleViolation(spec, value, previous);
        if (detail !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail } };
        if (retention) {
          const target = leaf === 'retention.transcripts' && value === 0 ? leaf : 'retention.raw_days';
          const other = target === 'retention.raw_days' ? 'retention.transcripts' : 'retention.raw_days';
          return apply(target, { parts: [{ leaf: target, value }, { leaf: other, value: undefined }], expected, actor, now: nowMs });
        }
        return apply(leaf, { parts: [{ leaf, value: leaf === 'agent.tasks' ? preserveRetiredTaskOverrides(value, previous) : value }], expected, actor, now: nowMs });
      });
    },

    async setEmbedding(choice, actor, nowMs, expectedRevisions) {
      const leaf = 'embedding.provider';
      return withLeafWrite({ leaf, value: choice, actor }, async () => {
        const changes = embeddingChoiceLeaves(choice);
        for (const [part, value] of Object.entries(changes) as Array<[EmbeddingSelectionLeaf, unknown]>) {
          const violation = value === undefined ? null : embeddingPartViolation(part, value);
          if (violation !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf: part, detail: violation } };
        }
        const written = await writeEmbedding(db, { target: opts.target, changes, actor, now: nowMs, leaf, ...(expectedRevisions === undefined ? {} : { expected: expectedRevisions }) });
        if (written.applied) for (const part of EMBEDDING_SELECTION_LEAVES) await rearm({ leaf: part });
        return written;
      });
    },

    async resetLeaf(leaf, actor, nowMs = Date.now(), expectedRevision) {
      return withLeafWrite({ leaf, actor }, async () => {
        const spec = DEPLOYMENT_LEAF_SPECS[leaf]!;
        if ('type' in spec && spec.type === 'embedding') {
          const written = await writeEmbedding(db, { target: opts.target, changes: { [spec.leaf]: undefined }, actor, now: nowMs, leaf,
            ...(expectedRevision === undefined ? {} : { expected: { [leaf]: expectedRevision } }) });
          if (written.applied) await rearm({ leaf });
          return written;
        }
        const parts = (leaf === 'retention.raw_days' || leaf === 'retention.transcripts')
          ? [leaf, leaf === 'retention.raw_days' ? 'retention.transcripts' : 'retention.raw_days'] : [leaf];
        const { expected } = await observed(parts, expectedRevision);
        return apply(leaf, { parts: parts.map(leaf => ({ leaf, value: undefined })), expected, actor, now: nowMs });
      });
    },

    async repairTaskDocument(actor, nowMs, expectedRevision) {
      const leaf = 'agent.tasks';
      return withLeafWrite({ leaf, actor }, async () => {
        const { states, expected } = await observed([leaf], expectedRevision);
        const current = states.get(leaf)!.value;
        if (current === null) return apply(leaf, { parts: [], expected, actor, now: nowMs });
        let stored: unknown;
        try { stored = JSON.parse(current); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'the task overrides held by the server cannot be read' } };
        }
        const cleaned = cleanTaskDocument(stored);
        if (cleaned === null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'the task overrides held by the server are not an object' } };
        const detail = leafRuleViolation(DEPLOYMENT_LEAF_SPECS[leaf]!, cleaned, stored);
        if (detail !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail } };
        const parts = JSON.stringify(cleaned) === JSON.stringify(stored) ? [] : [{ leaf, value: cleaned }];
        return apply(leaf, { parts, expected, actor, now: nowMs });
      });
    },

    async setTaskSwitch(task, enabled, actor, nowMs, expectedRevision) {
      return patchTask(task, actor, nowMs, expectedRevision, entry => {
        const schedule = Object.hasOwn(entry, 'schedule') ? entry.schedule : {};
        if (!isRecord(schedule)) return null;
        return { ...entry, schedule: { ...schedule, enabled } };
      });
    },

    async setTaskTier(task, tier, actor, nowMs, expectedRevision) {
      return patchTask(task, actor, nowMs, expectedRevision, entry => {
        const next = { ...entry };
        if (tier === null) delete next.reasoningLevel;
        else next.reasoningLevel = tier;
        return next;
      }, true, () => {
        if (!(OUTCOME_TASKS as readonly string[]).includes(task)) return 'unknown task';
        if (TASK_EXECUTION_PROFILES[task] !== undefined) return 'this task has a fixed execution profile';
        if (tier !== null && !isReasoningTier(tier)) return 'expected low, default, high, or null';
        return null;
      });
    },

    async setCapability(projectId, capability, enabled, actor, nowMs, expectedRevision) {
      if (!(PROJECT_CAPABILITIES as readonly string[]).includes(capability)) {
        return { applied: false, refusal: { reason: 'unknown_capability', capability } };
      }
      const leaf = `project.${capability}`;
      if (!(await authorize({ leaf, actor }))) {
        return { applied: false, refusal: { reason: 'unauthorized', leaf } };
      }
      const revisions = await settingRevisions(db, `capability:${projectId}`);
      return apply(leaf, { project: projectId, capability: true, parts: [{ leaf: capability, value: enabled }],
        expected: { [capability]: expectedRevision ?? revisions[capability] ?? 0 }, actor, now: nowMs });
    },

    async leaves() {
      const snapshot = SNAPSHOTS.get(db);
      const results = snapshot !== undefined ? [...snapshot.entries()].map(([leaf, row]) => ({ ...row, leaf })) : await readEveryLeaf(db);
      const out: Record<string, LeafRecord> = {};
      for (const r of results) {
        try {
          out[r.leaf] = { value: JSON.parse(r.value), updatedAt: r.updated_at, updatedBy: r.updated_by };
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          out[r.leaf] = { value: null, updatedAt: r.updated_at, updatedBy: r.updated_by, malformed: true };
        }
      }
      return out;
    },

    capabilityEnabled: (projectId, capability) => readCapabilityOn(db, projectId, capability),
    retiredCapabilities: (projectId) => readRetiredCapabilities(db, projectId, PROJECT_CAPABILITIES),
    capabilities: async (projectId) => readCapabilities(db, projectId, PROJECT_CAPABILITIES) as Promise<Record<ProjectCapability, boolean>>,
  };
}

export async function dailyBudget(db: RelationalStore): Promise<number> {
  const text=(await settingTexts(db,[BUDGET_LEAF])).get(BUDGET_LEAF);
  return text===undefined?BUDGET_DEFAULT_USD:JSON.parse(text) as number;
}

/** The history switch as the learning stages and settings surface both resolve it. */
export async function learningHistoryEnabled(db: RelationalStore): Promise<boolean> {
  const text = (await settingTexts(db, ['agent.learning_history_enabled'])).get('agent.learning_history_enabled');
  return text !== undefined && JSON.parse(text) === true;
}

export const CURATION_DAILY_LIMIT_LEAF = CURATION_DAILY_LIMIT_SETTING.leaf;
export const CURATION_DAILY_LIMIT_MAX = CURATION_DAILY_LIMIT_SETTING.rule.max;
const PROJECT_LEAF_SPECS: Readonly<Record<string, LeafSpec>> = {
  [CURATION_DAILY_LIMIT_LEAF]: CURATION_DAILY_LIMIT_SETTING.rule,
};
export const PROJECT_LEAVES = Object.keys(PROJECT_LEAF_SPECS);

/** One Project's admitted daily ceiling, with its declared default. */
export const curationDailyLimitSql = projectCurationLimitSql;
export const curationDailyLimit = readCurationLimit;

/** A Project editor reads values and their revisions in one SQL instant. */
export async function projectSettingsEditor(db: RelationalStore, project: string) {
  const state = await readProjectEditor(db, project);
  return {
    capabilities: Object.fromEntries(PROJECT_CAPABILITIES.map(capability => [capability,
      state.active && (state.capabilities[capability] ?? (DEFAULT_OFF_CAPABILITIES.includes(capability) ? 0 : 1)) === 1])),
    retiredCapabilities: Object.fromEntries(Object.entries(state.capabilities).filter(([capability]) => !(PROJECT_CAPABILITIES as readonly string[]).includes(capability)).map(([capability, value]) => [capability, value === 1])),
    settings: { [CURATION_DAILY_LIMIT_LEAF]: state.limit }, revisions: state.revisions, capabilityRevisions: state.capabilityRevisions,
  };
}
