// SPDX-License-Identifier: Apache-2.0

type MycoDotPath = string | readonly string[];

type MycoTier = 'machine' | 'grove' | 'project' | 'local';

type MycoCapabilityId = 'cortex' | 'canopy' | 'skills' | 'vault_evolution';

type MycoReasoningLevel = 'low' | 'default' | 'high';

type MycoHarnessId = 'claude-sdk' | 'openai-agents';

type MycoProviderType =
  | 'anthropic'
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'openrouter'
  | 'openai-compatible';

interface MycoProviderConfig {
  type: MycoProviderType;
  localBackend?: 'ollama' | 'lmstudio';
  local_backend?: 'ollama' | 'lmstudio';
  baseUrl?: string;
  base_url?: string;
  apiKey?: string;
  api_key?: string;
  model?: string;
  reasoningMap?: Partial<Record<MycoReasoningLevel, string>>;
  reasoning_map?: Partial<Record<MycoReasoningLevel, string>>;
  contextLength?: number;
  context_length?: number;
}

interface MycoAppearanceValuesShape {
  theme: 'sage' | 'moss' | 'terracotta' | 'dusk' | 'plum' | 'slate';
  mode: 'light' | 'dark' | 'system';
  font: 'default' | 'geist-mono' | 'system' | 'sf-mono' | 'fira-code' | 'jetbrains-mono';
  density: 'compact' | 'normal' | 'comfy';
}

interface MycoScopeEntryShape {
  home: MycoTier;
  overridableBy: MycoTier[];
  gate?: MycoCapabilityId;
}

interface MycoConfigShape {
  version?: number;
  config_version?: number;
  machine_id?: string;
  embedding?: {
    provider: 'ollama' | 'openai-compatible';
    model: string;
    base_url?: string;
  };
  daemon?: {
    port: number | null;
    stale_session_threshold_ms?: number;
    log_level: 'debug' | 'info' | 'warn' | 'error';
    log_retention_days: number;
    update_channel?: string;
    check_interval_hours?: number;
  };
  maintenance?: {
    auto_optimize: boolean;
    auto_optimize_interval_hours: number;
  };
  capture?: {
    transcript_paths: string[];
    plan_dirs: string[];
    artifact_extensions: string[];
    buffer_max_events: number;
    ignore_plan_dirs_in_git?: boolean;
    ignore?: {
      paths?: string[];
    };
  };
  release_provenance?: {
    enabled: boolean;
    production_refs: string[];
    integration_refs: string[];
    reconcile_interval_minutes: number;
    production_debug_include_unknown: boolean;
    github: {
      repo: string;
      token_env: string;
      max_lookups_per_run: number;
    };
    package_map: Array<{
      path_glob: string;
      tag_pattern: string;
    }>;
  };
  agent?: {
    cold_project_threshold_days?: number;
    scheduled_tasks_enabled?: boolean;
    event_tasks_enabled?: boolean;
    scheduled_tasks_active_window_days?: number;
    run_retention_days?: number;
    summary_batch_interval: number;
    semantic_write_check_enabled?: boolean;
    harness?: MycoHarnessId;
    provider?: MycoProviderConfig;
    reasoningLevel?: MycoReasoningLevel;
    model?: string;
    tasks?: Record<string, {
      schedule?: {
        enabled?: boolean;
        intervalSeconds?: number;
        runIn?: Array<'active' | 'idle' | 'sleep'>;
        preCondition?: 'has-unprocessed-batches' | 'has-active-skills';
      };
    }>;
  };
  backup?: {
    dir?: string;
  };
  team?: {
    interval_minutes?: number;
  };
  skills?: {
    enabled?: boolean;
    confidence_threshold?: number;
    usage_stale_days?: number;
  };
  vault_evolution?: {
    enabled?: boolean;
  };
  cortex?: {
    enabled?: boolean;
    instructions: {
      inject_on_session_start: boolean;
      inject_on_subagent_start: boolean;
    };
    digest: {
      tier: number;
      inject_on_session_start: boolean;
    };
    spores: {
      inject_on_prompt_submit: boolean;
      max_per_prompt: number;
    };
    canopy: {
      enabled?: boolean;
      inject_on_pre_tool_use: boolean;
      min_file_bytes: number;
      refresh: {
        background_enabled: boolean;
        background_period_minutes: number;
      };
      exclude: {
        default_patterns: string[];
        patterns: string[];
      };
    };
  };
  notifications?: {
    enabled: boolean;
    system_notifications: boolean;
    default_mode: 'banner' | 'summary';
    retention_days?: number;
    domains: Record<string, { enabled: boolean; mode?: 'banner' | 'summary' }>;
  };
  appearance?: MycoAppearanceValuesShape;
}

