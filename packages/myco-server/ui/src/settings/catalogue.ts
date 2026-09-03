/**
 * Every Deployment setting the dashboard edits, grouped for the page.
 *
 * The server stores any JSON under a leaf; the shape a person can enter comes
 * from here. A gate holds this list equal to the server's leaf list, so a leaf
 * added on one side without the other fails by name.
 */
export type LeafKind = 'toggle' | 'number' | 'text' | 'select' | 'json';

export interface LeafField {
  leaf: string;
  label: string;
  kind: LeafKind;
  options?: readonly (string | number)[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  note?: string;
  /** Shown, never edited. */
  readOnly?: boolean;
}

export interface LeafGroup {
  id: string;
  label: string;
  note: string;
  leaves: readonly LeafField[];
}

const PROVIDERS = ['anthropic', 'ollama', 'lmstudio', 'openai', 'openrouter', 'openai-compatible'] as const;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const VERBOSITY = ['low', 'medium', 'high'] as const;

const tierMaps = (): LeafField[] =>
  ['default', 'high', 'low'].flatMap((tier) => [
    { leaf: `agent.provider.reasoning_map.${tier}`, label: `Model at the ${tier} tier`, kind: 'text' as const, note: 'The model this provider resolves the tier to.' },
    { leaf: `agent.provider.effort_map.${tier}.effort`, label: `Effort at the ${tier} tier`, kind: 'select' as const, options: EFFORTS },
    { leaf: `agent.provider.effort_map.${tier}.verbosity`, label: `Verbosity at the ${tier} tier`, kind: 'select' as const, options: VERBOSITY },
    { leaf: `agent.provider.thinking_budget_map.${tier}`, label: `Thinking budget at the ${tier} tier`, kind: 'json' as const, note: '{"budgetTokens": 8192} or {"adaptive": true}.' },
  ]);

export const LEAF_GROUPS: readonly LeafGroup[] = [
  {
    id: 'agent',
    label: 'Agent',
    note: 'The provider and model that generate this server\'s intelligence.',
    leaves: [
      { leaf: 'agent.provider.type', label: 'Provider', kind: 'select', options: PROVIDERS, note: 'Which service generates this server\'s intelligence; its credential lives under Credentials.' },
      { leaf: 'agent.provider.model', label: 'Model', kind: 'text', note: 'The provider\'s model identifier.' },
      { leaf: 'agent.provider.base_url', label: 'Provider endpoint', kind: 'text', note: 'For self-hosted or compatible endpoints. The server sends no stored credential to a custom endpoint.' },
      { leaf: 'agent.provider.context_length', label: 'Context length', kind: 'number', min: 1, unit: 'tokens' },
      { leaf: 'agent.provider.local_backend', label: 'Local backend', kind: 'select', options: ['ollama', 'lmstudio'] },
      { leaf: 'agent.reasoningLevel', label: 'Reasoning profile', kind: 'select', options: ['low', 'default', 'high'] },
      { leaf: 'agent.model', label: 'Default model (advanced)', kind: 'text' },
      { leaf: 'agent.harness', label: 'Runtime', kind: 'text', note: 'claude-sdk or openai-agents.' },
      { leaf: 'agent.run_retention_days', label: 'Keep run records for', kind: 'number', min: 1, max: 365, unit: 'days' },
      { leaf: 'agent.semantic_write_check_enabled', label: 'Check writes before they land', kind: 'toggle' },
    ],
  },
  {
    id: 'scheduling',
    label: 'Scheduling',
    note: 'When this server runs intelligence on its own.',
    leaves: [
      { leaf: 'agent.scheduled_tasks_enabled', label: 'Run scheduled tasks', kind: 'toggle' },
      { leaf: 'agent.event_tasks_enabled', label: 'Run tasks on capture', kind: 'toggle' },
      { leaf: 'agent.scheduled_tasks_active_window_days', label: 'Treat a project as active for', kind: 'number', min: 0, max: 365, unit: 'days' },
      { leaf: 'agent.cold_project_threshold_days', label: 'Treat a project as cold after', kind: 'number', min: 0, max: 365, unit: 'days' },
      { leaf: 'agent.summary_batch_interval', label: 'Summary batch interval', kind: 'number', min: 0 },
    ],
  },
  {
    id: 'limits',
    label: 'Limits',
    note: 'How much intelligence runs at once. A run past a limit waits its turn; nothing is refused. Unset means no limit.',
    leaves: [
      { leaf: 'agent.limits.concurrent_runs', label: 'Runs at once', kind: 'number', min: 1 },
      { leaf: 'agent.limits.task_concurrent_runs', label: 'Runs of one task at once', kind: 'number', min: 1 },
      { leaf: 'agent.limits.task_runs_per_hour', label: 'Runs of one task per hour', kind: 'number', min: 1 },
      { leaf: 'agent.limits.fleet', label: 'Fleet size', kind: 'number', min: 1, note: 'How many runtimes this server can start at once; the operator sets it when the server is deployed.' },
    ],
  },
  {
    id: 'cortex',
    label: 'Cortex',
    note: 'What each session receives at start and on every prompt.',
    leaves: [
      { leaf: 'cortex.instructions.inject_on_session_start', label: 'Instructions at session start', kind: 'toggle' },
      { leaf: 'cortex.instructions.inject_on_subagent_start', label: 'Instructions when a subagent starts', kind: 'toggle' },
      { leaf: 'cortex.digest.inject_on_session_start', label: 'Digest at session start', kind: 'toggle' },
      { leaf: 'cortex.digest.tier', label: 'Digest size', kind: 'select', options: [1500, 5000, 10000], unit: 'tokens' },
      { leaf: 'cortex.spores.inject_on_prompt_submit', label: 'Spores on every prompt', kind: 'toggle' },
      { leaf: 'cortex.spores.max_per_prompt', label: 'Spores per prompt', kind: 'number', min: 0, max: 10 },
      { leaf: 'cortex.plans.inject_intent_nudge_on_prompt_submit', label: 'Plan nudge on every prompt', kind: 'toggle' },
    ],
  },
  {
    id: 'code-map',
    label: 'Code map',
    note: 'How this server keeps its map of each project\'s code.',
    leaves: [
      { leaf: 'cortex.canopy.refresh.background_enabled', label: 'Refresh in the background', kind: 'toggle' },
      { leaf: 'cortex.canopy.refresh.background_period_minutes', label: 'Refresh every', kind: 'number', min: 1, unit: 'minutes' },
      { leaf: 'cortex.canopy.exclude.patterns', label: 'Exclude patterns', kind: 'json', note: 'A JSON list of glob patterns.' },
      { leaf: 'cortex.canopy.exclude.default_patterns', label: 'Built-in exclude patterns', kind: 'json', readOnly: true, note: 'Shown for reference; add your own above.' },
      { leaf: 'cortex.canopy.min_file_bytes', label: 'Smallest file to map', kind: 'number', min: 0, unit: 'bytes' },
    ],
  },
  {
    id: 'embedding',
    label: 'Embedding',
    note: 'The provider and model that embed memory for search.',
    leaves: [
      { leaf: 'embedding.provider', label: 'Provider', kind: 'select', options: ['ollama', 'openai-compatible', 'openrouter', 'openai'] },
      { leaf: 'embedding.model', label: 'Model', kind: 'text' },
      { leaf: 'embedding.base_url', label: 'Embedding endpoint', kind: 'text', note: 'Where embeddings are computed.' },
      { leaf: 'embedding.prevent_deep_sleep', label: 'Keep embedding while idle', kind: 'toggle' },
    ],
  },
  {
    id: 'skills',
    label: 'Skills',
    note: 'When a discovered skill is promoted, and when an unused one goes stale.',
    leaves: [
      { leaf: 'skills.confidence_threshold', label: 'Promote at confidence', kind: 'number', min: 0, max: 1, step: 0.05 },
      { leaf: 'skills.usage_stale_days', label: 'Stale after', kind: 'number', min: 1, unit: 'days' },
    ],
  },
  {
    id: 'backup',
    label: 'Backup',
    note: 'How often this server backs itself up and what it keeps.',
    leaves: [
      { leaf: 'backup.auto_interval_hours', label: 'Back up every', kind: 'number', min: 1, max: 720, unit: 'hours' },
      { leaf: 'backup.retention.keep_daily', label: 'Daily backups to keep', kind: 'number', min: 1, max: 365 },
      { leaf: 'backup.retention.keep_weekly', label: 'Weekly backups to keep', kind: 'number', min: 0, max: 52 },
    ],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    note: 'Routine checks on the store.',
    leaves: [
      { leaf: 'maintenance.auto_optimize', label: 'Optimize automatically', kind: 'toggle' },
      { leaf: 'maintenance.auto_optimize_interval_hours', label: 'Optimize every', kind: 'number', min: 1, max: 720, unit: 'hours' },
      { leaf: 'maintenance.auto_integrity_check', label: 'Check integrity automatically', kind: 'toggle' },
      { leaf: 'maintenance.auto_integrity_check_interval_hours', label: 'Check integrity every', kind: 'number', min: 1, max: 8760, unit: 'hours' },
    ],
  },
  {
    id: 'records',
    label: 'Records',
    note: 'How long this server keeps what it records about itself.',
    leaves: [
      { leaf: 'notifications.retention_days', label: 'Keep notifications for', kind: 'number', min: 0, max: 365, unit: 'days' },
      { leaf: 'release_provenance.reconcile_interval_minutes', label: 'Reconcile release state every', kind: 'number', min: 1, max: 1440, unit: 'minutes' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    note: 'Per-tier provider settings and per-task overrides, as documents.',
    leaves: [
      ...tierMaps(),
      { leaf: 'agent.tasks', label: 'Task overrides', kind: 'json', note: 'A JSON object keyed by task name.' },
    ],
  },
];

export const LEAF_FIELDS: readonly LeafField[] = LEAF_GROUPS.flatMap((g) => g.leaves);
