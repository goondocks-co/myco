/**
 * Settings manifest — the canonical, hand-authored layout for the unified
 * `/settings` page. Each `SettingGroup` becomes a card on the page; each
 * `SettingField` becomes a labelled control inside that card. The control
 * components (Task 4) render off this manifest; a sync test (Task 3)
 * enforces that every entry's `key` resolves to a real leaf in the Zod
 * config schemas at `packages/myco/src/config/schema.ts`, so drift between
 * the schema and this file is caught at test time rather than runtime.
 *
 * Out of scope intentionally: `cortex.*` (its own page), `appearance.*`
 * (sidebar control), `symbionts.*` (separate surface), team credentials
 * (`team.worker_url`, `team.team_id`, `team.mcp_token` — owned by the Team
 * page), and internal book-keeping fields (`version`, `config_version`).
 */

export type SettingScope = 'project' | 'grove' | 'machine';
export type SettingKind = 'toggle' | 'select' | 'number' | 'secret' | 'list' | 'text';

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
  /** Min/max for `kind: 'number'`. */
  min?: number;
  max?: number;
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
    desc: 'Default provider, harness, and scheduled-task gates that drive the agent pipeline.',
    category: 'Agent',
    icon: 'Bot',
    fields: [
      {
        key: 'agent.provider.type',
        label: 'Provider',
        scope: 'project',
        kind: 'select',
        category: 'Agent',
        icon: 'Bot',
        options: ['anthropic', 'ollama', 'lmstudio', 'openai', 'openrouter', 'openai-compatible'],
        note: 'Default provider for agent tasks. Individual tasks may override.',
      },
      {
        key: 'agent.provider.model',
        label: 'Model',
        scope: 'project',
        kind: 'text',
        category: 'Agent',
        icon: 'Bot',
        note: 'Provider-specific model identifier (e.g. claude-opus-4-7, gpt-oss:20b).',
      },
      {
        key: 'agent.provider.base_url',
        label: 'Base URL',
        scope: 'project',
        kind: 'text',
        category: 'Agent',
        icon: 'Bot',
        note: 'Override for self-hosted or OpenAI-compatible endpoints.',
      },
      {
        key: 'agent.provider.context_length',
        label: 'Context length',
        scope: 'project',
        kind: 'number',
        category: 'Agent',
        icon: 'Bot',
        note: 'Context window size for local models (Ollama num_ctx, LM Studio context_length).',
      },
      {
        key: 'agent.harness',
        label: 'Harness',
        scope: 'project',
        kind: 'text',
        category: 'Agent',
        icon: 'Bot',
        note: 'Harness id (e.g. claude-code-sdk, codex-cli). Picked from the installed harness registry.',
      },
      {
        key: 'agent.scheduled_tasks_enabled',
        label: 'Run scheduled tasks',
        scope: 'project',
        kind: 'toggle',
        category: 'Agent',
        icon: 'Bot',
        note: 'Master switch for PowerManager-scheduled agent tasks (skill-survey, vault-evolve, etc.).',
      },
      {
        key: 'agent.event_tasks_enabled',
        label: 'Run event-driven tasks',
        scope: 'project',
        kind: 'toggle',
        category: 'Agent',
        icon: 'Bot',
        note: 'Event-triggered tasks like title-summary and Cortex refresh.',
      },
      {
        key: 'agent.scheduled_tasks_active_window_days',
        label: 'Active-window (days)',
        scope: 'grove',
        kind: 'number',
        category: 'Agent',
        icon: 'Bot',
        min: 0,
        max: 365,
        note: 'Skip scheduled tasks against projects untouched within this many days. 0 disables cold-project gating.',
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
        scope: 'project',
        kind: 'select',
        category: 'Embedding',
        icon: 'Brain',
        options: ['ollama', 'openai-compatible', 'openrouter', 'openai'],
      },
      {
        key: 'embedding.model',
        label: 'Model',
        scope: 'project',
        kind: 'text',
        category: 'Embedding',
        icon: 'Brain',
        note: 'Default is bge-m3. Must match the provider\'s embedding-model id.',
      },
      {
        key: 'embedding.base_url',
        label: 'Base URL',
        scope: 'project',
        kind: 'text',
        category: 'Embedding',
        icon: 'Brain',
        note: 'Override for self-hosted or OpenAI-compatible endpoints.',
      },
      {
        key: 'embedding.run_in_deep_sleep',
        label: 'Keep embedding while deep-sleeping',
        scope: 'grove',
        kind: 'toggle',
        category: 'Embedding',
        icon: 'Brain',
        note: 'Keep draining the embedding queue when the daemon would otherwise enter deep sleep. Recommended when the backlog is large.',
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
        scope: 'project',
        kind: 'list',
        category: 'Capture',
        icon: 'MessageSquare',
        note: 'Additional directories scanned for agent transcripts. Empty uses the agent symbionts\' defaults.',
      },
      {
        key: 'capture.plan_dirs',
        label: 'Plan directories',
        scope: 'project',
        kind: 'list',
        category: 'Capture',
        icon: 'MessageSquare',
        note: 'Directories Myco watches for agent-authored plans.',
      },
      {
        key: 'capture.ignore_plan_dirs_in_git',
        label: 'Add plan dirs to .gitignore',
        scope: 'project',
        kind: 'toggle',
        category: 'Capture',
        icon: 'MessageSquare',
        note: 'When on, Myco maintains a managed block in .gitignore covering the configured plan directories.',
      },
      {
        key: 'capture.artifact_extensions',
        label: 'Artifact extensions',
        scope: 'project',
        kind: 'list',
        category: 'Capture',
        icon: 'MessageSquare',
        note: 'File extensions captured as artifacts (e.g. .md, .py).',
      },
      {
        key: 'capture.buffer_max_events',
        label: 'Event buffer size',
        scope: 'project',
        kind: 'number',
        category: 'Capture',
        icon: 'MessageSquare',
        min: 0,
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
      },
      {
        key: 'release_provenance.production_refs',
        label: 'Production refs',
        scope: 'project',
        kind: 'list',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Refs that represent shipped code (e.g. tags v*, refs/tags/release-*). Empty keeps state unreconciled rather than guessing.',
      },
      {
        key: 'release_provenance.integration_refs',
        label: 'Integration refs',
        scope: 'project',
        kind: 'list',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Refs that represent merged-but-not-yet-shipped code (e.g. main, develop).',
      },
      {
        key: 'release_provenance.github.repo',
        label: 'GitHub repo',
        scope: 'project',
        kind: 'text',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'owner/name. Empty disables PR-evidence lookup.',
      },
      {
        key: 'release_provenance.github.token_env',
        label: 'GitHub token env var',
        scope: 'project',
        kind: 'text',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Name of the environment variable holding the GitHub token. Token values must never be stored in config.',
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
      },
      {
        key: 'release_provenance.production_debug_include_unknown',
        label: 'Include unknown clues in production-debug',
        scope: 'project',
        kind: 'toggle',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Lets production-debug retrieval surface unclassified clues alongside released hits.',
      },
      {
        key: 'release_provenance.package_map',
        label: 'Package map',
        scope: 'project',
        kind: 'list',
        category: 'Release Provenance',
        icon: 'GitBranch',
        note: 'Monorepo path-glob → tag-pattern entries. Records outside any mapping fall back to the umbrella refs.',
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
        scope: 'project',
        kind: 'toggle',
        category: 'Notifications',
        icon: 'Bell',
        note: 'Master switch — disables every notification channel when off.',
      },
      {
        key: 'notifications.default_mode',
        label: 'Default mode',
        scope: 'project',
        kind: 'select',
        category: 'Notifications',
        icon: 'Bell',
        options: ['banner', 'summary'],
        note: 'How new notification types display until you customize them per-domain.',
      },
      {
        key: 'notifications.system_notifications',
        label: 'Browser system notifications',
        scope: 'project',
        kind: 'toggle',
        category: 'Notifications',
        icon: 'Bell',
        note: 'Pipe banner-mode notifications through the browser Notification API.',
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
        scope: 'project',
        kind: 'number',
        category: 'Skills',
        icon: 'Sparkles',
        min: 0,
        max: 1,
        note: 'Survey candidates above this score auto-promote without a manual approve.',
      },
      {
        key: 'skills.usage_stale_days',
        label: 'Stale-skill window (days)',
        scope: 'project',
        kind: 'number',
        category: 'Skills',
        icon: 'Sparkles',
        min: 0,
        note: 'Skills with no usage in this many days get flagged for review.',
      },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    desc: 'Team-sync operational cadence. Credentials live on the Team page.',
    category: 'Team',
    icon: 'Users',
    fields: [
      {
        key: 'team.enabled',
        label: 'Enable team sync',
        scope: 'grove',
        kind: 'toggle',
        category: 'Team',
        icon: 'Users',
        note: 'Turn the sync loop on or off without clearing the configured worker.',
      },
      {
        key: 'team.interval_minutes',
        label: 'Sync interval (minutes)',
        scope: 'grove',
        kind: 'number',
        category: 'Team',
        icon: 'Users',
        min: 1,
        max: 1440,
        note: 'How often the daemon attempts an outbox drain + inbox pull.',
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
        min: 60000,
        note: 'How long an idle session waits before it\'s auto-completed (milliseconds). Default is 3,600,000 (one hour). Intelligence tasks only run against settled sessions, so this directly controls how fresh their inputs are.',
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
        note: 'Window for log_entries rows. One daemon, one retention policy across every Grove it serves.',
      },
    ],
  },
  {
    id: 'update',
    label: 'Update',
    desc: 'Which release stream the daemon pulls updates from.',
    category: 'Update',
    icon: 'RotateCcw',
    fields: [
      {
        key: 'daemon.update_channel',
        label: 'Update channel',
        scope: 'machine',
        kind: 'select',
        category: 'Update',
        icon: 'RotateCcw',
        options: ['stable', 'beta'],
        note: 'Use beta for dogfood/preview builds. Project local.yaml can override per-project.',
      },
    ],
  },
];