declare module '@myco/utils/dot-path' {
  export type DotPath = MycoDotPath;
  export function getAtPath(obj: unknown, path: DotPath): unknown;
  export function setAtPath(obj: Record<string, unknown>, path: DotPath, value: unknown): void;
  export function unsetAtPath(
    obj: Record<string, unknown>,
    path: DotPath,
    options?: { pruneEmptyParents?: boolean },
  ): boolean;
}

declare module '@myco/config/appearance-values' {
  export const APPEARANCE_THEMES: readonly ['sage', 'moss', 'terracotta', 'dusk', 'plum', 'slate'];
  export const APPEARANCE_MODES: readonly ['light', 'dark', 'system'];
  export const APPEARANCE_FONTS: readonly ['default', 'geist-mono', 'system', 'sf-mono', 'fira-code', 'jetbrains-mono'];
  export const APPEARANCE_DENSITIES: readonly ['compact', 'normal', 'comfy'];
  export type AppearanceTheme = typeof APPEARANCE_THEMES[number];
  export type AppearanceMode = typeof APPEARANCE_MODES[number];
  export type AppearanceFont = typeof APPEARANCE_FONTS[number];
  export type AppearanceDensity = typeof APPEARANCE_DENSITIES[number];
  export interface AppearanceValues extends MycoAppearanceValuesShape {}
}

declare module '@myco/config/schema' {
  export interface MycoConfig extends MycoConfigShape {}
  export interface GroveConfig extends MycoConfigShape {}
  export interface MachineConfig extends MycoConfigShape {}
}

declare module '@myco/config/scope' {
  export type Tier = MycoTier;
  export const CAPABILITY_IDS: readonly ['cortex', 'canopy', 'skills', 'vault_evolution'];
  export type CapabilityId = typeof CAPABILITY_IDS[number];
  export interface ScopeEntry extends MycoScopeEntryShape {}
  export function scopePolicyForPath(path: string): ScopeEntry;
}

declare module '@myco/config/capabilities' {
  export interface CapabilityDef {
    id: MycoCapabilityId;
    label: string;
    masterGate: string;
    memberGates: string[];
    scheduledTasks: string[];
    advancedSettingsLink: string;
    defaultEnabled?: boolean;
  }

  export const CAPABILITIES: Record<MycoCapabilityId, CapabilityDef>;
  export function capabilityEnabled(
    config: MycoConfigShape | null | undefined,
    capId: MycoCapabilityId,
  ): boolean;
}

declare module '@myco/config/focus' {
  export const CONFIG_FOCUS_SECTION_PARAM: 'configSection';
  export const CONFIG_FOCUS_FIELD_PARAM: 'configField';
  export const CONFIG_FOCUS_TAB_PARAM: 'tab';
  export const CONFIG_SECTION_IDS: {
    readonly appearance: 'config-section-appearance';
    readonly cortexInstructions: 'config-section-cortex-instructions';
    readonly cortexBuilder: 'config-section-cortex-builder';
    readonly cortexDigest: 'config-section-cortex-digest';
    readonly settingsAgent: 'config-section-settings-agent';
    readonly settingsEmbedding: 'config-section-settings-embedding';
    readonly settingsNotifications: 'config-section-settings-notifications';
    readonly settingsPlanCapture: 'config-section-settings-plan-capture';
    readonly settingsProject: 'config-section-settings-project';
    readonly agentOperations: 'config-section-agent-operations';
    readonly operationsMaintenance: 'config-section-operations-maintenance';
    readonly operationsBackup: 'config-section-operations-backup';
  };
  export function configFieldId(path: string): string;
}

