/**
 * Settings manifest — the canonical, hand-authored layout for the unified
 * `/settings` page. Each `SettingGroup` becomes a card on the page; each
 * `SettingField` becomes a labelled control inside that card. The control
 * components render off this manifest; a sync test enforces that every
 * entry's `key` resolves to a real leaf in the Zod config schemas at
 * `packages/myco/src/config/schema.ts`, so drift between the schema and this
 * file is caught at test time rather than runtime.
 *
 * Out of scope intentionally: `cortex.*` (its own page), `appearance.*`
 * (sidebar control), `symbionts.*` (separate surface), team credentials
 * (`team.worker_url`, `team.team_id`, `team.mcp_token` — owned by the Team
 * page), and internal book-keeping fields (`version`, `config_version`).
 */

export type SettingScope = 'project' | 'grove' | 'machine';
export type SettingKind = 'toggle' | 'select' | 'number' | 'secret' | 'list' | 'text';

/**
 * Conditional disable: render the field disabled (greyed out) when the
 * referenced sibling field doesn't equal `value`. Used for the
 * "auto_optimize → auto_optimize_interval_hours" pattern where the
 * interval input only makes sense when the toggle is on.
 */
export interface SettingDependsOn {
  /** Manifest key of the sibling field to read. */
  key: string;
  /** Expected value for this field to be active. */
  value: unknown;
}

/**
 * Display-unit conversion for `kind: 'number'` fields whose stored value
 * is in a different unit than the friendly UI unit (e.g., daemon stores
 * milliseconds, user thinks in minutes). Reads divide stored by `factor`;
 * writes multiply UI value by `factor`. `min`/`max`/`step` apply in the
 * display unit, not the stored unit.
 */
export interface SettingUnitConversion {
  /** Short label shown next to the input ("minutes", "hours", etc.). */
  displayUnit: string;
  /** Multiplier: stored = ui * factor; ui = stored / factor. */
  factor: number;
}

/**
 * Render policy for fields owned by a custom group renderer (e.g.,
 * `AgentProviderCard`). These entries stay in the manifest so the sync
 * test verifies they exist in the Zod schema, but they don't render as
 * field rows and don't count toward the TOC field-count badges or the
 * filter-bar scope counters. Search still matches against their label
 * and key, but matches keep the owning group visible rather than
 * surfacing the field row directly.
 */
export type SettingCustomRender = 'card-owns';

export interface SettingField {
  /** Dotted path matching the Zod schema. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Real backend scope. */
  scope: SettingScope;
  /** Control kind. */
  kind: SettingKind;
  /** Category label for the TOC rail. */
  category: string;
  /** Lucide icon name for the group header. */
  icon: string;
  /** Optional helper text. */
  note?: string;
  /** Read-only display (derived values). */
  readonly?: boolean;
  /** Options for `kind: 'select'`. */
  options?: readonly string[];
  /** Min/max for `kind: 'number'` (in the display unit when `unit` is set). */
  min?: number;
  max?: number;
  /** Step for `kind: 'number'` (defaults to 1). */
  step?: number;
  /** Trailing label rendered next to the input (e.g. "hours", "days"). */
  suffix?: string;
  /** Conditional disable rule. */
  dependsOn?: SettingDependsOn;
  /** Display-unit conversion for `kind: 'number'`. */
  unit?: SettingUnitConversion;
  /**
   * For `kind: 'text'`: write `null` when the trimmed value is empty,
   * instead of writing an empty string. Matches the pre-merge convention
   * of using `null` to clear an override.
   */
  nullableEmpty?: boolean;
  /**
   * Marks this field as owned by a custom group renderer. The page won't
   * render a field row for it; sync test still verifies the key exists.
   */
  customRender?: SettingCustomRender;
}

export interface SettingGroup {
  /** URL anchor + dedupe key. */
  id: string;
  /** Group label shown in the card header. */
  label: string;
  /** Short description. */
  desc: string;
  /** Top-level category (matches `SettingField.category`). */
  category: string;
  /** Group-level Lucide icon. */
  icon: string;
  fields: SettingField[];
}

