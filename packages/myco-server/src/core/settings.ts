import { CANOPY_DEFAULT_EXCLUDE_PATTERNS } from '@goondocks/myco-shared/canopy';
import type { PreparedStatement, RelationalStore } from './adapters.js';
import { captureFolderRefusal, planFolderRefusal, ROOT_KEY_PATTERN } from '@goondocks/myco-shared/member-protocol';
import { INSTRUCTIONS_TEMPLATE_MAX_BYTES, IMPORT_MAX_SESSIONS_MAX, IMPORT_WINDOW_DAYS_MAX } from '../constants.js';
import { CONFIGURABLE_PROFILE_HARNESSES, PROFILE_HARNESSES, REASONING_TIERS, isReasoningTier, modelRefusal, effortRefusal, type ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import { OUTCOME_TASKS } from './task-catalogue.js';

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
 * The rule a leaf's value satisfies at write, or `{}` for a leaf that takes any
 * JSON value.
 *
 * Declarative data rather than a validator function: the Settings page renders
 * a field from it, a gate reads it, and a function could do neither. A leaf
 * that shipped before this existed keeps `{}` — giving it a rule now would
 * refuse values a Deployment already holds.
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
  | { readonly type: 'integer'; readonly min: number; readonly max: number }
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

/**
 * The leaves this tier owns, from §7.8 of the architecture ledger.
 *
 * Held here rather than derived from the member's schema: the member package is
 * not a dependency of the server, and a leaf reaching the Deployment tier is a
 * decision the ledger records rather than something the shape of a config file
 * implies. A meta gate holds this list against the ledger so the two cannot drift.
 */
export const DEPLOYMENT_LEAF_SPECS: Readonly<Record<string, LeafSpec>> = {
  'agent.cold_project_threshold_days': {},
  'agent.event_tasks_enabled': {},
  // Preserved for stored-history inspection; writes to retired leaves are refused.
  'agent.harness': {},
  'agent.limits.concurrent_runs': {},
  'agent.limits.task_concurrent_runs': {},
  'agent.limits.task_runs_per_hour': {},
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
  'agent.run_retention_days': {},
  'agent.scheduled_tasks_active_window_days': {},
  'agent.scheduled_tasks_enabled': {},
  'agent.semantic_write_check_enabled': {},
  'agent.summary_batch_interval': {},
  'agent.tasks': { type: 'task-overrides' },
  'backup.auto_interval_hours': {},
  // #1547: whether a member's machine may create a project for a repository it meets that no project holds. Absent
  // means on; an admin turns it off to keep project creation with admins.
  'capture.auto_create_projects': {},
  'backup.recovery.keep_stagings': {},
  'backup.retention.keep_daily': {},
  'backup.retention.keep_weekly': {},
  'cortex.canopy.exclude.default_patterns': {},
  'cortex.canopy.exclude.patterns': {},
  'cortex.canopy.refresh.background_enabled': {},
  'cortex.canopy.refresh.background_period_minutes': {},
  'cortex.digest.inject_on_session_start': {},
  'cortex.digest.tier': {},
  'cortex.instructions.inject_on_session_start': {},
  'cortex.instructions.inject_on_subagent_start': {},
  'cortex.plans.inject_intent_nudge_on_prompt_submit': {},
  'cortex.spores.inject_on_prompt_submit': {},
  'cortex.spores.max_per_prompt': {},
  'embedding.base_url': {},
  'embedding.model': {},
  'embedding.prevent_deep_sleep': {},
  'embedding.provider': {},
  // #1148 — bounded import. `enabled` is also an admission on the write path;
  // the window and the per-harness cap are applied where a whole pass is
  // visible, which one event is not.
  'import.enabled': {},
  'import.max_sessions_per_harness': { type: 'integer', min: 1, max: IMPORT_MAX_SESSIONS_MAX },
  'import.window_days': { type: 'integer', min: 1, max: IMPORT_WINDOW_DAYS_MAX },
  'instructions.template': { type: 'markdown', maxBytes: INSTRUCTIONS_TEMPLATE_MAX_BYTES },
  'maintenance.auto_integrity_check': {},
  'maintenance.auto_integrity_check_interval_hours': {},
  'maintenance.auto_optimize': {},
  'maintenance.auto_optimize_interval_hours': {},
  'notifications.retention_days': {},
  'release_provenance.reconcile_interval_minutes': { type: 'integer', min: 1, max: 1440 },
  // #1147 — transcript-first ingest. Unset or 0 keeps raw transcripts forever;
  // a write has no delete, so 0 is how a Deployment returns to keeping
  // everything. A window prunes only processed raw bytes (`ingest/retention.ts`),
  // and is how a Deployment manages storage: capture is never refused (#1416).
  'retention.transcripts': { type: 'integer', min: 0, max: 3650 },
  'skills.confidence_threshold': {},
  'skills.usage_stale_days': {},
  // #1151 — worker mode: the harness a worker prefers and the order it falls back through.
  'worker.harness': {},
  'worker.harness_fallback': {},
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
  if (spec.type === 'integer') {
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

export interface SettingsWriter {
  /** Set one Deployment leaf. */
  setLeaf(leaf: string, value: unknown, actor: string, nowMs: number): Promise<SettingsResult>;
  /** Remove one configured leaf so its built-in value applies. */
  resetLeaf(leaf: string, actor: string, nowMs?: number): Promise<SettingsResult>;
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

/** The stored value of each named leaf, as the JSON text the settings surface wrote; a leaf never written is absent from the map. */
export async function leafValues(db: RelationalStore, leaves: readonly string[]): Promise<Map<string, string>> {
  if (leaves.length === 0) return new Map();
  const rows = await db
    .prepare(`SELECT leaf, value FROM deployment_settings WHERE leaf IN (${leaves.map(() => '?').join(', ')})`)
    .bind(...leaves)
    .all<{ leaf: string; value: string }>();
  return new Map(rows.results.map((r) => [r.leaf, r.value]));
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

export function settingsWriter(
  db: RelationalStore,
  opts: { authorize?: SettingsAuthorizer; rearm?: ScheduleRearm } = {},
): SettingsWriter {
  const authorize = opts.authorize ?? (async () => true);
  const rearm = opts.rearm ?? (async () => {});
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
        const detail = leafRuleViolation(DEPLOYMENT_LEAF_SPECS[leaf]!, value, previous);
        if (detail !== null) {
          return { applied: false, refusal: { reason: 'invalid_value', leaf, detail } };
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

    async resetLeaf(leaf, actor, nowMs = Date.now()) {
      return withLeafWrite({ leaf, actor }, async () => {
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
        await db.batch([
          reset,
          db.prepare(`INSERT INTO deployment_setting_resets (leaf, reset_at, reset_by) VALUES (?, ?, ?)
            ON CONFLICT(leaf) DO UPDATE SET reset_at = excluded.reset_at, reset_by = excluded.reset_by`)
            .bind(leaf, nowMs, actor),
        ]);
        await rearm({ leaf });
        return { applied: true };
      });
    },

    async setTaskTier(task, tier, actor, nowMs) {
      const leaf = 'agent.tasks';
      return withLeafWrite({ leaf, value: { task, tier }, actor }, async () => {
        if (!(OUTCOME_TASKS as readonly string[]).includes(task)) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'unknown task' } };
        if (tier !== null && !isReasoningTier(tier)) return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'expected low, default, high, or null' } };
        const held = (await leafValues(db, [leaf])).get(leaf);
        if (held !== undefined) {
          let value: unknown;
          try { value = JSON.parse(held); } catch { return { applied: false, refusal: { reason: 'invalid_value', leaf, detail: 'stored task overrides are not valid JSON' } }; }
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
      const { results } = await db
        .prepare(`SELECT leaf, value, updated_at, updated_by FROM deployment_settings`)
        .all<{ leaf: string; value: string; updated_at: number; updated_by: string }>();
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