declare module '@myco/config/paths' {
  export const CORTEX_PATHS: {
    readonly enabled: 'cortex.enabled';
    readonly instructions: {
      readonly injectOnSessionStart: 'cortex.instructions.inject_on_session_start';
      readonly injectOnSubagentStart: 'cortex.instructions.inject_on_subagent_start';
    };
    readonly digest: {
      readonly tier: 'cortex.digest.tier';
      readonly injectOnSessionStart: 'cortex.digest.inject_on_session_start';
    };
    readonly spores: {
      readonly injectOnPromptSubmit: 'cortex.spores.inject_on_prompt_submit';
      readonly maxPerPrompt: 'cortex.spores.max_per_prompt';
    };
    readonly canopy: {
      readonly injectOnPreToolUse: 'cortex.canopy.inject_on_pre_tool_use';
      readonly minFileBytes: 'cortex.canopy.min_file_bytes';
      readonly refresh: {
        readonly backgroundEnabled: 'cortex.canopy.refresh.background_enabled';
        readonly backgroundPeriodMinutes: 'cortex.canopy.refresh.background_period_minutes';
      };
      readonly exclude: {
        readonly defaultPatterns: 'cortex.canopy.exclude.default_patterns';
        readonly patterns: 'cortex.canopy.exclude.patterns';
      };
    };
  };
}

declare module '@myco/agent/types' {
  export type HarnessId = MycoHarnessId;
  export type ReasoningLevel = MycoReasoningLevel;
  export const PROVIDER_TYPES: readonly [
    'anthropic',
    'ollama',
    'lmstudio',
    'openai',
    'openrouter',
    'openai-compatible',
  ];
  export type ProviderType = typeof PROVIDER_TYPES[number];
  export interface ProviderConfig extends MycoProviderConfig {}
  export interface RuntimeTokenBudget {
    contextWindowTokens: number | null;
    contextWindowSource?: 'provider-config' | 'provider-metadata' | 'provider-default';
    peakRequestInputTokens: number | null;
    peakRequestOutputTokens: number | null;
    peakRequestTotalTokens: number | null;
    utilizationPercent: number | null;
    headroomTokens: number | null;
    status: 'unknown' | 'ok' | 'warning' | 'post_run_pressure';
    message?: string;
  }
}

declare module '@myco/agent/provider-harness' {
  export interface ProviderMetadata {
    harness: MycoHarnessId;
    supportedHarnesses: readonly MycoHarnessId[];
    defaultContextWindowTokens?: number;
  }

  export const PROVIDER_METADATA_BY_TYPE: Record<MycoProviderType, ProviderMetadata>;
  export function getSupportedHarnessesForProviderType(
    providerType: MycoProviderType | undefined,
  ): readonly MycoHarnessId[];
  export function inferHarnessFromProviderType(
    providerType: MycoProviderType | undefined,
  ): MycoHarnessId | undefined;
  export function providerTypeSupportsHarness(
    providerType: MycoProviderType | undefined,
    harnessId: MycoHarnessId | undefined,
  ): boolean;
}

declare module '@myco/agent/cost/types' {
  export type CostSource = 'actual' | 'estimated' | 'unavailable';

  export interface CostBreakdown {
    inputTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    requestCount: number;
    inputCostUsd?: number;
    cachedInputCostUsd?: number;
    outputCostUsd?: number;
    reasoningCostUsd?: number;
    requestCostUsd?: number;
    totalCostUsd?: number;
    cacheSavingsUsd?: number;
  }

