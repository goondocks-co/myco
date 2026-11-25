import { HOSTED_BACKUP_PAUSE_NOTICE } from '@goondocks/myco-shared/backup-words';

/**
 * Every Deployment setting the dashboard edits, grouped for the page and placed
 * on Myco's work, on Models, or in one of the groups folded under Advanced.
 *
 * The server stores any JSON under a leaf; the shape a person can enter comes
 * from here. A gate holds the editable fields equal to the server's admitted leaves, so a leaf
 * added on one side without the other fails by name.
 */
import type { SettingsSectionId } from '../../../routes/nav';
import { CONFIGURABLE_PROFILE_HARNESSES, harnessName, PROFILE_HARNESSES, REASONING_TIERS } from '@goondocks/myco-shared/execution-profile';

/**
 * How a setting is edited. `agent` is one of the agents a machine can run
 * Myco's work with; `agents` is an ordered list of them.
 */
export type LeafKind = 'toggle' | 'number' | 'text' | 'textarea' | 'select' | 'json' | 'patterns' | 'agent' | 'agents'
  | 'embedding-provider' | 'embedding-model' | 'embedding-endpoint' | 'model';

export interface LeafField {
  leaf: string;
  label: string;
  kind: LeafKind;
  options?: readonly (string | number)[];
  optionLabels?: Readonly<Record<string, string>>;
  min?: number;
  /** Offers an explicit null override that removes the limit. */
  unlimited?: boolean;
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
  /** The agent whose model a `model` field chooses. */
  harness?: string;
}

/** The groups folded under Advanced, in page order. */
export const ADVANCED_FOLDS = [
  { id: 'model-sizes', label: 'Model sizes', summary: 'Which model each agent uses for small, medium and large jobs, how hard it thinks, and which agent is tried next.' },
  { id: 'pace', label: 'Pace', summary: 'How many jobs run at once, how often code maps and release checks run, and how long a session sits quiet before it gets a title.' },
  { id: 'sessions-given', label: 'What sessions are given', summary: 'The instructions each session starts with, and how much memory is attached to each prompt.' },
  { id: 'new-and-past', label: 'New repositories and past sessions', summary: 'Whether a new repository gets a project by itself, how much history a new machine brings, and whether that history gets titles.' },
  { id: 'kept', label: 'How long things are kept', summary: 'How long raw transcripts and the record of each task stay before they move or go.' },
  { id: 'backups', label: 'Backups', summary: 'Make, download and restore backups, how often this server backs itself up, and what it keeps.' },
  { id: 'upkeep', label: 'Upkeep', summary: 'How search is keeping up, housekeeping and the routine checks on the database; housekeeping and each check can be run now.' },
  { id: 'owner-actions', label: 'Owner actions', summary: 'Transfer ownership of this server. Claim raw data that has no recorded uploader.' },
] as const;
export type AdvancedFoldId = (typeof ADVANCED_FOLDS)[number]['id'];

export interface LeafGroup {
  /** The group's anchor on its section, and the `?tab=` an older link to it carries. */
  id: string;
  /** The section of Settings the group sits in. */
  section: SettingsSectionId;
  /** The Advanced group it is folded in, where its section is Advanced. */
  fold?: AdvancedFoldId;
  label: string;
  note: string;
  leaves: readonly LeafField[];
  /** The agent whose model sizes the group sets, where it sets one's. */
  harness?: string;
}

const SIGN_IN_OPTIONS = { deployment: 'The server’s stored key', 'worker-login': 'This machine’s sign-in' } as const;

/** A reasoning tier as the jobs it serves: small, medium and large. */
export const SIZE_WORDS: Readonly<Record<string, string>> = { low: 'Small', default: 'Medium', high: 'Large' };
const tierWords = (tier: string): string => `${SIZE_WORDS[tier] ?? tier} jobs`;

