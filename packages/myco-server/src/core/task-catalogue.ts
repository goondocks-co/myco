/**
 * What each retained intelligence task needs before it may run.
 *
 * The 1.4 vault carries a partial version of this inverted, as
 * `CapabilityDef.scheduledTasks` in `packages/myco/src/config/capabilities.ts`.
 * That field lists only SCHEDULED tasks and nothing reads it at runtime — it
 * groups the settings UI. Locally no agent task is refused on a capability at
 * all: capabilities gate features there, and a capture-only project is made by
 * `reseedCaptureOnly()` writing every master gate false at provision.
 *
 * A Deployment has no provisioning moment — a Project appears from a member's
 * first write — so admission has to be asked per run, and this is the table that
 * answers it. Every retained task names one gate:
 *
 * - **A capability**, per Project, absent meaning not admitted.
 * - **A provider**, per Deployment, for the capture-driven tasks. A title and
 *   summary rides capture rather than an intelligence capability, and asks only
 *   whether there is a model to call — resolved task-first then default, as
 *   `hasConfiguredProvider` resolves it locally.
 * - **An embedding provider**, per Deployment, for deterministic vector work.
 */
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { declared } from './declared.js';
import type { RunAdmissionGate } from './runs.js';

/** The task that writes a session's title and summary. */
export const TITLING_TASK = 'title-summary';

/** Every retained task, with the gate it runs behind. */
export const TASK_ADMISSION: Readonly<Record<string, RunAdmissionGate>> = {
  [MAP_TASK]: { kind: 'capability', capability: 'canopy' },
  'embedding-reconcile': { kind: 'embedding' },
  'container-smoke': { kind: 'capability', capability: 'cortex' },
  'cortex-prompt-builder': { kind: 'capability', capability: 'cortex' },
  'digest-only': { kind: 'capability', capability: 'cortex' },

  'skill-survey': { kind: 'capability', capability: 'skills' },
  'skill-generate': { kind: 'capability', capability: 'skills' },
  'skill-evolve': { kind: 'capability', capability: 'skills' },

  'vault-evolve': { kind: 'capability', capability: 'vault_evolution' },
  'vault-seed': { kind: 'capability', capability: 'vault_evolution' },
  'supersession-sweep': { kind: 'capability', capability: 'vault_evolution' },
  'extract-only': { kind: 'capability', capability: 'vault_evolution' },
  'review-session': { kind: 'capability', capability: 'vault_evolution' },

  [TITLING_TASK]: { kind: 'provider' },
};

export const RETAINED_TASKS = Object.keys(TASK_ADMISSION);

/**
 * The tools each retained task DECLARES, in the task file's own vocabulary.
 *
 * A run's MCP surface is built from this list (`mcp/run-surface.ts`): the
 * task's `toolOverrides`, or the union of its phases' `tools` and
 * `deferredTools`, and nothing a task inherits — a task that declares no tools
 * of its own has an empty surface, so the health probe never holds the agent's
 * whole default set. The task files live under
 * `packages/myco/src/agent/definitions/tasks/` until #1170 deletes them;
 * `tests/myco-server/task-tools.test.ts` holds this table equal to them, both
 * ways, until then. #1152 re-homes the outcome tasks here with their tools.
 */