  export interface CostResolution {
    source: CostSource;
    costUsd: number | null;
    actualCostUsd: number | null;
    estimatedCostUsd: number | null;
    breakdown: CostBreakdown;
    pricingVersion?: string | null;
    message?: string | null;
    providerMetadata?: Record<string, unknown>;
  }
}

declare module '@myco/daemon/api/projects-activity' {
  export interface ProjectActivityRow {
    grove_id: string;
    grove_slug: string;
    project_id: string;
    project_name: string;
    project_root: string;
    project_vault_dir: string;
    last_activity_at: string | null;
    scheduled_runs_last_24h: number;
    is_active: boolean;
  }

  export interface ProjectsActivityResponse {
    projects: ProjectActivityRow[];
    active_window_days: number;
    generated_at: string;
  }
}

declare module '@myco/daemon/api/maintenance' {
  export interface MaintenanceLastIntegrity {
    at: string;
    status: 'ok' | 'issues';
  }

  export interface GroveMaintenanceSummary {
    grove: {
      id: string;
      slug: string;
      name: string;
      mode: string;
    };
    project_count: number;
    db_size_bytes: number;
    log_count: number;
    embedding_pending: number | null;
    last_backup_at: string | null;
    last_optimize_at: string | null;
    last_vacuum_at: string | null;
    last_integrity_check: MaintenanceLastIntegrity | null;
    release_provenance?: {
      raw_count: number;
      derived_count: number;
      unreconciled_count: number;
      unknown_count: number;
      last_checked_at: string | null;
    };
    error: string | null;
  }

  export interface MaintenanceSummaryFlags {
    backup_overdue: number;
    optimize_overdue: number;
    integrity_issues: number;
    error_count: number;
  }

  export interface MaintenanceSummaryResponse {
    groves: GroveMaintenanceSummary[];
    flags: MaintenanceSummaryFlags;
    thresholds: {
      backup_overdue_hours: number;
      optimize_overdue_hours: number;
    };
  }
}

declare module '@myco/services/phase-audit' {
  export interface PhaseAudit {
    runId: string;
    taskName: string | null;
    dryRun: boolean;
    phases: PhaseAuditEntry[];
  }

  export interface PhaseAuditEntry {
    phaseName: string;
    status: 'completed' | 'failed' | 'skipped' | 'pending';
    summary: string | null;
    turnsUsed: number;
    maxTurns: number | null;
    tokensUsed: number;
    costUsd: number | null;
    costSource: string | null;
    durationMs: number | null;
    startedAt: number | null;
    completedAt: number | null;
    skipReason: string | null;
    toolCalls: Record<string, number>;
    toolErrors: Record<string, number>;
    writeIntents: {
      total: number;
      byTool: Record<string, number>;
    } | null;
    reports: Array<{
      action: string;
      summary: string | null;
      details: string | null;
      createdAt: number;
    }>;
  }
}

declare module '@myco/db/queries/write-intents' {
  export interface WriteIntentRow {
    id: number;
    project_id: string | null;
    run_id: string;
    phase_id: string | null;
    tool_name: string;
    tool_input: unknown;
    synthetic_output: unknown;
    stub_id: string | null;
    classifier_verdict: 'ok' | 'flag' | null;
    classifier_reason: string | null;
    recorded_at: number;
  }
}

declare module '@myco/db/queries/digest-extracts' {
  export interface DigestExtractRevisionRow {
    id: number;
    project_id: string | null;
    agent_id: string;
    tier: number;
    content: string;
    metadata: string | null;
    run_id: string | null;
    parent_revision_id: number | null;
    created_at: number;
  }
}

declare module '@myco/utils/parse-json-array.js' {
  export function parseJsonStringArray(value: string | null | undefined): string[];
}
