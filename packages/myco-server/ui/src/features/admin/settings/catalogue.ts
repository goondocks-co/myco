/**
 * Every Deployment setting the dashboard edits, grouped for the page and placed
 * in one of the five sections of Settings.
 *
 * The server stores any JSON under a leaf; the shape a person can enter comes
 * from here. A gate holds the editable fields equal to the server's admitted leaves, so a leaf
 * added on one side without the other fails by name.
 */
import type { SettingsSectionId } from '../../../routes/nav';
import { PROFILE_HARNESSES, REASONING_TIERS } from '@goondocks/myco-shared/execution-profile';

/**
 * How a setting is edited. `agent` is one of the agents a machine can run
 * Myco's work with; `agents` is an ordered list of them.
 */
export type LeafKind = 'toggle' | 'number' | 'text' | 'textarea' | 'select' | 'json' | 'patterns' | 'agent' | 'agents';

export interface LeafField {
  leaf: string;
  label: string;
  kind: LeafKind;
  options?: readonly (string | number)[];
  optionLabels?: Readonly<Record<string, string>>;
  min?: number;
  max?: number;
  /**
   * Characters a `textarea` accepts. The browser counts UTF-16 units and the
   * leaf's rule counts UTF-8 bytes, so text outside the Basic Multilingual
   * Plane reaches the server over its byte ceiling and is refused there. The
   * field is a courtesy; the write is the gate.
   */
  maxLength?: number;
  step?: number;
  unit?: string;
  note?: string;
  /** Shown, never edited. */
  readOnly?: boolean;
  /** A configured value can be cleared to restore the server's built-in value. */
  resettable?: boolean;
}

export interface LeafGroup {
  /** The group's anchor on its section, and the `?tab=` an older link to it carries. */
  id: string;
  /** The section of Settings the group sits in. */
  section: SettingsSectionId;
  label: string;
  note: string;
  leaves: readonly LeafField[];
}

const SIGN_IN_OPTIONS = { deployment: 'Server login', 'worker-login': 'Worker login' } as const;

const profileFields = (harness: string): LeafField[] => [
  ...REASONING_TIERS.flatMap((tier) => [
    { leaf: `agent.reasoning_map.${harness}.${tier}`, label: `${tier} tier model`, kind: 'text' as const, resettable: true,
      note: PROFILE_HARNESSES[harness]!.modelHint },
    { leaf: `agent.effort_map.${harness}.${tier}`, label: `${tier} tier effort`, kind: 'select' as const,
      options: PROFILE_HARNESSES[harness]!.allowedEfforts, resettable: true },
  ]),
  { leaf: `agent.harnesses.${harness}.credential`, label: 'Sign in with', kind: 'select',
    options: Object.keys(SIGN_IN_OPTIONS), optionLabels: SIGN_IN_OPTIONS, resettable: true,
    note: 'Choose whose login the worker uses for Myco’s tasks.' },
];

