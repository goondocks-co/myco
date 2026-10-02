import { CANOPY_DEFAULT_EXCLUDE_PATTERNS } from '@goondocks/myco-shared/canopy';
import type { PreparedStatement, RelationalStore } from './adapters.js';
import { captureFolderRefusal, planFolderRefusal, ROOT_KEY_PATTERN } from '@goondocks/myco-shared/member-protocol';
import { INSTRUCTIONS_TEMPLATE_MAX_BYTES, IMPORT_MAX_SESSIONS_MAX, IMPORT_WINDOW_DAYS_MAX } from '../constants.js';
import { CONFIGURABLE_PROFILE_HARNESSES, PROFILE_HARNESSES, REASONING_TIERS, isReasoningTier, modelRefusal, effortRefusal, type ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import { OUTCOME_TASKS } from './task-catalogue.js';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { EMBEDDING_CATALOGUE, isEmbeddingProvider, type DeploymentTarget } from '@goondocks/myco-shared/settings-contract';
import {
  EMBEDDING_SELECTION_LEAVES, embeddingEndpointRefusal, heldPartition, resolveEmbedding, selectionChangeRefusal,
  type EmbeddingSelectionLeaf, type StoredEmbedding,
} from './embedding/policy.js';

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
export const PROJECT_CAPABILITIES = ['cortex', 'canopy', 'vault_evolution'] as const;
export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

/**
 * The rule a leaf's value satisfies at write, or `{}` for a retired leaf, whose
 * writes are refused whatever they carry.
 *
 * Declarative data rather than a validator function: a gate reads it, and the
 * settings surface reports a stored value that breaks it as invalid, with its
 * remedy, rather than acting on it. A consumer reads a live leaf through
 * `settingTexts`, which hands it only a value that holds its rule.
 *
 * `boolean` means true or false. `integer` with `nullable` also takes null,
 * which means the same as no value. `agent` names an agent a worker can run,
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
  | { readonly type: 'integer'; readonly min: number; readonly max: number; readonly nullable?: true }
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
  'agent.cold_project_threshold_days': { type: 'integer', min: 0, max: 365 },
  'agent.event_tasks_enabled': {},
  // Preserved for stored-history inspection; writes to retired leaves are refused.
  'agent.harness': {},
  'agent.limits.concurrent_runs': LIMIT_SPEC,
  'agent.limits.task_concurrent_runs': LIMIT_SPEC,
  'agent.limits.task_runs_per_hour': LIMIT_SPEC,
  'agent.model': {},
  'agent.provider.base_url': {},
  'agent.provider.context_length': {},
  'agent.provider.effort_map.default.effort': {},
  'agent.provider.effort_map.default.verbosity': {},
  'agent.provider.effort_map.high.effort': {},
  'agent.provider.effort_map.high.verbosity': {},
  'agent.provider.effort_map.low.effort': {},
  'agent.provider.effort_map.low.verbosity': {},
  'agent.provider.local_backend': {},
  'agent.provider.model': {},
  'agent.provider.reasoning_map.default': {},
  'agent.provider.reasoning_map.high': {},
  'agent.provider.reasoning_map.low': {},
  'agent.provider.thinking_budget_map.default': {},
  'agent.provider.thinking_budget_map.high': {},
  'agent.provider.thinking_budget_map.low': {},
  'agent.provider.type': {},
  'agent.reasoningLevel': {},
  ...Object.fromEntries(CONFIGURABLE_PROFILE_HARNESSES.flatMap((harness) => [
    ...REASONING_TIERS.map((tier) => [`agent.reasoning_map.${harness}.${tier}`, { type: 'profile-model', harness }]),
    ...REASONING_TIERS.map((tier) => [`agent.effort_map.${harness}.${tier}`, { type: 'profile-effort', harness }]),
    [`agent.harnesses.${harness}.credential`, { type: 'credential-source' }],
  ])),
  'agent.run_retention_days': { type: 'integer', min: 1, max: 365 },
  'agent.scheduled_tasks_active_window_days': { type: 'integer', min: 0, max: 365 },
  'agent.scheduled_tasks_enabled': BOOLEAN_SPEC,
  'agent.semantic_write_check_enabled': {},
  'agent.summary_batch_interval': {},
  'agent.tasks': { type: 'task-overrides' },
  'backup.auto_interval_hours': { type: 'integer', min: 1, max: 720 },
  // #1547: whether a member's machine may create a project for a repository it meets that no project holds. Absent
  // means on; an admin turns it off to keep project creation with admins.
  'capture.auto_create_projects': BOOLEAN_SPEC,
  'backup.recovery.keep_stagings': { type: 'integer', min: 1, max: 30 },
  'backup.retention.keep_daily': { type: 'integer', min: 1, max: 365 },
  'backup.retention.keep_weekly': { type: 'integer', min: 0, max: 52 },
  'cortex.canopy.exclude.default_patterns': {},
  'cortex.canopy.exclude.patterns': { type: 'pattern-list', maxItems: 100, maxChars: 256 },
  'cortex.canopy.refresh.background_enabled': BOOLEAN_SPEC,
  'cortex.canopy.refresh.background_period_minutes': { type: 'integer', min: 1, max: 10_080 },
  'cortex.digest.inject_on_session_start': {},
  'cortex.digest.tier': {},
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
  'notifications.retention_days': {},
  'release_provenance.reconcile_interval_minutes': { type: 'integer', min: 1, max: 1440 },
  // #1147 — transcript-first ingest. Unset or 0 keeps raw transcripts forever.
  // A window prunes only processed raw bytes (`ingest/retention.ts`), and is how
  // a Deployment manages storage: capture is never refused (#1416).
  'retention.transcripts': { type: 'integer', min: 0, max: 3650 },
  'skills.confidence_threshold': {},
  'skills.usage_stale_days': {},
  // #1151 — worker mode: the harness a worker prefers and the order it falls back through.
  'worker.harness': { type: 'agent' },
  'worker.harness_fallback': { type: 'agent-list' },
};

/**
 * Retired editable contracts retained for inspection and recovery. Ordinary worker outcomes do not read them.
 * The retained runtime probe is the sole consumer of archived provider preferences.
 * The writer refuses mutations and the API reports stored rows as retired metadata.
 */
export const RETIRED_LEAVES: ReadonlySet<string> = new Set([
  'agent.event_tasks_enabled',
  'agent.harness',
  'agent.provider.type',
  'agent.provider.model',
  'agent.provider.base_url',
  'agent.provider.context_length',
  'agent.provider.effort_map.default.effort',
  'agent.provider.effort_map.default.verbosity',
  'agent.provider.effort_map.high.effort',
  'agent.provider.effort_map.high.verbosity',
  'agent.provider.effort_map.low.effort',
  'agent.provider.effort_map.low.verbosity',
  'agent.provider.local_backend',
  'agent.model',
  'agent.provider.reasoning_map.default',
  'agent.provider.reasoning_map.high',
  'agent.provider.reasoning_map.low',
  'agent.provider.thinking_budget_map.default',
  'agent.provider.thinking_budget_map.high',
  'agent.provider.thinking_budget_map.low',
  'agent.reasoningLevel',
  'agent.semantic_write_check_enabled',
  'agent.summary_batch_interval',
  'cortex.canopy.exclude.default_patterns',
  'cortex.digest.inject_on_session_start',
  'cortex.digest.tier',
  'notifications.retention_days',
  'skills.confidence_threshold',
  'skills.usage_stale_days',
]);

/** Secret slots the Deployment still stores that nothing reads. Held to its readers by the same gate as `RETIRED_LEAVES`. */
export const RETIRED_SECRET_SLOTS: ReadonlySet<string> = new Set(['github']);

/** The leaves this tier owns. Derived from the specs, so a leaf cannot be named in one and missing from the other. */
export const DEPLOYMENT_LEAVES: readonly string[] = Object.keys(DEPLOYMENT_LEAF_SPECS);

/** Derived settings metadata, independent of any stored retired override. */
export function derivedLeafMetadata(leaf: string): { effectiveValue: unknown; source: 'derived' } | null {
  return leaf === 'cortex.canopy.exclude.default_patterns'
    ? { effectiveValue: CANOPY_DEFAULT_EXCLUDE_PATTERNS, source: 'derived' } : null;
}

/** The built-in value of one execution profile leaf on this Deployment. */
export function executionProfileLeafDefault(leaf: string, credentialSource: 'deployment' | 'worker-login'): { present: boolean; value: string | null } | null {
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
    return { present: true, value: credentialSource };
  }
  return null;
}