const profileFields = (harness: string): LeafField[] => [
  ...REASONING_TIERS.flatMap((tier) => [
    { leaf: `agent.reasoning_map.${harness}.${tier}`, label: `${tierWords(tier)} model`, kind: 'model' as const, resettable: true, harness,
      note: PROFILE_HARNESSES[harness]!.modelHint },
    { leaf: `agent.effort_map.${harness}.${tier}`, label: `${tierWords(tier)} effort`, kind: 'select' as const,
      options: PROFILE_HARNESSES[harness]!.allowedEfforts, resettable: true },
  ]),
  { leaf: `agent.harnesses.${harness}.credential`, label: 'Legacy workers sign in with', kind: 'select',
    options: Object.keys(SIGN_IN_OPTIONS), optionLabels: SIGN_IN_OPTIONS, resettable: true,
    note: 'Applies only to legacy workers. Each registered runner’s sign-in is chosen on Settings › Models, or chosen for that runner only on its machine page, and takes precedence.' },
];

/**
 * The model sizes of each agent whose manifest lets its models be chosen, named and described from the manifest. A
 * group's anchor is the first word of the agent's id, as older links name it.
 */
const PROFILE_GROUPS: readonly LeafGroup[] = CONFIGURABLE_PROFILE_HARNESSES.map((harness): LeafGroup => {
  const waits = REASONING_TIERS.some((tier) => PROFILE_HARNESSES[harness]!.models[tier] === null);
  return {
    id: `${harness.split('-')[0]}-profile`,
    section: 'advanced',
    fold: 'model-sizes',
    label: `${harnessName(harness)} model sizes`,
    note: `The model and effort ${harnessName(harness)} is asked for on small, medium and large jobs.${waits ? ' A size with no model waits until one is set.' : ''}`,
    leaves: profileFields(harness),
    harness,
  };
});

