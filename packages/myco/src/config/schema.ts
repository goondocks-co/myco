import { z } from 'zod';
import { SCHEDULABLE_POWER_STATES } from '@myco/constants.js';
import { ReasoningLevelSchema, RuntimeIdSchema } from '@myco/agent/schemas.js';
import { DEFAULT_HUB_URL } from '../constants/hub.js';

const EmbeddingProviderSchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible', 'openrouter', 'openai']).default('ollama'),
  model: z.string().default('bge-m3'),
  base_url: z.string().url().optional(),
});

const DaemonSchema = z.object({
  port: z.number().int().min(1024).max(65535).nullable().default(null),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  log_retention_days: z.number().int().min(1).max(365).default(30),
  /**
   * Time without new prompts before an active session is auto-completed (ms).
   * Intelligence tasks (vault-evolve, skill-survey, etc.) only process
   * settled sessions, so this threshold directly controls how fresh their
   * inputs are. Defaults to 1 hour.
   */
  stale_session_threshold_ms: z.number().int().min(60_000).default(60 * 60 * 1000),
});

const HubSchema = z.object({
  /** Local Myco Hub URL used by daemon registration and dashboard navigation. */
  url: z.string().url().default(DEFAULT_HUB_URL),
});

const CaptureSchema = z.object({
  transcript_paths: z.array(z.string()).default([]),
  plan_dirs: z.array(z.string()).default([]),
  ignore_plan_dirs_in_git: z.boolean().default(false),
  artifact_extensions: z.array(z.string()).default(['.md']),
  buffer_max_events: z.number().int().positive().default(500),
});

/** Provider config shape used in both task-level and phase-level overrides. */
const ProviderOverrideSchema = z.object({
  runtime: RuntimeIdSchema.optional(),
  type: z.enum(['anthropic', 'ollama', 'lmstudio', 'openai', 'openrouter', 'openai-compatible']),
  local_backend: z.enum(['ollama', 'lmstudio']).optional(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  reasoning_map: z.object({
    low: z.string().optional(),
    default: z.string().optional(),
    high: z.string().optional(),
  }).optional(),
  /** Context window size for local models (Ollama num_ctx, LM Studio context_length). */
  context_length: z.number().int().positive().optional(),
});

/** Per-phase overrides within a task — keyed by phase name. */
const PhaseOverrideSchema = z.object({
  provider: ProviderOverrideSchema.optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
});

/** Per-task schedule override — partial, merges with YAML defaults. */
const ScheduleOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().positive().optional(),
  runIn: z.array(z.enum([...SCHEDULABLE_POWER_STATES])).optional(),
  preCondition: z.enum(['has-unprocessed-batches', 'has-active-skills', 'has-approved-candidates', 'has-skill-survey-evidence']).optional(),
}).optional();

/** Per-task config override — stored in myco.yaml under agent.tasks. */
const TaskProviderOverrideSchema = z.object({
  provider: ProviderOverrideSchema.optional(),
  runtime: RuntimeIdSchema.optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  phases: z.record(z.string(), PhaseOverrideSchema).optional(),
  schedule: ScheduleOverrideSchema,
  /** Task-specific params — keys and types vary per task. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/**
 * Raw context shape inside zod preprocess — accepts the legacy
 * `operating_brief_enabled` key and rewrites it to `cortex_enabled`.
 * Loader emits a deprecation warning once per load (see `loader.ts`).
 */
const ContextSchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const input = raw as Record<string, unknown>;
    if ('operating_brief_enabled' in input && !('cortex_enabled' in input)) {
      const { operating_brief_enabled, ...rest } = input;
      return { ...rest, cortex_enabled: operating_brief_enabled };
    }
  }
  return raw;
}, z.object({
  /** Preferred digest tier when a user or agent explicitly requests Myco context. */
  digest_tier: z.number().int().default(5000),
  /** Append the preferred digest extract at session start after Cortex instructions. */
  session_start_digest_enabled: z.boolean().default(false),
  /** Master switch for Cortex session-start instruction injection. */
  cortex_enabled: z.boolean().default(true),
  /** Enable semantic spore search on each user prompt. */
  prompt_search: z.boolean().default(true),
  /** Max spores to inject per prompt (0-10). */
  prompt_max_spores: z.number().int().min(0).max(10).default(3),
}));

