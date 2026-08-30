import type { RelationalStore } from './adapters.js';

/**
 * Deployment Settings: one operation every write goes through.
 *
 * 1.4 resolved settings across four tiers; 2.0 keeps two, and the server tier is
 * this one. Every write validates, authorizes, persists, records its actor, and
 * re-arms the schedule that may have moved — in that order, in one place.
 *
 * The order matters more than the steps. A write that persists before it
 * authorizes has already happened when it is refused; one that re-arms before it
 * persists arms against a value the store does not hold; and one that skips the
 * actor leaves an audit trail that cannot answer who changed what. Splitting
 * these across call sites is how three of the four eventually go missing on one
 * path and nobody notices, which is why the gate holds every write to this module.
 */

/** A capability a Project may be admitted to. Mirrors the member-side `CAPABILITY_IDS`. */
export const PROJECT_CAPABILITIES = ['cortex', 'canopy', 'skills', 'vault_evolution'] as const;
export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

/**
 * The leaves this tier owns, from §7.8 of the architecture ledger.
 *
 * Held here rather than derived from the member's schema: the member package is
 * not a dependency of the server, and a leaf reaching the Deployment tier is a
 * decision the ledger records rather than something the shape of a config file
 * implies. A meta gate holds this list against the ledger so the two cannot drift.
 */
export const DEPLOYMENT_LEAVES: readonly string[] = [
  'agent.cold_project_threshold_days',
  'agent.event_tasks_enabled',
  'agent.harness',
  'agent.model',
  'agent.provider.base_url',
  'agent.provider.context_length',
  'agent.provider.effort_map.default.effort',
  'agent.provider.effort_map.default.verbosity',
  'agent.provider.effort_map.high.effort',
  'agent.provider.effort_map.high.verbosity',
  'agent.provider.effort_map.low.effort',
  'agent.provider.effort_map.low.verbosity',
  'agent.provider.local_backend',
  'agent.provider.model',
  'agent.provider.reasoning_map.default',
  'agent.provider.reasoning_map.high',
  'agent.provider.reasoning_map.low',
  'agent.provider.thinking_budget_map.default',
  'agent.provider.thinking_budget_map.high',
  'agent.provider.thinking_budget_map.low',
  'agent.provider.type',
  'agent.reasoningLevel',
  'agent.run_retention_days',
  'agent.scheduled_tasks_active_window_days',
  'agent.scheduled_tasks_enabled',
  'agent.semantic_write_check_enabled',
  'agent.summary_batch_interval',
  'agent.tasks',
  'backup.auto_interval_hours',
  'backup.retention.keep_daily',
  'backup.retention.keep_weekly',
  'cortex.canopy.exclude.default_patterns',
  'cortex.canopy.exclude.patterns',
  'cortex.canopy.min_file_bytes',
  'cortex.canopy.refresh.background_enabled',
  'cortex.canopy.refresh.background_period_minutes',
  'cortex.digest.inject_on_session_start',
  'cortex.digest.tier',
  'cortex.instructions.inject_on_session_start',
  'cortex.instructions.inject_on_subagent_start',
  'cortex.plans.inject_intent_nudge_on_prompt_submit',
  'cortex.spores.inject_on_prompt_submit',
  'cortex.spores.max_per_prompt',
  'embedding.base_url',
  'embedding.model',
  'embedding.prevent_deep_sleep',
  'embedding.provider',
  'maintenance.auto_integrity_check',
  'maintenance.auto_integrity_check_interval_hours',
  'maintenance.auto_optimize',
  'maintenance.auto_optimize_interval_hours',
  'notifications.retention_days',
  'release_provenance.reconcile_interval_minutes',
  'skills.confidence_threshold',
  'skills.usage_stale_days',
];

const DEPLOYMENT_LEAF_SET = new Set(DEPLOYMENT_LEAVES);

/**
 * The scalar leaves that name an endpoint directly.
 *
 * #907 justifies step-up on provider credentials as *"a member could exfiltrate a
 * provider key"* — but a stored secret is write-only and masked, so reading it is
 * not the reachable path. Changing **where it is sent** is.
 * `agent/harness/openai.ts` locks `openai` and `openrouter` to hardcoded base URLs
 * for exactly that, with a comment saying so; these are the same values left open
 * for `openai-compatible`, and on a Deployment every member writes settings.
 */
export const STEP_UP_LEAVES: readonly string[] = [
  'agent.provider.base_url',
  'agent.provider.type',
  'embedding.base_url',
];

const STEP_UP_LEAF_SET = new Set(STEP_UP_LEAVES);

/**
 * How deep a submitted value is inspected for a redirect. Bounds the walk on a
 * caller-supplied document; deeper than any provider override the schema declares.
 */
const MAX_VALUE_DEPTH = 12;

/**
 * Whether a submitted VALUE carries a provider redirect anywhere inside it.
 *
 * A leaf-name list is not sufficient. Several Deployment leaves are whole
 * documents rather than scalars, and `agent.tasks` is
 * a record of per-task overrides — each of which may carry
 * `provider: { type, base_url }` (`TaskProviderOverrideSchema` in the member
 * schema). Writing that one leaf therefore redirects the Deployment's own
 * credential while naming none of the gated leaves.
 *
 * So the requirement is derived from what the value CONTAINS, not from what it is
 * called: any `base_url` at any depth, or any `provider` object. That is
 * deliberately conservative, and will occasionally demand step-up for a document
 * that carries a provider block without changing it. Asking too often costs a
 * prompt; asking too rarely delivers a credential to a host a member chose.
 */