export const LEAF_GROUPS: readonly LeafGroup[] = [
  {
    id: 'scheduling',
    section: 'work',
    label: 'Should Myco work on its own?',
    note: 'Myco learns from finished sessions, writes their titles and keeps code maps current, without being asked.',
    leaves: [
      { leaf: 'agent.scheduled_tasks_enabled', label: 'Work on its own', kind: 'toggle' },
      { leaf: 'agent.budget.daily_usd', label: 'Daily budget', kind: 'number', min: 1, step: 0.01, unit: 'USD', note: 'The most Myco spends on its own in a day. When it’s reached, Myco waits until spending from the last 24 hours makes room. Work you start by hand is never blocked, and its spend counts.' },
    ],
  },
  {
    id: 'timing',
    section: 'advanced',
    fold: 'pace',
    label: 'When things happen',
    note: 'Which projects count as active, when a quiet session gets its title, and how often release tracking checks what has shipped.',
    leaves: [
      { leaf: 'agent.scheduled_tasks_active_window_days', label: 'Treat a project as active for', kind: 'number', min: 0, max: 365, unit: 'days' },
      { leaf: 'agent.cold_project_threshold_days', label: 'Treat a project as quiet after', kind: 'number', min: 0, max: 365, unit: 'days' },
      { leaf: 'agent.titling_idle_close_minutes', label: 'Title a session once it has been quiet for', kind: 'number', min: 5, max: 10080, unit: 'minutes', note: 'A session that never reports an end, such as a closed terminal pane, is titled once it has been quiet this long. The session itself stays open.' },
      { leaf: 'release_provenance.reconcile_interval_minutes', label: 'Check what has shipped every', kind: 'number', min: 1, max: 1440, unit: 'minutes', note: 'How often each project with release tracking on is checked against its release tags.' },
    ],
  },
  {
    id: 'limits',
    section: 'advanced',
    fold: 'pace',
    label: 'How much at once',
    note: 'How much of Myco’s work runs at once. Work past a limit waits its turn; nothing is refused. Clear a stored value to restore the server default, or choose No limit.',
    leaves: [
      { leaf: 'agent.limits.concurrent_runs', label: 'Tasks at once', kind: 'number', min: 1, unlimited: true },
      { leaf: 'agent.limits.task_concurrent_runs', label: 'Runs of one task at once', kind: 'number', min: 1, unlimited: true, note: 'Across all projects, this many runs of the same task can work at once. Further runs wait until one finishes.' },
      { leaf: 'agent.limits.task_runs_per_hour', label: 'Runs of one task per hour', kind: 'number', min: 1, unlimited: true },
    ],
  },
  {
    id: 'cortex',
    section: 'advanced',
    fold: 'sessions-given',
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
    section: 'advanced',
    fold: 'pace',
    label: 'Code map',
    note: 'Projects with Code map on keep their map current after new capture. Needs Myco to work on its own, a connected repository and a ready runner. Task limits apply.',
    leaves: [
      { leaf: 'cortex.canopy.refresh.background_period_minutes', label: 'Update every', kind: 'number', min: 1, unit: 'minutes' },
      { leaf: 'cortex.canopy.exclude.patterns', label: 'Paths left out', kind: 'patterns', note: 'Paths the map leaves out, beside the built-in ones. The map reads committed files only, so ignored files never reach it.' },
    ],
  },
  {
    id: 'single-turn',
    section: 'models',
    label: 'Quick jobs',
    note: 'Session titles and summaries: one question, one answer, no tools.',
    leaves: [
      { leaf: 'single_turn.base_url', label: 'Address', kind: 'text', resettable: true, note: 'An OpenAI-compatible address, such as http://localhost:1234/v1 for LM Studio or https://openrouter.ai/api/v1. Session prompts, agent replies and short file excerpts are sent there. Plain http is allowed only on this machine or a private network.' },
      { leaf: 'single_turn.model', label: 'Model', kind: 'text', resettable: true, note: 'The model name that address answers to.' },
    ],
  },
  {
    id: 'workers',
    section: 'models',
    label: 'Agent',
    note: 'The coding agent a runner uses for Myco’s work, when it is signed in to it.',
    leaves: [
      { leaf: 'worker.harness', label: 'Agent', kind: 'agent', note: 'The agent a runner tries first, when it is signed in to it.' },
    ],
  },
  ...PROFILE_GROUPS,
  {
    id: 'agent-order',
    section: 'advanced',
    fold: 'model-sizes',
    label: 'Agents tried next',
    note: 'The agents a runner tries, top first, when it is not signed in to the chosen one.',
    leaves: [
      { leaf: 'worker.harness_fallback', label: 'Then try, in order', kind: 'agents', note: 'The agents a runner tries next, top first.' },
    ],
  },
  {
    id: 'embedding',
    section: 'models',
    label: 'Search',
    note: 'Finding things by meaning: the provider and model search reads every source with. Changing the model once search is built rebuilds it for every source in the background, and search keeps working meanwhile.',
    leaves: [
      { leaf: 'embedding.provider', label: 'Embedding provider', kind: 'embedding-provider' },
      { leaf: 'embedding.model', label: 'Embedding model', kind: 'embedding-model' },
      { leaf: 'embedding.base_url', label: 'Embedding endpoint', kind: 'embedding-endpoint', note: 'Where a server on your network answers embedding requests.' },
      { leaf: 'embedding.prevent_deep_sleep', label: 'Keep embedding while idle', kind: 'toggle' },
    ],
  },
  {
    id: 'advanced',
    section: 'advanced',
    fold: 'model-sizes',
    label: 'Overrides for each task',
    note: 'Overrides for each task, as one document.',
    leaves: [
      { leaf: 'agent.tasks', label: 'Task overrides', kind: 'json', note: 'An object keyed by task name, in braces. A model named for a task needs an agent named beside it. “Title imported sessions” under New repositories and past sessions writes its switch here.' },
    ],
  },
  {
    id: 'new-repositories',
    section: 'advanced',
    fold: 'new-and-past',
    label: 'New repositories',
    note: 'What happens when someone works in a repository no project holds yet, inside the folders their machine captures.',
    leaves: [
      { leaf: 'capture.auto_create_projects', label: 'Create a project for it', kind: 'toggle', note: 'Off means the repository waits in Needs you until an admin connects it. A repository whose remote a project already holds joins that project either way.' },
    ],
  },
  {
    id: 'import',
    section: 'advanced',
    fold: 'new-and-past',
    label: 'Importing past sessions',
    note: 'What a machine brings with it when someone joins. Their agents have kept transcripts all along; this is how much of that history arrives.',
    leaves: [
      { leaf: 'import.enabled', label: 'Import past sessions on join', kind: 'toggle', note: 'Off means a machine brings nothing, and `myco import` is refused.' },
      { leaf: 'import.spores_enabled', label: 'Allow spore import', kind: 'toggle', note: 'Off by default. Only admins can import spores and their history from a Myco 1.4 vault.' },
      { leaf: 'import.window_days', label: 'Reach back at most', kind: 'number', min: 1, max: 3650, unit: 'days', note: 'Most agents keep transcripts for about a month, so reaching further back finds more only on machines whose history survived longer.' },
      { leaf: 'import.max_sessions_per_harness', label: 'At most, per agent', kind: 'number', min: 1, max: 1000, unit: 'sessions' },
    ],
  },
  {
    id: 'records',
    section: 'advanced',
    fold: 'kept',
    label: 'What Myco keeps',
    note: 'How long this server keeps raw transcripts and its own records.',
    leaves: [
      { leaf: 'retention.raw_days', label: 'Keep raw transcripts in active storage for', kind: 'number', min: 1, max: 3650, unit: 'days', note: 'Defaults to 90 days. After that, raw transcripts move to archive storage, where they stay, checked. A transcript Myco has not read yet, or one a restore still needs, moves later. A server set to keep them forever keeps them here until a number of days is set. Sessions, prompts, replies, tool calls, plans and spores stay indefinitely.' },
      { leaf: 'agent.run_retention_days', label: 'Keep task records for', kind: 'number', min: 1, max: 365, unit: 'days', note: 'How long the record of each task Myco ran is kept.' },
    ],
  },
  {
    id: 'backup',
    section: 'advanced',
    fold: 'backups',
    label: 'Backups',
    note: 'How often this server backs itself up and what it keeps.',
    leaves: [
      { leaf: 'backup.auto_interval_hours', label: 'Back up every', kind: 'number', min: 1, max: 720, unit: 'hours', note: `A self-hosted server writes a verified recovery copy on this interval; a hosted one stages a copy an operator then turns into one. ${HOSTED_BACKUP_PAUSE_NOTICE}` },
      { leaf: 'backup.recovery.keep_stagings', label: 'Full recovery copies to keep', kind: 'number', min: 1, max: 30, note: 'Complete copies kept, newest first; older ones are released, and so are failed ones past the newest. Unset keeps 2.' },
      { leaf: 'backup.retention.keep_daily', label: 'Manual exports to keep, newest first', kind: 'number', min: 1, max: 365, note: 'Keeps the newest export copies, rather than one per day. Pruned when a manual export is created.' },
      { leaf: 'backup.retention.keep_weekly', label: 'Recent export weeks to keep', kind: 'number', min: 0, max: 52, note: 'Keeps the newest export from each of the N most recent weeks that contain exports. Empty weeks consume no slot. Pruned when a manual export is created.' },
    ],
  },
  {
    id: 'maintenance',
    section: 'advanced',
    fold: 'upkeep',
    label: 'Store check schedule',
    note: 'Routine checks on the database. Nothing runs until a check is turned on with an interval; one turned on runs at the next wake and then on its interval. What each check last found is above; Health lists a check that found a problem.',
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

/** The groups folded in one Advanced group, in page order. */
export const groupsIn = (fold: AdvancedFoldId): readonly LeafGroup[] => LEAF_GROUPS.filter((g) => g.fold === fold);