export const TASK_TOOLS: Readonly<Record<string, readonly string[]>> = {
  [MAP_TASK]: ['code_grep', 'fs_list', 'fs_read', 'fs_tree', 'vault_report'],
  'embedding-reconcile': [],
  'container-smoke': [],
  'cortex-prompt-builder': ['vault_read_digest', 'vault_report', 'vault_search_fts', 'vault_search_semantic', 'vault_sessions', 'vault_skill_records', 'vault_spores'],
  'digest-only': ['vault_read_digest', 'vault_report', 'vault_sessions', 'vault_spore', 'vault_spores', 'vault_write_digest'],

  'skill-survey': [
    'vault_report', 'vault_search_fts', 'vault_search_semantic', 'vault_sessions', 'vault_skill_candidates', 'vault_skill_records',
    'vault_skill_survey_apply_reconciliation', 'vault_skill_survey_bundle_decisions', 'vault_skill_survey_prepare',
    'vault_skill_survey_reconciliation_plan', 'vault_spores', 'vault_state',
  ],
  'skill-generate': ['code_grep', 'fs_read', 'vault_finalize_skill', 'vault_report', 'vault_skill_candidates', 'vault_skill_records', 'vault_spores', 'vault_stage_skill'],
  'skill-evolve': [
    'code_grep', 'fs_read', 'vault_edit_skill', 'vault_report', 'vault_scan_skill_contamination', 'vault_search_fts', 'vault_set_state',
    'vault_skill_candidates', 'vault_skill_records', 'vault_spores', 'vault_write_skill',
  ],

  'vault-evolve': [
    'phase_emit_metadata', 'vault_create_spore', 'vault_mark_processed', 'vault_read_digest', 'vault_release_state', 'vault_report',
    'vault_resolve_spore', 'vault_search_fts', 'vault_search_semantic', 'vault_sessions', 'vault_set_state', 'vault_spores', 'vault_state',
    'vault_unprocessed', 'vault_update_session', 'vault_write_digest',
  ],
  'vault-seed': [
    'code_grep', 'fs_list', 'fs_read', 'fs_tree', 'phase_emit_metadata', 'vault_create_spore', 'vault_read_digest', 'vault_release_state',
    'vault_report', 'vault_search_semantic', 'vault_spores', 'vault_write_digest',
  ],
  'supersession-sweep': ['vault_create_spore', 'vault_report', 'vault_resolve_spore', 'vault_spore', 'vault_spores'],
  'extract-only': [
    'vault_create_spore', 'vault_mark_processed', 'vault_report', 'vault_resolve_spore', 'vault_search_fts', 'vault_search_semantic',
    'vault_sessions', 'vault_set_state', 'vault_spores', 'vault_state', 'vault_unprocessed', 'vault_update_session',
  ],
  'review-session': [
    'vault_create_spore', 'vault_mark_processed', 'vault_report', 'vault_resolve_spore', 'vault_search_fts', 'vault_search_semantic',
    'vault_sessions', 'vault_set_state', 'vault_spores', 'vault_state', 'vault_unprocessed', 'vault_update_session',
  ],

  'title-summary': ['vault_report', 'vault_session_summary_material', 'vault_unprocessed', 'vault_update_session'],
};

/** The tools a task declares, or none for a task this Deployment does not serve. */
export function taskTools(task: string | null): readonly string[] {
  return task === null ? [] : declared(TASK_TOOLS, task) ?? [];
}

/**
 * How long one run of a task may take, by task.
 *
 * The dispatcher's flat default is a titling run's shape: a handful of turns at
 * low reasoning, done in seconds. A Cortex run is a dozen turns of a frontier
 * model over a payload the server assembled, and a digest run rewrites three
 * tiers from a whole vault; both take minutes, and a run aborted mid-work has
 * spent its money and left nothing. A task named here carries its own budget
 * into the run's context, which is also the window the run's own routes admit it
 * inside and the point past which the stale sweep gives up on it.
 */
export const TASK_RUN_TIMEOUT_SECONDS: Readonly<Record<string, number>> = {
  [MAP_TASK]: 900,
  'digest-only': 1800,
};

/** The budget one run of this task gets, or null for a task that takes the dispatcher's default. */
export function runTimeoutForTask(task: string): number | null {
  return declared(TASK_RUN_TIMEOUT_SECONDS, task) ?? null;
}

/**
 * The tasks a person asks for one at a time: they carry no schedule, and a
 * schedule appearing on one is a cost the Deployment would pay on the clock
 * without anyone deciding it should.
 *
 * `digest-only` is not among them any more: it carries a declared schedule that
 * ships switched off, which is what gives an owner's ask a per-day ceiling and
 * an override to lift it.
 */
export const MANUAL_ONLY_TASKS: readonly string[] = [
  'vault-seed',
  'extract-only',
  'supersession-sweep',
  'review-session',
  'cortex-prompt-builder',
];

/** The gate a task runs behind, or null for a name this Deployment does not serve. */
export function admissionForTask(taskName: string): RunAdmissionGate | null {
  return declared(TASK_ADMISSION, taskName) ?? null;
}