const DEPLOYMENT_LEAF_SET = new Set(DEPLOYMENT_LEAVES);

/** Any ASCII control character but newline and tab; a stored setting is text a person edits, not a control stream. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Live task controls and their preserved read-only preferences. */
export function taskOverridesMetadata(value: unknown): { editableValue: unknown; retiredValue: Record<string, unknown> } {
  if (!isRecord(value)) return { editableValue: value, retiredValue: {} };
  const editableValue: Record<string, unknown> = {};
  const retiredValue: Record<string, unknown> = {};
  for (const [task, entry] of Object.entries(value)) {
    if (task === 'container-smoke') { retiredValue[task] = entry; continue; }
    if (!isRecord(entry)) { editableValue[task] = entry; continue; }
    const { provider, ...live } = entry;
    editableValue[task] = live;
    if (Object.hasOwn(entry, 'provider')) retiredValue[task] = { provider };
  }
  return { editableValue, retiredValue };
}

/** Retired preferences survive replacement of the live overrides document. */
function preserveRetiredTaskOverrides(value: unknown, previous: unknown): unknown {
  if (!isRecord(value)) return value;
  const { retiredValue } = taskOverridesMetadata(previous);
  const merged = { ...value };
  for (const [task, archived] of Object.entries(retiredValue)) {
    merged[task] = task === 'container-smoke' ? archived
      : { ...(isRecord(merged[task]) ? merged[task] : {}), ...(isRecord(archived) ? archived : {}) };
  }
  return merged;
}