export const LEAF_GROUPS: readonly LeafGroup[] = [
  {
    id: 'scheduling',
    section: 'work',
    label: 'When Myco works',
    note: 'When Myco learns, titles and maps on its own, without being asked.',
    leaves: [
      { leaf: 'agent.scheduled_tasks_enabled', label: 'Work on a schedule', kind: 'toggle' },
      { leaf: 'agent.scheduled_tasks_active_window_days', label: 'Treat a project as active for', kind: 'number', min: 0, max: 365, unit: 'days' },
      { leaf: 'agent.cold_project_threshold_days', label: 'Treat a project as quiet after', kind: 'number', min: 0, max: 365, unit: 'days' },
      { leaf: 'release_provenance.reconcile_interval_minutes', label: 'Check what has shipped every', kind: 'number', min: 1, max: 1440, unit: 'minutes', note: 'How often each project with release tracking on is checked against its release tags.' },
    ],
  },
  {
    id: 'limits',
    section: 'work',
    label: 'How much at once',
    note: 'How much of Myco’s work runs at once. Work past a limit waits its turn; nothing is refused. Unset means no limit.',
    leaves: [
      { leaf: 'agent.limits.concurrent_runs', label: 'Tasks at once', kind: 'number', min: 1 },
      { leaf: 'agent.limits.task_concurrent_runs', label: 'Runs of one task at once', kind: 'number', min: 1 },
      { leaf: 'agent.limits.task_runs_per_hour', label: 'Runs of one task per hour', kind: 'number', min: 1 },
    ],
  },
  {
    id: 'workers',
    section: 'work',
    label: 'Which agent does the work',
    note: 'The coding agent a machine uses when it runs Myco’s work. A machine offers the agents it is signed in to; this names which to prefer. Health shows what each machine last reported.',
    leaves: [
      { leaf: 'worker.harness', label: 'Preferred agent', kind: 'agent', note: 'The agent a machine tries first, when it is signed in to it.' },
      { leaf: 'worker.harness_fallback', label: 'Then try, in order', kind: 'agents', note: 'The agents a machine tries next, top first.' },
    ],
  },
  {
    id: 'cortex',
    section: 'work',
    label: 'What sessions receive',
    note: 'What each session is handed at start, and what each prompt is served.',
    leaves: [
      { leaf: 'instructions.template', label: 'Session-start instructions', kind: 'textarea', maxLength: 4096, note: 'Markdown every session is handed at start, beside its project. Up to 4 KB; anything longer is refused when you save.' },
      { leaf: 'cortex.instructions.inject_on_session_start', label: 'Instructions at session start', kind: 'toggle' },
      { leaf: 'cortex.instructions.inject_on_subagent_start', label: 'Instructions when a subagent starts', kind: 'toggle' },
      { leaf: 'cortex.spores.inject_on_prompt_submit', label: 'Spores on every prompt', kind: 'toggle' },
      { leaf: 'cortex.spores.max_per_prompt', label: 'Items per prompt', kind: 'number', min: 0, max: 10, note: 'Spores and plans share this count; the 300-token budget may serve fewer.' },
      { leaf: 'cortex.plans.inject_intent_nudge_on_prompt_submit', label: 'Plan nudge on every prompt', kind: 'toggle' },
    ],
  },
  {
    id: 'code-map',
    section: 'work',
    label: 'Code map',
    note: 'How Myco keeps its map of each project’s code.',
    leaves: [
      { leaf: 'cortex.canopy.refresh.background_enabled', label: 'Update the map on its own', kind: 'toggle', note: 'Needs work on a schedule and the project’s Code map switch in its project settings. Task limits also apply.' },
      { leaf: 'cortex.canopy.refresh.background_period_minutes', label: 'Update every', kind: 'number', min: 1, unit: 'minutes' },
      { leaf: 'cortex.canopy.exclude.patterns', label: 'Paths left out', kind: 'patterns', note: 'Paths the map leaves out, beside the built-in ones. The map reads committed files only, so ignored files never reach it.' },
      { leaf: 'cortex.canopy.exclude.default_patterns', label: 'Paths always left out', kind: 'patterns', readOnly: true, note: 'Derived from Myco’s built-in code map patterns. Add your own above.' },
    ],
  },
  {
    id: 'claude-profile',
    section: 'models',
    label: 'Claude Code tiers',
    note: 'The model and effort requested for each tier when Claude Code runs Myco’s work. A task may override its tier under Per-task overrides.',
    leaves: profileFields('claude-code'),
  },
  {
    id: 'codex-profile',
    section: 'models',
    label: 'Codex tiers',
    note: 'Set a model for each tier a Codex worker may run. An unset model waits for configuration.',
    leaves: profileFields('codex'),
  },
  {
    id: 'opencode-profile',
    section: 'models',
    label: 'OpenCode tiers',
    note: 'Set a provider/model for every tier OpenCode may run. A tier without a model waits for configuration.',
    leaves: profileFields('opencode'),
  },
  {
    id: 'embedding',
    section: 'models',
    label: 'Search embeddings',
    note: 'What makes search find things by meaning. On Cloudflare this is Workers AI with bge-m3; the provider, model and endpoint apply to a self-hosted server. Keeping embeddings while idle applies to both.',
    leaves: [
      { leaf: 'embedding.provider', label: 'Embedding provider', kind: 'select', options: ['ollama', 'openai-compatible', 'openrouter', 'openai'] },
      { leaf: 'embedding.model', label: 'Embedding model', kind: 'text' },
      { leaf: 'embedding.base_url', label: 'Embedding endpoint', kind: 'text', note: 'Where embeddings are computed.' },
      { leaf: 'embedding.prevent_deep_sleep', label: 'Keep embedding while idle', kind: 'toggle' },
    ],
  },
  {
    id: 'advanced',
    section: 'models',
    label: 'Per-task overrides',
    note: 'Overrides for each task, as one document.',
    leaves: [
      { leaf: 'agent.tasks', label: 'Task overrides', kind: 'json', note: 'A JSON object keyed by task name. A model pin requires an agent in the same task override. “Title imported sessions” under Myco’s work writes its switch here.' },
    ],
  },
  {
    id: 'new-repositories',
    section: 'capture',
    label: 'New repositories',
    note: 'What happens when someone works in a repository no project holds yet, inside the folders their machine captures.',
    leaves: [
      { leaf: 'capture.auto_create_projects', label: 'Create a project for it', kind: 'toggle', note: 'Off means the repository waits in Needs you until an admin connects it. A repository whose remote a project already holds joins that project either way.' },
    ],
  },
  {
    id: 'import',
    section: 'capture',
    label: 'Importing past sessions',
    note: 'What a machine brings with it when someone joins. Their agents have kept transcripts all along; this is how much of that history arrives.',
    leaves: [
      { leaf: 'import.enabled', label: 'Import past sessions on join', kind: 'toggle', note: 'Off means a machine brings nothing, and `myco import` is refused.' },
      { leaf: 'import.window_days', label: 'Reach back at most', kind: 'number', min: 1, max: 3650, unit: 'days', note: 'Most agents keep transcripts for about a month, so reaching further back finds more only on machines whose history survived longer.' },
      { leaf: 'import.max_sessions_per_harness', label: 'At most, per agent', kind: 'number', min: 1, max: 1000, unit: 'sessions' },
    ],
  },
  {
    id: 'records',
    section: 'capture',
    label: 'What Myco keeps',
    note: 'How long this server keeps raw transcripts and its own records.',
    leaves: [
      // 0 keeps transcripts forever. A setting cannot be cleared once written, so
      // 0 is how a server returns to keeping everything, and the minimum stays 0.
      { leaf: 'retention.transcripts', label: 'Keep raw transcripts for', kind: 'number', min: 0, max: 3650, unit: 'days', note: 'Removes raw transcript bytes already read into sessions once they are older than this. Bytes not yet read are kept whatever their age, and sessions, prompts, replies, tool calls and plans are never removed. Unset or 0 keeps raw transcripts forever. Capture is never refused for the space it takes.' },
      { leaf: 'agent.run_retention_days', label: 'Keep task records for', kind: 'number', min: 1, max: 365, unit: 'days', note: 'How long the record of each task Myco ran is kept.' },
    ],
  },
  {
    id: 'backup',
    section: 'backups',
    label: 'Backups',
    note: 'How often this server backs itself up and what it keeps.',
    leaves: [
      { leaf: 'backup.auto_interval_hours', label: 'Back up every', kind: 'number', min: 1, max: 720, unit: 'hours', note: 'A self-hosted server writes a verified recovery copy on this interval; a Cloudflare one stages a copy an operator then turns into one.' },
      { leaf: 'backup.recovery.keep_stagings', label: 'Full recovery copies to keep', kind: 'number', min: 1, max: 30, note: 'Complete copies kept, newest first; older ones are released, and so are failed ones past the newest. Unset keeps 2.' },
      { leaf: 'backup.retention.keep_daily', label: 'Newest manual relational exports to keep (daily)', kind: 'number', min: 1, max: 365, note: 'Keeps the newest export copies, rather than one per day. Pruned when a manual export is created.' },
      { leaf: 'backup.retention.keep_weekly', label: 'Recent export weeks to keep', kind: 'number', min: 0, max: 52, note: 'Keeps the newest export from each of the N most recent weeks that contain exports. Empty weeks consume no slot. Pruned when a manual export is created.' },
    ],
  },
  {
    id: 'maintenance',
    section: 'backups',
    label: 'Store checks',
    note: 'Routine checks on the database. Nothing runs until a check is turned on with an interval; one turned on runs at the next wake and then on its interval. What each check last found is on Health.',
    leaves: [
      { leaf: 'maintenance.auto_optimize', label: 'Optimize automatically', kind: 'toggle' },
      { leaf: 'maintenance.auto_optimize_interval_hours', label: 'Optimize every', kind: 'number', min: 1, max: 720, unit: 'hours' },
      { leaf: 'maintenance.auto_integrity_check', label: 'Check integrity automatically', kind: 'toggle' },
      { leaf: 'maintenance.auto_integrity_check_interval_hours', label: 'Check integrity every', kind: 'number', min: 1, max: 8760, unit: 'hours' },
    ],
  },
];

export const LEAF_FIELDS: readonly LeafField[] = LEAF_GROUPS.flatMap((g) => g.leaves);

/** The groups of one section, in page order. */
export const groupsOf = (section: SettingsSectionId): readonly LeafGroup[] => LEAF_GROUPS.filter((g) => g.section === section);