export function containsProviderRedirect(value: unknown, depth = 0): boolean {
  if (depth > MAX_VALUE_DEPTH || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsProviderRedirect(v, depth + 1));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'base_url' || key === 'baseUrl') return true;
    if (key === 'provider' && nested !== null && typeof nested === 'object') return true;
    if (containsProviderRedirect(nested, depth + 1)) return true;
  }
  return false;
}

/** Whether this change needs proof beyond membership: the leaf names an endpoint, or the value carries one. */
export const requiresStepUp = (leaf: string, value?: unknown): boolean =>
  STEP_UP_LEAF_SET.has(leaf) || containsProviderRedirect(value);

/** Why a settings write did not apply. Each names a fault in the caller's own request; none is retryable. */
export type SettingsRefusal =
  | { reason: 'not_deployment_tier'; leaf: string }
  | { reason: 'unauthorized'; leaf: string }
  | { reason: 'unknown_capability'; capability: string };

/** A stored leaf: its value and who last wrote it. */
export interface LeafRecord {
  value: unknown;
  updatedAt: number;
  updatedBy: string;
}

export type SettingsResult = { applied: true } | { applied: false; refusal: SettingsRefusal };

/**
 * Whether a member may make this particular change.
 *
 * Membership is flat, so ordinary settings need no decision at all and this
 * answers true. It exists as a seam for the one class #907 puts behind step-up —
 * a provider credential or the endpoint it is sent to — so that when #915 L3
 * lands, the check has one place to be rather than a new branch at each caller.
 */
export type SettingsAuthorizer = (change: { leaf: string; value?: unknown; actor: string }) => Promise<boolean>;

/** Re-arms whatever the change may have moved. Supplied by the caller so this module never decides what runs. */
export type ScheduleRearm = (change: { leaf: string }) => Promise<void>;

export interface SettingsWriter {
  /** Set one Deployment leaf. */
  setLeaf(leaf: string, value: unknown, actor: string, nowMs: number): Promise<SettingsResult>;
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
}

/**
 * Whether this Deployment can run `taskName` at all.
 *
 * A provider is resolved task-first, then default — `agent.tasks.<task>.provider`
 * before `agent.provider.type` — matching the member's own resolution order. A
 * task with neither has no model to call, and a run dispatched without one fails
 * after doing work rather than declining before it.
 *
 * Deployment-scoped on purpose: the provider credential belongs to the
 * Deployment, not to a Project, so this asks what the server can do rather than
 * what a Project is admitted to.
 */
/** The stored value of each named leaf, as the JSON text the settings surface wrote; a leaf never written is absent from the map. */
export async function leafValues(db: RelationalStore, leaves: readonly string[]): Promise<Map<string, string>> {
  if (leaves.length === 0) return new Map();
  const rows = await db
    .prepare(`SELECT leaf, value FROM deployment_settings WHERE leaf IN (${leaves.map(() => '?').join(', ')})`)
    .bind(...leaves)
    .all<{ leaf: string; value: string }>();
  return new Map(rows.results.map((r) => [r.leaf, r.value]));
}

export async function providerConfiguredFor(db: RelationalStore, taskName: string): Promise<boolean> {
  const byLeaf = await leafValues(db, ['agent.provider.type', 'agent.tasks']);

  const perTask = byLeaf.get('agent.tasks');
  if (perTask !== undefined) {
    try {
      const parsed: unknown = JSON.parse(perTask);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entry = (parsed as Record<string, unknown>)[taskName];
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          && (entry as Record<string, unknown>).provider != null) return true;
      }
    } catch {
      // A malformed overrides document answers no per-task provider rather than
      // throwing: the default below still decides, and the settings surface is
      // where a malformed value is reported.
    }
  }

  const fallback = byLeaf.get('agent.provider.type');
  if (fallback === undefined) return false;
  try {
    return JSON.parse(fallback) != null;
  } catch {
    return false;
  }
}

export function settingsWriter(
  db: RelationalStore,
  opts: { authorize?: SettingsAuthorizer; rearm?: ScheduleRearm } = {},
): SettingsWriter {
  const authorize = opts.authorize ?? (async () => true);
  const rearm = opts.rearm ?? (async () => {});

  return {
    async setLeaf(leaf, value, actor, nowMs) {
      if (!DEPLOYMENT_LEAF_SET.has(leaf)) {
        return { applied: false, refusal: { reason: 'not_deployment_tier', leaf } };
      }
      if (!(await authorize({ leaf, value, actor }))) {
        return { applied: false, refusal: { reason: 'unauthorized', leaf } };
      }
      await db
        .prepare(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
                  ON CONFLICT(leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .bind(leaf, JSON.stringify(value), nowMs, actor)
        .run();
      await rearm({ leaf });
      return { applied: true };
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
      for (const r of results) out[r.leaf] = { value: JSON.parse(r.value), updatedAt: r.updated_at, updatedBy: r.updated_by };
      return out;
    },

    async capabilityEnabled(projectId, capability) {
      const row = await db
        .prepare(`SELECT enabled FROM project_capabilities WHERE project_id = ? AND capability = ?`)
        .bind(projectId, capability)
        .first<{ enabled: number }>();
      return row !== null && row.enabled === 1;
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