/**
 * The schedule counts a task override carries, each a whole number of 0 or more when given: the clock's own daily
 * ceiling, and how many runs of the task a member who is not an admin may start by hand in a day.
 */
export const SCHEDULE_COUNT_FIELDS = ['maxRunsPerDay', 'memberRunsPerDay'] as const;

/** What a changed per-task override violates; unchanged stored fields remain available for a separate repair. */
function taskOverridesViolation(value: unknown, previous?: unknown): string | null {
  if (!isRecord(value)) return 'expected an object of task overrides';
  const prior = isRecord(previous) ? previous : {};
  for (const [task, override] of Object.entries(value)) {
    const before = prior[task];
    if (previous !== undefined && task === 'container-smoke') return `${task}: retired task overrides are read-only`;
    if (previous !== undefined && isRecord(override) && Object.hasOwn(override, 'provider')) return `${task}.provider: provider preferences are retired; choose an execution profile`;
    if (override === before) continue;
    if (!isRecord(override)) return `${task}: expected an object of task overrides`;
    const old = isRecord(before) ? before : {};
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

/** Why a settings write did not apply. Each names a fault in the caller's own request; none is retryable. */
export type SettingsRefusal =
  | { reason: 'not_deployment_tier'; leaf: string }
  | { reason: 'invalid_value'; leaf: string; detail: string }
  | { reason: 'unauthorized'; leaf: string }
  | { reason: 'retired'; leaf: string }
  /** Another write changed the leaves this one is judged against before it landed; nothing is written. */
  | { reason: 'conflict'; leaf: string }
  | { reason: 'unknown_capability'; capability: string };

/** A stored leaf: its value and who last wrote it. */
export interface LeafRecord {
  value: unknown;
  updatedAt: number;
  updatedBy: string;
  malformed?: true;
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
export type SettingsAuthorizer = (change: { leaf: string; value?: unknown; actor: string }) => Promise<boolean>;

/** Re-arms whatever the change may have moved. Supplied by the caller so this module never decides what runs. */
export type ScheduleRearm = (change: { leaf: string }) => Promise<void>;

/** The embedding selection one write sets: a provider, and its model and endpoint, each left at its default when absent. */
export interface EmbeddingChoice { provider: unknown; model?: unknown; endpoint?: unknown }

export interface SettingsWriter {
  /** Set one Deployment leaf. */
  setLeaf(leaf: string, value: unknown, actor: string, nowMs: number): Promise<SettingsResult>;
  /** Set the whole embedding selection at once, so a provider never meets a model or endpoint it does not offer. */
  setEmbedding(choice: EmbeddingChoice, actor: string, nowMs: number): Promise<SettingsResult>;
  /** Remove one configured leaf so its built-in value applies. */
  resetLeaf(leaf: string, actor: string, nowMs?: number): Promise<SettingsResult>;
  /**
   * Set one task's schedule switch in the task overrides document, keeping every other field. An absent task entry or
   * schedule is created; a stored document, entry or schedule that is present and not an object is refused.
   */
  setTaskSwitch(task: string, enabled: boolean, actor: string, nowMs: number): Promise<SettingsResult>;
  /** Change one task tier in the live task overrides document. */
  setTaskTier(task: string, tier: ReasoningTier | null, actor: string, nowMs: number): Promise<SettingsResult>;
  /** Admit or withdraw a Project's capability. */
  setCapability(projectId: string, capability: string, enabled: boolean, actor: string, nowMs: number): Promise<SettingsResult>;
  /** Every stored Deployment leaf. Absent leaves are not defaulted here; a reader layers these over its own defaults. */
  leaves(): Promise<Record<string, LeafRecord>>;
  /**
   * Whether `projectId` is admitted to `capability`.
   *
   * ABSENT MEANS FALSE. A Project appears from a member's first write with no
   * provisioning step, so anything else silently admits every new Project to
   * every cost-bearing capability.
   */
  capabilityEnabled(projectId: string, capability: ProjectCapability): Promise<boolean>;
  /** Every capability this Project is admitted to. */
  capabilities(projectId: string): Promise<Record<ProjectCapability, boolean>>;
  /** Stored admissions for capabilities outside the live set, for read-only inspection. */
  retiredCapabilities(projectId: string): Promise<Record<string, boolean>>;
}

/**
 * SQL over one leaf's stored text, for an admission that runs inside another
 * module's batch.
 *
 * The settings store is the only module that names its own table, so a check
 * elsewhere reads through this rather than spelling the query itself: one
 * module knows how a leaf is stored, and every admission over a leaf asks it.
 *
 * `admission` holds while the leaf is absent or carries anything but `off`;
 * `read` answers the row that carries it.
 */
export function leafOffChecks(leaf: string, off: string): { admission: { sql: string; params: string[] }; read: { sql: string; params: string[] } } {
  return {
    admission: { sql: `NOT EXISTS (SELECT 1 FROM deployment_settings WHERE leaf = ? AND value = ?)`, params: [leaf, off] },
    read: { sql: `SELECT 1 AS disabled FROM deployment_settings WHERE leaf = ? AND value = ?`, params: [leaf, off] },
  };
}

/** A settings table read once, keyed by leaf. */
type SettingsRows = Map<string, { value: string; updated_at: number; updated_by: string }>;

/** Stores whose settings reads answer from one read made earlier. */
const SNAPSHOTS = new WeakMap<RelationalStore, SettingsRows>();

/**
 * A view of `db` whose settings reads all answer from one read of the settings table, made now; every other
 * statement goes to `db` itself. A request that resolves many policies reads the table once through it.
 */
export async function settingsSnapshot(db: RelationalStore): Promise<RelationalStore> {
  if (SNAPSHOTS.has(db)) return db;
  const { results } = await db.prepare(`SELECT leaf, value, updated_at, updated_by FROM deployment_settings`)
    .all<{ leaf: string; value: string; updated_at: number; updated_by: string }>();
  const view = new Proxy(db, { get: (target, key) => { const member = Reflect.get(target, key, target) as unknown; return typeof member === 'function' ? member.bind(target) : member; } });
  SNAPSHOTS.set(view, new Map(results.map((row) => [row.leaf, row])));
  return view;
}

/** One stored leaf as a policy that judges its own stored values reads it: the value, and what its rule says of it. */
export interface StoredSetting { value: unknown; violation: string | null }

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
export async function leafValues(db: RelationalStore, leaves: readonly string[]): Promise<Map<string, string>> {
  if (leaves.length === 0) return new Map();
  const snapshot = SNAPSHOTS.get(db);
  if (snapshot !== undefined) return new Map(leaves.flatMap((leaf) => { const row = snapshot.get(leaf); return row === undefined ? [] : [[leaf, row.value] as const]; }));
  const rows = await db
    .prepare(`SELECT leaf, value FROM deployment_settings WHERE leaf IN (${leaves.map(() => '?').join(', ')})`)
    .bind(...leaves)
    .all<{ leaf: string; value: string }>();
  return new Map(rows.results.map((r) => [r.leaf, r.value]));
}

/**
 * Leaf rules whose consumer judges a stored value itself, entry by entry or together with sibling leaves, and reports
 * what it cannot use: task overrides and execution profiles hold the task they name, and the embedding policy falls
 * back to the target's default.
 */
const SELF_JUDGED: ReadonlySet<string> = new Set(['task-overrides', 'profile-model', 'profile-effort', 'credential-source', 'embedding']);

/** Why a stored leaf's text is unusable, or null when it holds its rule. */
export function storedLeafViolation(leaf: string, text: string): string | null {
  const spec = DEPLOYMENT_LEAF_SPECS[leaf];
  if (spec === undefined) return 'not a Deployment leaf';
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return 'The stored value does not read'; throw error; }
  return leafRuleViolation(spec, value);
}

/**
 * The stored text of each named leaf a consumer may act on: absent where nothing is written, and absent where the
 * stored value breaks the leaf's rule, so the consumer applies the same default it applies to an unwritten leaf and
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

/** The last reset instant of every leaf ever reset. */
export async function leafResets(db: RelationalStore): Promise<Map<string, number>> {
  const { results } = await db.prepare(`SELECT leaf, reset_at FROM deployment_setting_resets`).all<{ leaf: string; reset_at: number }>();
  return new Map(results.map((row) => [row.leaf, row.reset_at]));
}

/** The models whose vectors the search index holds: every partition with a receipt not yet deleted. */
export async function heldPartitions(db: RelationalStore) {
  const { results } = await db.prepare(`SELECT DISTINCT model_key FROM embedding_receipts WHERE ready >= 0`).all<{ model_key: string }>();
  return results.map((row) => heldPartition(row.model_key));
}

/** The stored embedding leaves as one write reads and conditions on them: each parsed, with the stamp of its last write. */
async function embeddingRows(db: RelationalStore): Promise<{ stored: StoredEmbedding; stamps: Map<string, string> }> {
  const { results } = await db.prepare(`SELECT leaf, value, updated_at, updated_by FROM deployment_settings WHERE leaf IN (${EMBEDDING_SELECTION_LEAVES.map(() => '?').join(', ')})`)
    .bind(...EMBEDDING_SELECTION_LEAVES).all<{ leaf: EmbeddingSelectionLeaf; value: string; updated_at: number; updated_by: string }>();
  const stored: StoredEmbedding = {};
  for (const row of results) {
    try { stored[row.leaf] = JSON.parse(row.value); } catch (error) { if (!(error instanceof SyntaxError)) throw error; stored[row.leaf] = { malformed: row.value }; }
  }
  return { stored, stamps: new Map(results.map((row) => [row.leaf, `${row.updated_at}:${row.updated_by}`])) };
}

/** A stored leaf's stamp, or `absent`, in SQL. Bound as: the leaf. */
const STAMP_SQL = `COALESCE((SELECT updated_at || ':' || updated_by FROM deployment_settings WHERE leaf = ?), 'absent')`;

/**
 * Judge and write a change to the embedding selection on this target, as one compare-and-set. `changes` names each
 * leaf written, with undefined for one removed. A written part that is invalid or not offered here is refused; so is
 * any change of the model identity while search holds results (`selectionChangeRefusal`). Every statement of the
 * write carries the condition that the three leaves still stand as they were judged, or as this write left them, and
 * that search still holds nothing where it held nothing: a write that lost a race to another changes nothing and
 * answers a conflict.
 */
async function writeEmbedding(db: RelationalStore, target: DeploymentTarget | undefined, changes: StoredEmbedding, actor: string, nowMs: number, leaf: string): Promise<SettingsResult> {
  if (target === undefined) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'this write names no server type, so the embedding choice cannot be judged' } };
  const { stored: before, stamps } = await embeddingRows(db);
  const candidate: StoredEmbedding = { ...before };
  const parts = Object.entries(changes) as Array<[EmbeddingSelectionLeaf, unknown]>;
  for (const [part, value] of parts) {
    if (value === undefined) delete candidate[part];
    else candidate[part] = value;
  }
  const fixed = candidate['embedding.base_url'] !== undefined && changes['embedding.base_url'] !== undefined && isEmbeddingProvider(candidate['embedding.provider'])
    && !EMBEDDING_CATALOGUE[candidate['embedding.provider']].endpoint.editable ? EMBEDDING_CATALOGUE[candidate['embedding.provider']] : null;
  if (fixed !== null) {
    return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: `${fixed.label} uses its own endpoint; choose ${EMBEDDING_CATALOGUE['openai-compatible'].label} to name an endpoint of your own` } };
  }
  const resolved = resolveEmbedding(candidate, target);
  for (const [part, value] of parts) {
    if (value === undefined) continue;
    const { state, reason } = resolved.leaves[part];
    if (state === 'invalid' || state === 'not-applicable') return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: reason ?? 'refused' } };
  }
  const held = await heldPartitions(db);
  const refusal = selectionChangeRefusal(resolveEmbedding(before, target).selection, resolved.selection, held);
  if (refusal !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: refusal } };

  const ours = `${nowMs}:${actor}`;
  const removed = new Set(parts.filter(([, value]) => value === undefined).map(([part]) => part));
  const unchanged = EMBEDDING_SELECTION_LEAVES.map((part) => `${STAMP_SQL} IN (?, ?${removed.has(part) ? ", 'absent'" : ''})`).join(' AND ')
    + (held.length === 0 ? ' AND NOT EXISTS (SELECT 1 FROM embedding_receipts WHERE ready >= 0)' : '');
  const unchangedBinds = EMBEDDING_SELECTION_LEAVES.flatMap((part) => [part, stamps.get(part) ?? 'absent', ours]);
  const statements = parts.flatMap(([part, value]) => value !== undefined
    ? [db.prepare(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) SELECT ?, ?, ?, ? WHERE ${unchanged}
        ON CONFLICT(leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(part, JSON.stringify(value), nowMs, actor, ...unchangedBinds)]
    : stamps.has(part) ? [
      db.prepare(`DELETE FROM deployment_settings WHERE leaf = ? AND ${unchanged}`).bind(part, ...unchangedBinds),
      db.prepare(`INSERT INTO deployment_setting_resets (leaf, reset_at, reset_by) SELECT ?, ?, ? WHERE ${unchanged}
        ON CONFLICT(leaf) DO UPDATE SET reset_at = excluded.reset_at, reset_by = excluded.reset_by`).bind(part, nowMs, actor, ...unchangedBinds),
    ] : []);
  if (statements.length === 0) return { applied: true };
  const results = await db.batch(statements);
  if (results.some((result) => result.meta.changes === 0)) return { applied: false, refusal: { reason: 'conflict', leaf } };
  return { applied: true };
}

