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

const EmbeddingProviderBaseSchema = z.object({
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
const EmbeddingProviderSchema = EmbeddingProviderBaseSchema;

const DaemonSchema = z.object({
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
  ignore: z.object({
    paths: z.array(z.string()).default([]),
    /** Globs matched against the absolute project root; `~` is expanded. */
    patterns: z.array(z.string()).default([]),
  }).default(() => ({ paths: [], patterns: [] })),
});

/**
 * Map a glob over project paths to a release tag family. Used so a monorepo
 * record changed inside `packages/myco-team/` classifies against
 * `myco-team-v*` instead of the umbrella `v*` tags, avoiding false-positive
 * "released" annotations.
 */
const PackageTagMappingSchema = z.object({
  /** Glob-like prefix on the project path (e.g. "packages/myco-team/"). */
  path_glob: z.string().min(1),
  /** Tag pattern (e.g. "myco-team-v*") matched against integration/production refs. */
  tag_pattern: z.string().min(1),
});

const ReleaseGithubSchema = z.object({
  /** GitHub owner/name. Empty disables PR-evidence lookup. */
  repo: z.string().default(''),
  /** Env var holding the GitHub token. Token VALUES must never appear in YAML. */
  token_env: z.string().default('GITHUB_TOKEN'),
  /** Cap per-reconcile PR lookups so a noisy backlog can't drain the rate limit. */
  max_lookups_per_run: z.number().int().min(0).max(200).default(20),
}).superRefine((value, ctx) => {
  if (/^(gh[pous]_|github_pat_)[A-Za-z0-9_-]/.test(value.repo)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'release_provenance.github.repo looks like a token value; tokens belong in env, not config',
      path: ['repo'],
    });
  }
});

const ReleaseProvenanceSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Project-owned refs that represent shipped/production code. Empty keeps
   * derived state unreconciled rather than guessing from branch names.
   */
  production_refs: z.array(z.string().min(1)).default([]),
  /** Project-owned refs that represent merged-but-not-yet-shipped code. */
  integration_refs: z.array(z.string().min(1)).default([]),
  /**
   * Grove-operational cadence for the PowerManager reconciler. Grove config
   * may set this; project/personal overlays can override when needed.
   */
  reconcile_interval_minutes: z.number().int().min(1).max(1440).default(15),
  /** Production-debug retrieval may include unknown clues alongside released hits. */
  production_debug_include_unknown: z.boolean().default(true),
  /** Optional GitHub PR squash-merge evidence; degraded gracefully when absent. */
  github: ReleaseGithubSchema.default(() => ReleaseGithubSchema.parse({})),
  /** Monorepo package-map entries; absent maps fall back to the umbrella refs. */
  package_map: z.array(PackageTagMappingSchema).default([]),
});

