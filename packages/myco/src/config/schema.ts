import { z } from 'zod';
import { SCHEDULABLE_POWER_STATES } from '@myco/constants.js';
import { AcceleratorConfigSchema, ReasoningLevelSchema, HarnessIdSchema } from '@myco/agent/schemas.js';

function rejectLegacyRuntimeKey<T extends z.ZodTypeAny>(schema: T) {
  return z.unknown().superRefine((value, ctx) => {
    if (
      value
      && typeof value === 'object'
      && Object.prototype.hasOwnProperty.call(value, 'runtime')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use "harness" instead of legacy "runtime"',
      });
    }
  }).pipe(schema);
}

const EmbeddingProviderSchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible', 'openrouter', 'openai']).default('ollama'),
  model: z.string().default('bge-m3'),
  base_url: z.string().url().optional(),
  /**
   * When true, the embedding reconcile loop continues running in the deep-sleep
   * power state — the daemon stays in `sleep` (with a longer tick interval)
   * instead of entering deep sleep, as long as embedding work is pending.
   * Recommended for projects with large embedding backlogs so the queue keeps
   * draining when the machine sits idle long enough to deep-sleep.
   */
  run_in_deep_sleep: z.boolean().default(true),
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

const CaptureSchema = z.object({
  transcript_paths: z.array(z.string()).default([]),
  plan_dirs: z.array(z.string()).default([]),
  ignore_plan_dirs_in_git: z.boolean().default(false),
  artifact_extensions: z.array(z.string()).default(['.md']),
  buffer_max_events: z.number().int().positive().default(500),
});

/** Provider config shape used in both task-level and phase-level overrides. */
const ProviderOverrideSchema = rejectLegacyRuntimeKey(z.object({
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
}));

/** Per-phase overrides within a task — keyed by phase name. */
const PhaseOverrideSchema = rejectLegacyRuntimeKey(z.object({
  provider: ProviderOverrideSchema.optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
}));

/** Per-task schedule override — partial, merges with YAML defaults. */
const ScheduleOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().positive().optional(),
  runIn: z.array(z.enum([...SCHEDULABLE_POWER_STATES])).optional(),
  preCondition: z.enum(['has-unprocessed-batches', 'has-active-skills', 'has-approved-candidates', 'has-skill-survey-evidence', 'has-pending-canopy-rows']).optional(),
  accelerator: AcceleratorConfigSchema.optional(),
}).optional();

/** Per-task config override — stored in myco.yaml under agent.tasks. */
const TaskProviderOverrideSchema = rejectLegacyRuntimeKey(z.object({
  provider: ProviderOverrideSchema.optional(),
  harness: HarnessIdSchema.optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  phases: z.record(z.string(), PhaseOverrideSchema).optional(),
  schedule: ScheduleOverrideSchema,
  /** Task-specific params — keys and types vary per task. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}));

// (Legacy `context.*` and root `canopy.*` blocks unified into `cortex.*`
// in config_version 8. See migrations.ts:migrateV7ToV8.)

const AgentSchema = rejectLegacyRuntimeKey(z.object({
  /** Number of batches between event-driven summary triggers (0 to disable). */
  summary_batch_interval: z.number().int().min(0).default(5),
  /** Global toggle for PowerManager-scheduled agent tasks. */
  scheduled_tasks_enabled: z.boolean().default(true),
  /** Global toggle for event-driven agent tasks (title-summary, Cortex refresh). */
  event_tasks_enabled: z.boolean().default(true),
  /** Global default provider — applies to all tasks unless overridden per-task. */
  provider: ProviderOverrideSchema.optional(),
  /** Global default harness — applies to all tasks unless overridden per-task. */
  harness: HarnessIdSchema.optional(),
  /** Global default model — applies to all tasks unless overridden per-task. */
  model: z.string().optional(),
  /** Per-task overrides keyed by task name. */
  tasks: z.record(z.string(), TaskProviderOverrideSchema).optional(),
}));

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