/**
 * Every capability of `capabilities` a Project has turned on, for every Project or the one named, in one statement:
 * the read `capabilityEnabled` makes of one Project, made once for the Deployment.
 */
/** A capability turned on for a Project, as a condition a write carries. Bound as: Project, capability. */
export const CAPABILITY_ON_SQL = `EXISTS (SELECT 1 FROM project_capabilities pc WHERE pc.project_id = ? AND pc.capability = ? AND pc.enabled = 1)`;

export function enabledCapabilities(db: RelationalStore, capabilities: readonly ProjectCapability[], projectId?: string): {
  statement: PreparedStatement;
  read: (rows: ReadonlyArray<Record<string, unknown>>) => Array<{ projectId: string; capability: string }>;
} {
  const statement = db.prepare(
    `SELECT project_id AS projectId, capability FROM project_capabilities
      WHERE enabled = 1 AND capability IN (${capabilities.map(() => '?').join(', ')})${projectId === undefined ? '' : ' AND project_id = ?'}`,
  ).bind(...capabilities, ...(projectId === undefined ? [] : [projectId]));
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
  const resetRecord = (leaf: string, actor: string, nowMs: number) => db.prepare(`INSERT INTO deployment_setting_resets (leaf, reset_at, reset_by) VALUES (?, ?, ?)
    ON CONFLICT(leaf) DO UPDATE SET reset_at = excluded.reset_at, reset_by = excluded.reset_by`).bind(leaf, nowMs, actor);
  const withLeafWrite = async (change: Parameters<SettingsAuthorizer>[0], write: () => Promise<SettingsResult>): Promise<SettingsResult> => {
    const { leaf } = change;
    if (!DEPLOYMENT_LEAF_SET.has(leaf)) return { applied: false, refusal: { reason: 'not_deployment_tier', leaf } };
    if (!(await authorize(change))) return { applied: false, refusal: { reason: 'unauthorized', leaf } };
    if (RETIRED_LEAVES.has(leaf)) return { applied: false, refusal: { reason: 'retired', leaf } };
    return write();
  };

  return {
    async setLeaf(leaf, value, actor, nowMs) {
      return withLeafWrite({ leaf, value, actor }, async () => {
        const previousRaw = leaf === 'agent.tasks' ? (await leafValues(db, [leaf])).get(leaf) : undefined;
        let previous: unknown = leaf === 'agent.tasks' ? {} : undefined;
        if (previousRaw !== undefined) {
          try { previous = JSON.parse(previousRaw) as unknown; }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
        const spec = DEPLOYMENT_LEAF_SPECS[leaf]!;
        const detail = leafRuleViolation(spec, value, previous);
        if (detail !== null) {
          return { applied: false, refusal: { reason: 'invalid_value', leaf, detail } };
        }
        if ('type' in spec && spec.type === 'embedding') {
          const written = await writeEmbedding(db, opts.target, { [spec.leaf]: value }, actor, nowMs, leaf);
          if (written.applied) await rearm({ leaf });
          return written;
        }
        await db
          .prepare(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
          .bind(leaf, JSON.stringify(leaf === 'agent.tasks' ? preserveRetiredTaskOverrides(value, previous) : value), nowMs, actor)
          .run();
        await rearm({ leaf });
        return { applied: true };
      });
    },

    async setEmbedding(choice, actor, nowMs) {
      const leaf = 'embedding.provider';
      return withLeafWrite({ leaf, value: choice, actor }, async () => {
        const changes: StoredEmbedding = { 'embedding.provider': choice.provider, 'embedding.model': choice.model, 'embedding.base_url': choice.endpoint };
        for (const [part, value] of Object.entries(changes) as Array<[EmbeddingSelectionLeaf, unknown]>) {
          const violation = value === undefined ? null : embeddingPartViolation(part, value);
          if (violation !== null) return { applied: false, refusal: { reason: 'invalid_value', leaf: part, detail: violation } };
        }
        const written = await writeEmbedding(db, opts.target, changes, actor, nowMs, leaf);
        if (written.applied) for (const part of EMBEDDING_SELECTION_LEAVES) await rearm({ leaf: part });
        return written;
      });
    },

    async resetLeaf(leaf, actor, nowMs = Date.now()) {
      return withLeafWrite({ leaf, actor }, async () => {
        const spec = DEPLOYMENT_LEAF_SPECS[leaf]!;
        if ('type' in spec && spec.type === 'embedding') {
          const written = await writeEmbedding(db, opts.target, { [spec.leaf]: undefined }, actor, nowMs, leaf);
          if (written.applied) await rearm({ leaf });
          return written;
        }
        const held = leaf === 'agent.tasks' ? (await leafValues(db, [leaf])).get(leaf) : undefined;
        let previous: unknown;
        if (held !== undefined) {
          try { previous = JSON.parse(held); }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
        const archived = taskOverridesMetadata(previous).retiredValue;
        const reset = Object.keys(archived).length === 0
          ? db.prepare(`DELETE FROM deployment_settings WHERE leaf = ?`).bind(leaf)
          : db.prepare(`UPDATE deployment_settings SET value = ?, updated_at = ?, updated_by = ? WHERE leaf = ?`)
            .bind(JSON.stringify(archived), nowMs, actor, leaf);
        await db.batch([reset, resetRecord(leaf, actor, nowMs)]);
        await rearm({ leaf });
        return { applied: true };
      });
    },

    async setTaskSwitch(task, enabled, actor, nowMs) {
      const leaf = 'agent.tasks';
      const unreadable: SettingsResult = { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'the task overrides held by the server cannot be read' } };
      const raw = (await leafValues(db, [leaf])).get(leaf);
      let held: unknown = {};
      if (raw !== undefined) {
        try { held = JSON.parse(raw); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return unreadable; }
      }
      if (!isRecord(held)) return unreadable;
      const entry = Object.hasOwn(held, task) ? held[task] : {};
      if (!isRecord(entry)) return unreadable;
      const schedule = Object.hasOwn(entry, 'schedule') ? entry.schedule : {};
      if (!isRecord(schedule)) return unreadable;
      return this.setLeaf(leaf, { ...held, [task]: { ...entry, schedule: { ...schedule, enabled } } }, actor, nowMs);
    },

    async setTaskTier(task, tier, actor, nowMs) {
      const leaf = 'agent.tasks';
      return withLeafWrite({ leaf, value: { task, tier }, actor }, async () => {
        if (!(OUTCOME_TASKS as readonly string[]).includes(task)) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'unknown task' } };
        if (tier !== null && !isReasoningTier(tier)) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'expected low, default, high, or null' } };
        const held = (await leafValues(db, [leaf])).get(leaf);
        if (held !== undefined) {
          let value: unknown;
          try { value = JSON.parse(held); } catch { return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'the stored task overrides do not read' } }; }
          if (!isRecord(value)) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'stored task overrides are not an object' } };
        }
        const taskPath = `$.${JSON.stringify(task)}`;
        const tierPath = `${taskPath}.reasoningLevel`;
        const seed = tier === null ? {} : { [task]: { reasoningLevel: tier } };
        const changed = tier === null
          ? await db.prepare(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
              ON CONFLICT(leaf) DO UPDATE SET value = CASE
                WHEN json_type(deployment_settings.value, ?) IS NULL THEN deployment_settings.value
                WHEN json_type(deployment_settings.value, ?) != 'object' THEN json_remove(deployment_settings.value, ?)
                WHEN (SELECT COUNT(*) FROM json_each(json_remove(deployment_settings.value, ?), ?)) = 0
                  THEN json_remove(json_remove(deployment_settings.value, ?), ?)
                ELSE json_remove(deployment_settings.value, ?) END,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
            .bind(leaf, JSON.stringify(seed), nowMs, actor, taskPath, taskPath, taskPath, tierPath, taskPath, tierPath, taskPath, tierPath).run()
          : await db.prepare(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
              ON CONFLICT(leaf) DO UPDATE SET value = CASE
                WHEN json_type(deployment_settings.value, ?) IS NOT NULL AND json_type(deployment_settings.value, ?) != 'object'
                  THEN json_set(deployment_settings.value, ?, json(?))
                ELSE json_set(deployment_settings.value, ?, ?) END,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
            .bind(leaf, JSON.stringify(seed), nowMs, actor, taskPath, taskPath, taskPath, JSON.stringify({ reasoningLevel: tier }), tierPath, tier).run();
        if (changed.meta.changes !== 1) throw new Error('task tier write did not change one settings row');
        await rearm({ leaf });
        return { applied: true };
      });
    },

    async setCapability(projectId, capability, enabled, actor, nowMs) {
      if (!(PROJECT_CAPABILITIES as readonly string[]).includes(capability)) {
        return { applied: false, refusal: { reason: 'unknown_capability', capability } };
      }
      const leaf = `project.${capability}`;
      if (!(await authorize({ leaf, actor }))) {
        return { applied: false, refusal: { reason: 'unauthorized', leaf } };
      }
      await db
        .prepare(`INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(project_id, capability) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .bind(projectId, capability, enabled ? 1 : 0, nowMs, actor)
        .run();
      await rearm({ leaf });
      return { applied: true };
    },

    async leaves() {
      const snapshot = SNAPSHOTS.get(db);
      const results = snapshot !== undefined ? [...snapshot.entries()].map(([leaf, row]) => ({ ...row, leaf })) : (await db
        .prepare(`SELECT leaf, value, updated_at, updated_by FROM deployment_settings`)
        .all<{ leaf: string; value: string; updated_at: number; updated_by: string }>()).results;
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

    async capabilityEnabled(projectId, capability) {
      const row = await db
        .prepare(`SELECT enabled FROM project_capabilities WHERE project_id = ? AND capability = ?`)
        .bind(projectId, capability)
        .first<{ enabled: number }>();
      return row !== null && row.enabled === 1;
    },

    async retiredCapabilities(projectId) {
      const rows = await db.prepare(`SELECT capability, enabled FROM project_capabilities WHERE project_id = ?
        AND capability NOT IN (${PROJECT_CAPABILITIES.map(() => '?').join(', ')})`).bind(projectId, ...PROJECT_CAPABILITIES)
        .all<{ capability: string; enabled: number }>();
      return Object.fromEntries(rows.results.map((row) => [row.capability, row.enabled === 1]));
    },

    async capabilities(projectId) {
      const { results } = await db
        .prepare(`SELECT capability, enabled FROM project_capabilities WHERE project_id = ?`)
        .bind(projectId)
        .all<{ capability: string; enabled: number }>();
      const admitted = new Map(results.map((r) => [r.capability, r.enabled === 1]));
      return Object.fromEntries(
        PROJECT_CAPABILITIES.map((c) => [c, admitted.get(c) ?? false]),
      ) as Record<ProjectCapability, boolean>;
    },
  };
}