export const SETTINGS_GROUPS: readonly SettingGroup[] = [
  {
    id: 'agent',
    label: 'Agent',
    desc: 'Default provider, runtime, and scheduled-task gates that drive the agent pipeline.',
    category: 'Agent',
    icon: 'Bot',
    fields: [
      {
        key: 'agent.provider.type',
        label: 'Provider',
        scope: 'grove',
        kind: 'select',
        category: 'Agent',
        icon: 'Bot',
        options: ['anthropic', 'ollama', 'lmstudio', 'openai', 'openrouter', 'openai-compatible'],
        note: 'Default provider for agent tasks. Individual tasks may override.',
        customRender: 'card-owns',
      },
      {
        key: 'agent.provider.model',
        label: 'Model',
        scope: 'grove',
        kind: 'text',
        category: 'Agent',
        icon: 'Bot',
        note: 'Provider-specific model identifier (e.g. claude-opus-4-7, gpt-oss:20b).',
        customRender: 'card-owns',
      },
      {
        key: 'agent.provider.base_url',
        label: 'Base URL',
        scope: 'grove',
        kind: 'text',
        category: 'Agent',
        icon: 'Bot',
        note: 'Override for self-hosted or OpenAI-compatible endpoints.',
        customRender: 'card-owns',
      },
      {
        key: 'agent.provider.context_length',
        label: 'Context length',
        scope: 'grove',
        kind: 'number',
        category: 'Agent',
        icon: 'Bot',
        note: 'Context window size for local models (Ollama num_ctx, LM Studio context_length).',
        customRender: 'card-owns',
      },
      {
        key: 'agent.reasoningLevel',
        label: 'Default reasoning profile',
        scope: 'grove',
        kind: 'select',
        category: 'Agent',
        icon: 'Bot',
        options: ['low', 'default', 'high'],
        note: 'Grove-wide default reasoning tier. Resolves to a model through the reasoning profiles, so it stays portable across model upgrades. Tasks may override per-task.',
        customRender: 'card-owns',
      },
      {
        key: 'agent.model',
        label: 'Default model (advanced)',
        scope: 'grove',
        kind: 'text',
        category: 'Agent',
        icon: 'Bot',
        note: 'Escape hatch — pins a specific model SKU when a reasoning tier has no mapping (e.g. local providers without a reasoning map).',
        customRender: 'card-owns',
      },
      {
        key: 'agent.harness',
        label: 'Runtime',
        scope: 'grove',
        kind: 'text',
        category: 'Agent',
        icon: 'Bot',
        note: 'Runtime id (e.g. claude-sdk, openai-agents). Picked from the installed runtime registry.',
        customRender: 'card-owns',
      },
      {
        key: 'agent.run_retention_days',
        label: 'Agent run retention',
        scope: 'grove',
        kind: 'number',
        category: 'Agent',
        icon: 'Bot',
        min: 1,
        max: 365,
        suffix: 'days',
        note: 'Deletes completed, skipped, and non-resumable failed agent runs older than this window.',
      },
      {
        key: 'agent.semantic_write_check_enabled',
        label: 'Semantic write check',
        scope: 'grove',
        kind: 'toggle',
        category: 'Agent',
        icon: 'Bot',
        note: 'Runs a lightweight semantic classifier against destructive vault writes before they execute, blocking any write that doesn\'t match the calling phase\'s stated purpose. Off by default; verdict quality depends on the classifier model, and the check fails open on classifier error or timeout.',
      },
    ],
  },
  {
    id: 'scheduled-tasks',
    label: 'Scheduled tasks',
    desc: 'Master switches and freshness gates for the agent pipeline\'s scheduled and event-driven tasks.',
    category: 'Scheduled tasks',
    icon: 'Activity',
    fields: [
      {
        key: 'agent.scheduled_tasks_enabled',
        label: 'Scheduled tasks',
        scope: 'grove',
        kind: 'toggle',
        category: 'Scheduled tasks',
        icon: 'Activity',
        note: 'Master switch for all scheduled agent tasks (canopy-describe, intelligence-skill, etc.).',
      },
      {
        key: 'agent.event_tasks_enabled',
        label: 'Event-driven tasks',
        scope: 'grove',
        kind: 'toggle',
        category: 'Scheduled tasks',
        icon: 'Activity',
        note: 'Master switch for tasks fired by capture events (e.g., end-of-session summaries).',
      },
      {
        key: 'agent.scheduled_tasks_active_window_days',
        label: 'Active project window',
        scope: 'grove',
        kind: 'number',
        category: 'Scheduled tasks',
        icon: 'Activity',
        min: 0,
        max: 365,
        suffix: 'days',
        note: 'Only run scheduled tasks against projects touched within this window. 0 disables the gate (all projects always considered active).',
      },
    ],
  },
  {
    id: 'embedding',
    label: 'Embedding',
    desc: 'Vector embedding provider for spores, sessions, and semantic recall.',
    category: 'Embedding',
    icon: 'Brain',
    fields: [
      {
        key: 'embedding.provider',
        label: 'Provider',
        scope: 'grove',
        kind: 'select',
        category: 'Embedding',
        icon: 'Brain',
        options: ['ollama', 'openai-compatible', 'openrouter', 'openai'],
        customRender: 'card-owns',
      },
      {
        key: 'embedding.model',
        label: 'Model',
        scope: 'grove',
        kind: 'text',
        category: 'Embedding',
        icon: 'Brain',
        note: 'Default is bge-m3. Must match the provider\'s embedding-model id.',
        customRender: 'card-owns',
      },
      {
        key: 'embedding.base_url',
        label: 'Base URL',
        scope: 'grove',
        kind: 'text',
        category: 'Embedding',
        icon: 'Brain',
        note: 'Override for self-hosted or OpenAI-compatible endpoints.',
        customRender: 'card-owns',
      },
      {
        key: 'embedding.run_in_deep_sleep',
        label: 'Keep embedding while deep-sleeping',
        scope: 'grove',
        kind: 'toggle',
        category: 'Embedding',
        icon: 'Brain',
        note: 'Keep draining the embedding queue when the daemon would otherwise enter deep sleep. Recommended when the backlog is large.',
        customRender: 'card-owns',
      },
    ],
  },
  {
    id: 'capture',
    label: 'Capture',
    desc: 'Where Myco picks up transcripts, plans, and other artifacts.',
    category: 'Capture',
    icon: 'MessageSquare',
    fields: [
      {
        key: 'capture.transcript_paths',
        label: 'Transcript paths',
        scope: 'machine',
        kind: 'list',
        category: 'Capture',
        icon: 'MessageSquare',
        note: 'Additional directories scanned for agent transcripts. Empty uses the agent symbionts\' defaults.',
      },
      {
        key: 'capture.plan_dirs',
        label: 'Plan directories',
        scope: 'machine',
        kind: 'list',
        category: 'Capture',
        icon: 'MessageSquare',
        note: 'Directories Myco watches for agent-authored plans.',
        customRender: 'card-owns',
      },
      {
        key: 'capture.ignore_plan_dirs_in_git',
        label: 'Add plan dirs to .gitignore',
        scope: 'machine',
        kind: 'toggle',
        category: 'Capture',
        icon: 'MessageSquare',
        note: 'When on, Myco maintains a managed block in .gitignore covering the configured plan directories.',
        customRender: 'card-owns',
      },
      {
        key: 'capture.artifact_extensions',
        label: 'Artifact extensions',
        scope: 'machine',
        kind: 'list',
        category: 'Capture',
        icon: 'MessageSquare',
        note: 'File extensions captured as artifacts (e.g. .md, .py).',
      },
      {
        key: 'capture.buffer_max_events',
        label: 'Event buffer size',
        scope: 'machine',
        kind: 'number',
        category: 'Capture',
        icon: 'MessageSquare',
        min: 100,
        step: 100,
        note: 'In-memory cap on pending capture events before backpressure kicks in.',
      },
    ],
  },
  {
    id: 'release-provenance',
    label: 'Release Provenance',
    desc: 'How Myco classifies session work against shipped, integrated, and unreleased refs.',
    category: 'Release Provenance',
    icon: 'GitBranch',
    fields: [
      {
        key: 'release_provenance.enabled',
        label: 'Enable release provenance',
        scope: 'project',
        kind: 'toggle',
        category: 'Release Provenance',
        icon: 'GitBranch',
        customRender: 'card-owns',
      },
      {
        key: 'release_provenance.production_refs',
        label: 'Production refs',
        scope: 'project',
        kind: 'list',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Refs that represent shipped code (e.g. tags v*, refs/tags/release-*). Empty keeps state unreconciled rather than guessing.',
        customRender: 'card-owns',
      },
      {
        key: 'release_provenance.integration_refs',
        label: 'Integration refs',
        scope: 'project',
        kind: 'list',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Refs that represent merged-but-not-yet-shipped code (e.g. main, develop).',
        customRender: 'card-owns',
      },
      {
        key: 'release_provenance.github.repo',
        label: 'GitHub repo',
        scope: 'project',
        kind: 'text',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'owner/name. Empty disables PR-evidence lookup.',
        customRender: 'card-owns',
      },
      {
        key: 'release_provenance.github.token_env',
        label: 'GitHub token env var',
        scope: 'project',
        kind: 'text',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Name of the environment variable holding the GitHub token. Token values must never be stored in config.',
        customRender: 'card-owns',
      },
      {
        key: 'release_provenance.github.max_lookups_per_run',
        label: 'Max PR lookups per run',
        scope: 'project',
        kind: 'number',
        category: 'Release Provenance',
        icon: 'GitBranch',
        min: 0,
        max: 200,
        note: 'Caps per-reconcile GitHub API calls so a noisy backlog can\'t drain the rate limit.',
        customRender: 'card-owns',
      },
      {
        key: 'release_provenance.reconcile_interval_minutes',
        label: 'Reconcile interval (minutes)',
        scope: 'grove',
        kind: 'number',
        category: 'Release Provenance',
        icon: 'GitBranch',
        min: 1,
        max: 1440,
        note: 'How often the PowerManager-driven reconciler refreshes provenance state.',
        customRender: 'card-owns',
      },
      {
        key: 'release_provenance.production_debug_include_unknown',
        label: 'Include unknown clues in production-debug',
        scope: 'project',
        kind: 'toggle',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Lets production-debug retrieval surface unclassified clues alongside released hits.',
        customRender: 'card-owns',
      },
      {
        key: 'release_provenance.package_map',
        label: 'Package map',
        scope: 'project',
        kind: 'list',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Monorepo path-glob → tag-pattern entries. Records outside any mapping fall back to the umbrella refs.',
        customRender: 'card-owns',
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    desc: 'What Myco surfaces in the daemon UI and which channels it uses.',
    category: 'Notifications',
    icon: 'Bell',
    fields: [
      {
        key: 'notifications.enabled',
        label: 'Enable notifications',
        scope: 'machine',
        kind: 'toggle',
        category: 'Notifications',
        icon: 'Bell',
        note: 'Master switch — disables every notification channel when off.',
        customRender: 'card-owns',
      },
      {
        key: 'notifications.default_mode',
        label: 'Default mode',
        scope: 'machine',
        kind: 'select',
        category: 'Notifications',
        icon: 'Bell',
        options: ['banner', 'summary'],
        note: 'How new notification types display until you customize them per-domain.',
        customRender: 'card-owns',
      },
      {
        key: 'notifications.system_notifications',
        label: 'Browser system notifications',
        scope: 'machine',
        kind: 'toggle',
        category: 'Notifications',
        icon: 'Bell',
        note: 'Pipe banner-mode notifications through the browser Notification API.',
        customRender: 'card-owns',
      },
      {
        key: 'notifications.retention_days',
        label: 'Notification retention (days)',
        scope: 'machine',
        kind: 'number',
        category: 'Notifications',
        icon: 'Bell',
        min: 0,
        max: 365,
        suffix: 'days',
        note: 'Deletes read and cleared notifications older than this window. Unread notifications are preserved.',
        customRender: 'card-owns',
      },
    ],
  },
  {
    id: 'skills',
    label: 'Skills',
    desc: 'Thresholds the skill-lifecycle pipeline uses to surface, promote, and retire skills.',
    category: 'Skills',
    icon: 'Sparkles',
    fields: [
      {
        key: 'skills.confidence_threshold',
        label: 'Auto-promote confidence',
        scope: 'grove',
        kind: 'number',
        category: 'Skills',
        icon: 'Sparkles',
        min: 0,
        max: 1,
        step: 0.05,
        note: 'Survey candidates above this score auto-promote without a manual approve.',
      },
      {
        key: 'skills.usage_stale_days',
        label: 'Stale-skill window (days)',
        scope: 'grove',
        kind: 'number',
        category: 'Skills',
        icon: 'Sparkles',
        min: 0,
        suffix: 'days',
        note: 'Skills with no usage in this many days get flagged for review.',
      },
    ],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    desc: 'Background database hygiene jobs the daemon runs against this Grove.',
    category: 'Maintenance',
    icon: 'Wrench',
    fields: [
      {
        key: 'maintenance.auto_optimize',
        label: 'Auto-run PRAGMA optimize',
        scope: 'grove',
        kind: 'toggle',
        category: 'Maintenance',
        icon: 'Wrench',
      },
      {
        key: 'maintenance.auto_optimize_interval_hours',
        label: 'Optimize interval (hours)',
        scope: 'grove',
        kind: 'number',
        category: 'Maintenance',
        icon: 'Wrench',
        min: 1,
        max: 720,
        suffix: 'hours',
        dependsOn: { key: 'maintenance.auto_optimize', value: true },
      },
      {
        key: 'maintenance.auto_integrity_check',
        label: 'Auto-run integrity check',
        scope: 'grove',
        kind: 'toggle',
        category: 'Maintenance',
        icon: 'Wrench',
        note: 'Runs integrity + foreign-key checks on a slow cadence; failures surface in the Database panel.',
      },
      {
        key: 'maintenance.auto_integrity_check_interval_hours',
        label: 'Integrity-check interval (hours)',
        scope: 'grove',
        kind: 'number',
        category: 'Maintenance',
        icon: 'Wrench',
        min: 1,
        max: 8760,
        suffix: 'hours',
        dependsOn: { key: 'maintenance.auto_integrity_check', value: true },
        note: 'Default is 168 hours (weekly).',
      },
    ],
  },
  {
    id: 'backup',
    label: 'Backup',
    desc: 'Where Grove backups land and how many are kept.',
    category: 'Backup',
    icon: 'Save',
    fields: [
      {
        key: 'backup.dir',
        label: 'Backup directory',
        scope: 'grove',
        kind: 'text',
        category: 'Backup',
        icon: 'Save',
        nullableEmpty: true,
        note: 'Override for the backup root. Supports ~. Defaults to <groveHome>/backups when empty.',
      },
      {
        key: 'backup.auto_interval_hours',
        label: 'Auto-backup interval (hours)',
        scope: 'grove',
        kind: 'number',
        category: 'Backup',
        icon: 'Save',
        min: 1,
        max: 720,
        suffix: 'hours',
        note: 'Minimum hours between auto-backups. Default is 24 (one per day per machine).',
      },
      {
        key: 'backup.retention.keep_daily',
        label: 'Daily backups to keep',
        scope: 'grove',
        kind: 'number',
        category: 'Backup',
        icon: 'Save',
        min: 1,
        max: 365,
        suffix: 'days',
      },
      {
        key: 'backup.retention.keep_weekly',
        label: 'Weekly backups to keep',
        scope: 'grove',
        kind: 'number',
        category: 'Backup',
        icon: 'Save',
        min: 0,
        max: 52,
        suffix: 'weeks',
        note: 'Kept beyond the daily window for longer-term restore points.',
      },
    ],
  },
  {
    id: 'sessions',
    label: 'Sessions',
    desc: 'Session lifecycle thresholds the daemon uses for staleness detection.',
    category: 'Sessions',
    icon: 'Activity',
    fields: [
      {
        key: 'daemon.stale_session_threshold_ms',
        label: 'Stale-session threshold (ms)',
        scope: 'grove',
        kind: 'number',
        category: 'Sessions',
        icon: 'Activity',
        min: 1,
        max: 10080,
        unit: { displayUnit: 'minutes', factor: 60000 },
        note: 'How long an idle session waits before it\'s auto-completed (display in minutes; daemon stores milliseconds).',
      },
    ],
  },
  {
    id: 'logging',
    label: 'Logging',
    desc: 'Daemon-process log verbosity and retention.',
    category: 'Logging',
    icon: 'ScrollText',
    fields: [
      {
        key: 'daemon.log_level',
        label: 'Log level',
        scope: 'machine',
        kind: 'select',
        category: 'Logging',
        icon: 'ScrollText',
        options: ['debug', 'info', 'warn', 'error'],
      },
      {
        key: 'daemon.log_retention_days',
        label: 'Log retention (days)',
        scope: 'machine',
        kind: 'number',
        category: 'Logging',
        icon: 'ScrollText',
        min: 1,
        max: 365,
        suffix: 'days',
        note: 'Window for log_entries rows. One daemon, one retention policy across every Grove it serves.',
      },
    ],
  },
  {
    id: 'upgrade',
    label: 'Upgrade',
    desc: 'Which release stream the daemon pulls upgrades from.',
    category: 'Upgrade',
    icon: 'RotateCcw',
    fields: [
      {
        key: 'daemon.update_channel',
        label: 'Upgrade channel',
        scope: 'machine',
        kind: 'select',
        category: 'Upgrade',
        icon: 'RotateCcw',
        options: ['stable', 'beta'],
        note: 'Use beta for dogfood/preview builds. Machine-wide — one channel per machine.',
        customRender: 'card-owns',
      },
    ],
  },
];