export const TeamSchema = z.object({
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
 * Canopy data plane — collection knobs (scanning cadence + exclusion).
 * Lives under `cortex.canopy:` alongside `cortex.canopy.inject_on_pre_tool_use`
 * because Canopy is a Cortex feature; the data plane and the consumer
 * toggle being siblings keeps everything Canopy-related in one block.
 */
const CanopyRefreshSchema = z.object({
  /** Whether the PowerManager-scheduled background rescan runs at all. */
  background_enabled: z.boolean().default(true),
  /** Period between background rescans, in minutes. */
  background_period_minutes: z.number().int().min(1).default(60),
});

/**
 * Myco-maintained baseline of paths the scanner should always skip,
 * regardless of what the project's `.gitignore` says. These cover
 * filesystem conventions (`.git/`, `.DS_Store`), build outputs, and
 * dependency caches that aren't useful Canopy entries even when
 * accidentally tracked. Edited via schema migrations, not user config —
 * the UI surfaces them read-only so users can see what's already covered.
 */
const CANOPY_DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  // Source control + filesystem noise
  '.git',
  '.DS_Store',
  // Dependency trees
  'node_modules',
  // Python: bytecode, venvs, test/lint caches
  '__pycache__',
  '.venv', 'venv', 'env', 'ENV',
  '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox',
  // Build/output dirs (JS, Rust, Java)
  'dist', 'build', 'target', '.gradle', '.cache',
  // Framework caches
  '.next', '.nuxt', '.turbo', '.svelte-kit',
  // Lockfiles — checked-in but not useful to describe/embed
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
];

const CanopyExcludeSchema = z.object({
  /**
   * Myco-maintained baseline patterns. Defaulted from
   * `CANOPY_DEFAULT_EXCLUDE_PATTERNS` so existing projects pick up new
   * baseline entries automatically on the next config load. Users
   * shouldn't edit this array directly — the UI renders it read-only and
   * surfaces `patterns` for additions.
   */
  default_patterns: z.array(z.string()).default(() => [...CANOPY_DEFAULT_EXCLUDE_PATTERNS]),
  /**
   * Extra glob/segment patterns the scanner should skip on top of the
   * baseline, the project's `.gitignore`, and Myco's managed segments.
   * Empty by default — most projects' `.gitignore` plus the baseline
   * already cover what matters; this is the user-additive layer.
   */
  patterns: z.array(z.string()).default([]),
});

/**
 * Cortex — Myco's session-aware injection surface. Organized by feature
 * to mirror the Settings UI: instructions, digest, spores, canopy. Each
 * feature exposes one or more `inject_on_<lifecycle_event>` toggles
 * naming the hook point at which Cortex acts (session_start,
 * prompt_submit, pre_tool_use). `inject_on_*` is always a flat boolean;
 * tuning lives at the same level beside it (e.g.
 * `spores.max_per_prompt`, `canopy.min_file_bytes`).
 */
const CortexInstructionsSchema = z.object({
  /** Inject Cortex-built session-start instructions at SessionStart. */
  inject_on_session_start: z.boolean().default(true),
});

const CortexDigestSchema = z.object({
  /**
   * Default digest tier — used both at session-start injection time AND
   * as the default tier returned by `myco_cortex` digest retrievals.
   */
  tier: z.number().int().default(5000),
  /** Append the preferred digest extract at session start. */
  inject_on_session_start: z.boolean().default(false),
});

const CortexSporesSchema = z.object({
  /** Run semantic spore search on each user prompt and inject hits. */
  inject_on_prompt_submit: z.boolean().default(true),
  /** Max spores to inject per prompt (0-10). */
  max_per_prompt: z.number().int().min(0).max(10).default(3),
});

const CortexCanopySchema = z.object({
  /** When/how the Canopy index is rebuilt (data plane). */
  refresh: CanopyRefreshSchema.default(() => CanopyRefreshSchema.parse({})),
  /** What the scanner skips (data plane). */
  exclude: CanopyExcludeSchema.default(() => CanopyExcludeSchema.parse({})),
  /** Inject Canopy entry anatomy on Read at PreToolUse (consumer plane). */
  inject_on_pre_tool_use: z.boolean().default(true),
  /** Minimum file size in bytes before injection is offered. */
  min_file_bytes: z.number().int().default(800),
});

const CortexSchema = z.object({
  /** Master kill for the entire Cortex layer. */
  enabled: z.boolean().default(true),
  instructions: CortexInstructionsSchema.default(() => CortexInstructionsSchema.parse({})),
  digest: CortexDigestSchema.default(() => CortexDigestSchema.parse({})),
  spores: CortexSporesSchema.default(() => CortexSporesSchema.parse({})),
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
    capture: CaptureSchema.default(() => CaptureSchema.parse({})),
    agent: AgentSchema.default(() => AgentSchema.parse({})),
    backup: BackupSchema.default(() => BackupSchema.parse({})),
    maintenance: MaintenanceSchema.default(() => MaintenanceSchema.parse({})),
    update: UpdateSchema.default(() => UpdateSchema.parse({})),
    team: TeamSchema.default(() => TeamSchema.parse({})),
    skills: SkillsSchema.default(() => SkillsSchema.parse({})),
    notifications: NotificationsSchema.default(() => NotificationsSchema.parse({})),
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
// ContextSchema removed in config_version 8 (unified into CortexSchema).
export type BackupConfig = z.infer<typeof BackupSchema>;
export type TeamConfig = z.infer<typeof TeamSchema>;
export type SkillsConfig = z.infer<typeof SkillsSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsSchema>;
// CanopyConfig removed in config_version 8 — Canopy now lives under
// `cortex.canopy`. Use `MycoConfig['cortex']['canopy']` for the slice.
export type CortexConfig = z.infer<typeof CortexSchema>;
export type SymbiontEntry = z.infer<typeof SymbiontEntrySchema>;