const AgentSchema = z.object({
  /** Number of batches between event-driven summary triggers (0 to disable). */
  summary_batch_interval: z.number().int().min(0).default(5),
  /** Global toggle for PowerManager-scheduled agent tasks. */
  scheduled_tasks_enabled: z.boolean().default(true),
  /** Global toggle for event-driven agent tasks (title-summary, Cortex refresh). */
  event_tasks_enabled: z.boolean().default(true),
  /** Global default provider — applies to all tasks unless overridden per-task. */
  provider: ProviderOverrideSchema.optional(),
  /** Global default runtime — applies to all tasks unless overridden per-task. */
  runtime: RuntimeIdSchema.optional(),
  /** Global default model — applies to all tasks unless overridden per-task. */
  model: z.string().optional(),
  /** Per-task overrides keyed by task name. */
  tasks: z.record(z.string(), TaskProviderOverrideSchema).optional(),
});

const BackupSchema = z.object({
  /** Override directory for backup files. Supports ~ for home directory. When unset, defaults to .myco/backups. */
  dir: z.string().optional(),
});

const MaintenanceSchema = z.object({
  /** Automatically run PRAGMA optimize on a schedule. */
  auto_optimize: z.boolean().default(true),
  /** How often to run auto-optimize, in hours (1–720). */
  auto_optimize_interval_hours: z.number().int().min(1).max(720).default(24),
});

const UpdateSchema = z.object({
  /**
   * Per-project release preference for the Operations update flow.
   * Stored in local.yaml so one project can dogfood/beta-test without
   * changing the machine-wide baseline used by unrelated projects.
   */
  channel: z.enum(['stable', 'beta']).default('stable'),
});

const TeamSchema = z.object({
  /** Whether team sync is enabled. */
  enabled: z.boolean().default(false),
  /** Cloudflare Worker URL for team sync. */
  worker_url: z.string().url().optional(),
  /** Team identifier for sync grouping. */
  team_id: z.string().optional(),
  /** Sync interval in minutes. */
  interval_minutes: z.number().int().min(1).max(1440).default(15),
});

const SkillsSchema = z.object({
  /** Auto-generate candidates above this confidence score. */
  confidence_threshold: z.number().min(0).max(1).default(0.7),
  /** Flag unused skills after this many days. */
  usage_stale_days: z.number().int().positive().default(30),
});

const NotificationsSchema = z.object({
  /** Master switch — disables all notifications when false. */
  enabled: z.boolean().default(true),
  /** Allow browser system notifications (Notification API). */
  system_notifications: z.boolean().default(false),
  /** Default display mode for new notification types. */
  default_mode: z.enum(['banner', 'summary']).default('summary'),
  /** Per-domain settings. Keys are domain names from the registry. */
  domains: z.record(z.string(), z.object({
    enabled: z.boolean().default(true),
    /** Override display mode for this domain. Omit to use global default_mode. */
    mode: z.enum(['banner', 'summary']).optional(),
  })).default({}),
});

const SymbiontEntrySchema = z.object({
  enabled: z.boolean().default(true),
});

/**
 * Canopy — the project-local data plane for code intelligence.
 * Controls collection (scanning, exclusion, refresh cadence). Separate from
 * what Cortex does with the collected data (see CortexSchema below).
 */
const CanopyRefreshSchema = z.object({
  /** Whether the PowerManager-scheduled background rescan runs at all. */
  background_enabled: z.boolean().default(true),
  /** Human-readable period consumed by PowerManager's duration parser. */
  background_period: z.string().default('1h'),
});

const CanopyExcludeSchema = z.object({
  /** Glob/segment patterns skipped during scans. */
  patterns: z.array(z.string()).default([
    'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
    '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
  ]),
});

const CanopySchema = z.object({
  refresh: CanopyRefreshSchema.default(() => CanopyRefreshSchema.parse({})),
  exclude: CanopyExcludeSchema.default(() => CanopyExcludeSchema.parse({})),
});

/**
 * Cortex controls — what Cortex does with collected data.
 * Nested because the scoped-settings surface groups consumer-side
 * configuration separately from the data plane.
 */
const CortexCanopyInjectionSchema = z.object({
  /** Master switch for PreToolUse Canopy injection on Read. */
  enabled: z.boolean().default(true),
  /** Minimum size_bytes before injection is offered. */
  size_threshold: z.number().int().default(800),
});