const GroveReleaseProvenanceSchema = z.object({
  reconcile_interval_minutes: z.number().int().min(1).max(1440).default(15),
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
  /**
   * Tier override. Resolves through the provider's `reasoning_map` at
   * run time, which keeps the override portable across model upgrades
   * (sonnet 4.6 → 4.7) and runtime swaps (anthropic → ollama). Prefer
   * this over `model:` for any tier-class change; `model:` is the
   * escape hatch when you need to pin a specific SKU.
   */
  reasoningLevel: ReasoningLevelSchema.optional(),
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
  /**
   * Task default reasoning tier. Resolves through the provider's
   * `reasoning_map` at run time, so it stays portable across model upgrades
   * and runtime swaps. Prefer this over `model:`; `model:` pins a specific SKU.
   */
  reasoningLevel: ReasoningLevelSchema.optional(),
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

const AgentBaseSchema = z.object({
  /** Number of batches between event-driven summary triggers (0 to disable). */
  summary_batch_interval: z.number().int().min(0).default(5),
  /** Global toggle for PowerManager-scheduled agent tasks. */
  scheduled_tasks_enabled: z.boolean().default(true),
  /** Global toggle for event-driven agent tasks (title-summary, Cortex refresh). */
  event_tasks_enabled: z.boolean().default(true),
  /**
   * Skip scheduled agent tasks when the project has had no session or
   * prompt-batch activity within this window. Token-spending tasks
   * (canopy-describe, skill-survey, …) shouldn't keep firing on a
   * project the user hasn't touched in weeks. Set to 0 to disable
   * cold-project gating entirely.
   */
  cold_project_threshold_days: z.number().int().min(0).max(365).default(14),
  /**
   * Grove-tier override for scheduled-task activity gating. The Grove
   * config sets this; the merged config carries it for runtime consumers.
   * (Storage tier: Grove. See GroveConfigSchema.)
   */
  scheduled_tasks_active_window_days: z.number().int().min(0).max(365).default(14),
  /** Global default provider — applies to all tasks unless overridden per-task. */
  provider: ProviderOverrideSchema.optional(),
  /** Global default harness — applies to all tasks unless overridden per-task. */
  harness: HarnessIdSchema.optional(),
  /**
   * Grove-wide default reasoning tier. Resolves through the provider's
   * `reasoning_map` at run time, so it stays portable across model upgrades
   * and runtime swaps — the same rationale as the per-task/per-phase
   * `reasoningLevel`. Applies when a task sets no reasoning level of its own;
   * falls back to the built-in `default` tier when unset. Prefer this over
   * `model:`; `model:` is the escape hatch that pins a specific SKU.
   */
  reasoningLevel: ReasoningLevelSchema.optional(),
  /**
   * Global default model — the escape hatch that pins a specific SKU when a
   * reasoning tier has no mapping (e.g. local providers without a
   * reasoning_map). Applies to all tasks unless overridden per-task.
   */
  model: z.string().optional(),
  /** Per-task overrides keyed by task name. */
  tasks: z.record(z.string(), TaskProviderOverrideSchema).optional(),
});
const AgentSchema = rejectLegacyRuntimeKey(AgentBaseSchema);

const BackupRetentionSchema = z.object({
  /** Number of most-recent daily backups to keep per (Grove, machine). */
  keep_daily: z.number().int().min(1).max(365).default(14),
  /** Number of weekly backups to keep beyond the daily window. */
  keep_weekly: z.number().int().min(0).max(52).default(8),
});

const BackupSchema = z.object({
  /**
   * Override directory for backup files. Supports ~ for home directory.
   * When unset, defaults to <groveHome>/backups. Storage tier: Grove
   * (one canonical backup root per Grove); see GroveConfigSchema.
   */
  dir: z.string().optional(),
  retention: BackupRetentionSchema.default(() => BackupRetentionSchema.parse({})),
  /**
   * Minimum hours between auto-backups. The auto-backup PowerJob fires
   * on every idle/sleep tick by default; without this gate it would
   * create a fresh backup whenever the daemon transitions through a
   * dormant phase, churning through retention slots in hours. Default
   * = 24 (one backup per day per machine_id).
   */
  auto_interval_hours: z.number().int().min(1).max(720).default(24),
});

const MaintenanceSchema = z.object({
  /** Automatically run PRAGMA optimize on a schedule. */
  auto_optimize: z.boolean().default(true),
  /** How often to run auto-optimize, in hours (1–720). */
  auto_optimize_interval_hours: z.number().int().min(1).max(720).default(24),
  /**
   * Automatically run an integrity + foreign-key check on a slow cadence.
   * Failures are surfaced via LOG_KINDS.DATABASE_INTEGRITY_ISSUES so they
   * appear in the Database panel without a separate notification path.
   */
  auto_integrity_check: z.boolean().default(true),
  /** How often to run auto integrity-check, in hours. Default = 168 (weekly). */
  auto_integrity_check_interval_hours: z.number().int().min(1).max(8760).default(168),
});

/**
 * Legacy release-channel block. Kept on `MycoConfigSchema` for back-compat
 * only — the release channel is now machine-scoped on
 * `daemon.update_channel` (decision-46130740). A `update.channel` value in
 * any project file (myco.yaml or local.yaml) is ignored at runtime; the
 * loader's `migrateLegacyProjectFields` lifts it to machine once (only when
 * machine has no explicit value) and then strips it. Do not reintroduce a
 * per-project override here.
 */
const UpdateSchema = z.object({
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
  /** Master gate for the Skills capability (survey/generate/evolve tasks). */
  enabled: z.boolean().default(true),
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
  /** Retention window for acknowledged notifications. 0 deletes them on the next prune. */
  retention_days: z.number().int().min(0).max(365).default(30),
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
  /** Inject a compact Cortex primer when a supported symbiont starts a subagent. */
  inject_on_subagent_start: z.boolean().default(true),
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

const CortexPlansSchema = z.object({
  /** Inject a one-sentence tools-first plan nudge when the prompt shows planning intent. */
  inject_intent_nudge_on_prompt_submit: z.boolean().default(true),
});

const CortexCanopySchema = z.object({
  /** Master gate for the Canopy capability (map/describe tasks, background
   *  scan, PreToolUse injection). Migrated from `inject_on_pre_tool_use` —
   *  see the gate-honoring plan for the one-time compat default. */
  enabled: z.boolean().default(true),
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
  plans: CortexPlansSchema.default(() => CortexPlansSchema.parse({})),
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

// ---------------------------------------------------------------------------
// Tier schemas — three storage tiers, four files
// ---------------------------------------------------------------------------
//
// Each setting has exactly one canonical tier. The loader reads each file
// with its own tier schema (which uses `strictObject` to reject foreign
// keys), then merges the per-tier values into the unified `MycoConfig`
// shape that runtime consumers see.
//
// Storage layout:
//   ~/.myco/config.yaml                     — Machine tier (one daemon per machine)
//   ~/.myco/groves/<id>/config.yaml         — Grove tier (per-Grove DB policies)
//   <project>/.myco/myco.yaml               — Project tier (VCS-tracked)
//   <project>/.myco/local.yaml              — Personal override (gitignored, sparse)
//
// Resolution order on read: machine → grove → project → personal (highest).

/**
 * Machine tier — one daemon process per machine, one log policy.
 * Stored in `~/.myco/config.yaml`. Sparse — every field has a default.
 *
 * The daemon's listening port is NOT configurable: it's deterministically
 * derived from the service path via `derivePort` so launchers, hooks, and
 * MCP children all converge on the same value without per-machine config
 * lookup. See `daemon/port.ts`.
 */
const MachineDaemonSchema = z.object({
  /** Log verbosity for the daemon process (stdout/stderr). */
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /**
   * Retention window for `log_entries` rows across every Grove DB this
   * daemon serves. One daemon → one retention policy (different Groves
   * could in principle have different policies, but uniformity here
   * keeps the operator surface simple and matches the daemon-process
   * mental model).
   */
  log_retention_days: z.number().int().min(1).max(365).default(30),
  /** Update channel — `stable` (default) or `beta` for dogfood/preview builds. */
  update_channel: z.enum(['stable', 'beta']).default('stable'),
});

// NOTE: the registry block (`grove.default_grove_id`) used to live
// inside MachineConfigSchema under `.passthrough()`. It now lives in
// `~/.myco/groves/registry.yaml` (see `resolveGroveRegistryPath`).
// The preprocess below strips the legacy field before strict
// validation so existing installs keep parsing — the registry value
// is migrated to the new file the first time `getDefaultGroveId`
// runs after upgrade.
//
// `daemon.port` was a pre-Grove machine-level override of the daemon
// port. Post-Grove the canonical port is always `derivePort` of the
// service path; the override silently broke port resolution for users
// whose stale value didn't match the canonical. Strip it here so old
// `~/.myco/config.yaml` files keep parsing under strict mode while the
// runtime ignores the dead field.
export const MachineConfigSchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { grove: _legacy, daemon, ...rest } = raw as Record<string, unknown>;
    if (daemon && typeof daemon === 'object' && !Array.isArray(daemon)) {
      const { port: _deadPort, ...daemonRest } = daemon as Record<string, unknown>;
      return { ...rest, daemon: daemonRest };
    }
    return { ...rest, ...(daemon !== undefined ? { daemon } : {}) };
  }
  return raw;
}, z.object({
  daemon: MachineDaemonSchema.default(() => MachineDaemonSchema.parse({})),
  /**
   * Plan/transcript/artifact capture. Machine-tier post global-install:
   * symbionts are installed globally now, so the watched plan/transcript
   * dirs, artifact extensions, and buffer cap are a per-machine capture
   * policy — not a per-repo, git-committed setting. The per-project
   * side-effect (managed `.gitignore` block) still fires via the
   * capture config-write reaction, which runs on machine-config writes too.
   */
  capture: CaptureSchema.default(() => CaptureSchema.parse({})),
  /**
   * Notification preferences. Machine-tier: noise tolerance, display mode,
   * and per-domain overrides are a local per-user preference that must
   * never be git-committed.
   */
  notifications: NotificationsSchema.default(() => NotificationsSchema.parse({})),
  /** Optional override of the auto-resolved machine id. */
  machine_id: z.string().optional(),
}).strict());

/**
 * Grove tier — per-Grove-DB policies (backups, maintenance cadences,
 * embedding-pause behavior, scheduled-task activity window). Stored in
 * `~/.myco/groves/<id>/config.yaml`. Each Grove on the machine has its
 * own file; team-sync does NOT replicate this — it stays local per machine.
 */
const GroveDaemonSchema = z.object({
  /**
   * Time without new prompts before an active session is auto-completed (ms).
   * Per-Grove because session lifecycle is per-Grove.
   */
  stale_session_threshold_ms: z.number().int().min(60_000).default(60 * 60 * 1000),
});
const GroveEmbeddingSchema = z.object({
  /** Keep the embedding-reconcile loop running while the Grove sleeps. */
  run_in_deep_sleep: z.boolean().default(true),
  ...EmbeddingProviderBaseSchema.omit({ run_in_deep_sleep: true }).shape,
});
const GroveAgentSchema = rejectLegacyRuntimeKey(z.object({
  /**
   * Cap how recently a project must have been active (sessions or
   * prompt_batches) for scheduled tasks to fire against it. 0 disables
   * cold-project gating.
   */
  scheduled_tasks_active_window_days: z.number().int().min(0).max(365).default(14),
  summary_batch_interval: z.number().int().min(0).default(5),
  scheduled_tasks_enabled: z.boolean().default(true),
  event_tasks_enabled: z.boolean().default(true),
  cold_project_threshold_days: z.number().int().min(0).max(365).default(14),
  provider: ProviderOverrideSchema.optional(),
  harness: HarnessIdSchema.optional(),
  reasoningLevel: ReasoningLevelSchema.optional(),
  model: z.string().optional(),
  tasks: z.record(z.string(), TaskProviderOverrideSchema).optional(),
}));

const VaultEvolutionSchema = z.object({
  /** Master gate for the Vault-Evolution capability (the `vault-evolve`
   *  scheduled task). Grove-tier home; per-project Personal override. */
  enabled: z.boolean().default(true),
});

export const GroveConfigSchema = z.object({
  daemon: GroveDaemonSchema.default(() => GroveDaemonSchema.parse({})),
  backup: BackupSchema.default(() => BackupSchema.parse({})),
  maintenance: MaintenanceSchema.default(() => MaintenanceSchema.parse({})),
  embedding: GroveEmbeddingSchema.default(() => GroveEmbeddingSchema.parse({})),
  agent: GroveAgentSchema.default(() => GroveAgentSchema.parse({})),
  release_provenance: GroveReleaseProvenanceSchema.default(() => GroveReleaseProvenanceSchema.parse({})),
  appearance: AppearanceConfigSchema,
  /** Team sync activation — Grove-scoped per the migration plan. */
  team: TeamSchema.default(() => TeamSchema.parse({})),
  /**
   * Skill-lifecycle thresholds. Grove-tier: skills are *generated* per
   * project, but these are myco-agent thresholds (survey auto-promote
   * confidence, stale-usage window) that belong to the Grove the same way
   * the rest of `agent.*` does.
   */
  skills: SkillsSchema.default(() => SkillsSchema.parse({})),
  /** Vault-Evolution capability master gate (Grove-tier home). */
  vault_evolution: VaultEvolutionSchema.default(() => VaultEvolutionSchema.parse({})),
}).strict();

/**
 * Project tier — VCS-tracked, defines the project's identity and the
 * intelligence the daemon runs against it. Excludes machine fields
 * (port, log policy) and Grove fields (backup, maintenance) — those are
 * silently stripped on load if they appear here (legacy migration).
 */
export const ProjectConfigSchema = z.object({
  version: z.literal(3),
  config_version: z.number().int().nonnegative().default(0),
  // capture.* → Machine, notifications.* → Machine, skills.* → Grove as of
  // the 2026-06 settings-scope correction. Removed from the project tier so
  // saveConfig strips any residue from myco.yaml; the tier-strip migration
  // (PROJECT_TIER_LEGACY_FIELDS + migrateLegacyProjectFields) relocates
  // existing values to their new tier files.
  release_provenance: ReleaseProvenanceSchema.default(() => ReleaseProvenanceSchema.parse({})),
  cortex: CortexSchema.default(() => CortexSchema.parse({})),
  symbionts: z.record(z.string(), SymbiontEntrySchema).optional(),
});

/**
 * Personal tier — sparse per-project overrides on this machine.
 * Gitignored. Lenient by design (sparse `Partial<MycoConfig>`-shaped) so
 * users can drop in a small override without forcing every nested key to
 * be present. The loader merges this on top of the resolved Project tier
 * during read; no validation gate beyond the merged result hitting
 * MycoConfigSchema.
 */
export const PersonalConfigSchema = z.record(z.string(), z.unknown());

export type MachineConfig = z.output<typeof MachineConfigSchema>;
export type GroveConfig = z.output<typeof GroveConfigSchema>;
export type ProjectConfig = z.output<typeof ProjectConfigSchema>;
export type PersonalConfig = z.input<typeof PersonalConfigSchema>;

/**
 * Agent + embedding paths that are Grove-tier, not Project-tier. The loader
 * strips them from project myco.yaml on load when the project is Grove-bound
 * (gated by `hasGrove`), so stale project-tier values never shadow Grove
 * config. When unbound, they're retained until a Grove exists to honor.
 */
export const GROVE_PROMOTED_FIELDS: ReadonlyArray<readonly string[]> = [
  ['embedding', 'provider'],
  ['embedding', 'model'],
  ['embedding', 'base_url'],
  ['agent', 'provider'],
  ['agent', 'harness'],
  ['agent', 'reasoningLevel'],
  ['agent', 'model'],
  ['agent', 'tasks'],
  ['agent', 'summary_batch_interval'],
  ['agent', 'scheduled_tasks_enabled'],
  ['agent', 'event_tasks_enabled'],
  ['agent', 'cold_project_threshold_days'],
];

/**
 * Grove-tier field paths that may appear in a project myco.yaml as legacy
 * residue. They can only be safely stripped from the project file when a
 * Grove is bound (so the value migrates instead of vanishing); on UNBOUND
 * projects both the load and save paths retain them in myco.yaml. Shared by
 * `stripLegacyProjectFields`, `migrateLegacyProjectFields`, and `saveConfig`
 * so all three move/retain the exact same set.
 */
export const GROVE_TIER_FIELDS: ReadonlyArray<readonly string[]> = [
  ['daemon', 'stale_session_threshold_ms'],
  ['backup'],
  ['maintenance'],
  ['embedding', 'run_in_deep_sleep'],
  ['agent', 'scheduled_tasks_active_window_days'],
  ['appearance'],
  ['team'],
  ...GROVE_PROMOTED_FIELDS,
  // 2026-06: skills.* is Grove-tier; only strip once a Grove is bound so
  // the value can be migrated rather than dropped.
  ['skills'],
];

/** Field paths the loader silently strips from project myco.yaml on load. */
export const PROJECT_TIER_LEGACY_FIELDS: ReadonlyArray<readonly string[]> = [
  ['daemon', 'port'],
  ['daemon', 'log_level'],
  ['daemon', 'log_retention_days'],
  ['daemon', 'stale_session_threshold_ms'],
  ['backup'],
  ['maintenance'],
  ['update'],
  ['team'],
  ['embedding', 'run_in_deep_sleep'],
  ['agent', 'scheduled_tasks_active_window_days'],
  ['appearance'],
  ...GROVE_PROMOTED_FIELDS,
  // 2026-06 settings-scope correction.
  // Machine-tier (always strippable — machine config is always writable):
  ['capture'],
  ['notifications'],
  // Grove-tier (only strippable once a Grove is bound — see GROVE_TIER_FIELDS):
  ['skills'],
];

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
    release_provenance: ReleaseProvenanceSchema.default(() => ReleaseProvenanceSchema.parse({})),
    agent: AgentSchema.default(() => AgentSchema.parse({})),
    backup: BackupSchema.default(() => BackupSchema.parse({})),
    maintenance: MaintenanceSchema.default(() => MaintenanceSchema.parse({})),
    update: UpdateSchema.default(() => UpdateSchema.parse({})),
    team: TeamSchema.default(() => TeamSchema.parse({})),
    skills: SkillsSchema.default(() => SkillsSchema.parse({})),
    vault_evolution: VaultEvolutionSchema.default(() => VaultEvolutionSchema.parse({})),
    notifications: NotificationsSchema.default(() => NotificationsSchema.parse({})),
    cortex: CortexSchema.default(() => CortexSchema.parse({})),
    appearance: AppearanceConfigSchema,
    symbionts: z.record(z.string(), SymbiontEntrySchema).optional(),
  }),
);

export type MycoConfig = z.output<typeof MycoConfigSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
export type ReleaseProvenanceConfig = z.infer<typeof ReleaseProvenanceSchema>;
export type TaskProviderOverride = z.infer<typeof TaskProviderOverrideSchema>;
export type PhaseOverride = z.infer<typeof PhaseOverrideSchema>;
export type ScheduleOverride = z.infer<typeof ScheduleOverrideSchema>;
// ContextSchema removed in config_version 8 (unified into CortexSchema).
export type BackupConfig = z.infer<typeof BackupSchema>;
export type TeamConfig = z.infer<typeof TeamSchema>;
export type SkillsConfig = z.infer<typeof SkillsSchema>;
export type VaultEvolutionConfig = z.infer<typeof VaultEvolutionSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsSchema>;
// CanopyConfig removed in config_version 8 — Canopy now lives under
// `cortex.canopy`. Use `MycoConfig['cortex']['canopy']` for the slice.
export type CortexConfig = z.infer<typeof CortexSchema>;
export type SymbiontEntry = z.infer<typeof SymbiontEntrySchema>;