const CortexCanopyLlmSchema = z.object({
  /** Enable the Tier 2 `canopy-describe` task. Default off — opt in. */
  enabled: z.boolean().default(false),
  /** Reasoning tier hint passed to the provider selector. */
  reasoning_tier: z.enum(['low', 'medium', 'high']).default('low'),
  /** Prompt ref resolved under packages/myco/src/prompts/. */
  prompt_ref: z.string().default('canopy-describe'),
  /** Hard cap on post-processed description length. */
  max_description_chars: z.number().int().default(180),
  /** Retry budget before leaving llm_description NULL. */
  max_attempts: z.number().int().default(2),
});

const CortexCanopySchema = z.object({
  injection: CortexCanopyInjectionSchema.default(() => CortexCanopyInjectionSchema.parse({})),
  llm: CortexCanopyLlmSchema.default(() => CortexCanopyLlmSchema.parse({})),
});

const CortexSchema = z.object({
  canopy: CortexCanopySchema.default(() => CortexCanopySchema.parse({})),
});

export {
  APPEARANCE_THEMES,
  APPEARANCE_MODES,
  APPEARANCE_FONTS,
  APPEARANCE_DENSITIES,
  type AppearanceValues,
} from './appearance-values.js';

import {
  APPEARANCE_THEMES,
  APPEARANCE_MODES,
  APPEARANCE_FONTS,
  APPEARANCE_DENSITIES,
} from './appearance-values.js';

export const AppearanceConfigSchema = z.object({
  theme: z.enum(APPEARANCE_THEMES).default('sage'),
  mode: z.enum(APPEARANCE_MODES).default('dark'),
  font: z.enum(APPEARANCE_FONTS).default('default'),
  density: z.enum(APPEARANCE_DENSITIES).default('normal'),
}).default({ theme: 'sage', mode: 'dark', font: 'default', density: 'normal' });

export type AppearanceConfig = z.infer<typeof AppearanceConfigSchema>;

export const MycoConfigSchema = z.preprocess(
  (raw: unknown) => {
    if (raw && typeof raw === 'object' && 'curation' in raw && !('agent' in raw)) {
      const { curation, ...rest } = raw as Record<string, unknown>;
      return { ...rest, agent: curation };
    }
    return raw;
  },
  z.object({
    version: z.literal(3),
    config_version: z.number().int().nonnegative().default(0),
    embedding: EmbeddingProviderSchema.default(() => EmbeddingProviderSchema.parse({})),
    daemon: DaemonSchema.default(() => DaemonSchema.parse({})),
    hub: HubSchema.default(() => HubSchema.parse({})),
    capture: CaptureSchema.default(() => CaptureSchema.parse({})),
    agent: AgentSchema.default(() => AgentSchema.parse({})),
    context: ContextSchema.default(() => ContextSchema.parse({})),
    backup: BackupSchema.default(() => BackupSchema.parse({})),
    maintenance: MaintenanceSchema.default(() => MaintenanceSchema.parse({})),
    update: UpdateSchema.default(() => UpdateSchema.parse({})),
    team: TeamSchema.default(() => TeamSchema.parse({})),
    skills: SkillsSchema.default(() => SkillsSchema.parse({})),
    notifications: NotificationsSchema.default(() => NotificationsSchema.parse({})),
    canopy: CanopySchema.default(() => CanopySchema.parse({})),
    cortex: CortexSchema.default(() => CortexSchema.parse({})),
    appearance: AppearanceConfigSchema,
    symbionts: z.record(z.string(), SymbiontEntrySchema).optional(),
  }),
);

export type MycoConfig = z.output<typeof MycoConfigSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
export type TaskProviderOverride = z.infer<typeof TaskProviderOverrideSchema>;
export type PhaseOverride = z.infer<typeof PhaseOverrideSchema>;
export type ScheduleOverride = z.infer<typeof ScheduleOverrideSchema>;
export type ContextConfig = z.infer<typeof ContextSchema>;
export type BackupConfig = z.infer<typeof BackupSchema>;
export type HubConfig = z.infer<typeof HubSchema>;
export type TeamConfig = z.infer<typeof TeamSchema>;
export type SkillsConfig = z.infer<typeof SkillsSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsSchema>;
export type CanopyConfig = z.infer<typeof CanopySchema>;
export type CortexConfig = z.infer<typeof CortexSchema>;
export type SymbiontEntry = z.infer<typeof SymbiontEntrySchema>;
