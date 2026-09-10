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
 *
 * Three of the retained tasks are the run outcomes of plan §2.5: one prompt
 * each, built by the Deployment, with declared expected evidence
 * (`core/run-postconditions.ts`). `OUTCOME_TASKS` names them, and
 * `tests/myco-server/task-catalogue.test.ts` holds the close rules, the input
 * builders and this list to one another.
 */
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { declared } from './declared.js';
import type { RunAdmissionGate } from './runs.js';

/** The task that writes a session's title and summary. */
export const TITLING_TASK = 'title-summary';
/** The task that reads the prompts nobody has read, writes what they taught, and retires what they replaced. */
export const EXTRACTION_TASK = 'extract-curate';
/** The task that seeds a Project from a checkout of its code and git history. */
export const SEEDING_TASK = 'vault-seed';

/** The three run outcomes: every worker-served task with a prompt of its own. */
export const OUTCOME_TASKS: readonly string[] = [EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK];

/** Tasks whose required worker capability is not available for dispatch. */
export const UNLANDED_TASKS: readonly string[] = [];

/** Every retained task, with the gate it runs behind. */
export const TASK_ADMISSION: Readonly<Record<string, RunAdmissionGate>> = {
  [MAP_TASK]: { kind: 'capability', capability: 'canopy' },
  'embedding-reconcile': { kind: 'embedding' },
  'container-smoke': { kind: 'capability', capability: 'cortex' },
  [EXTRACTION_TASK]: { kind: 'capability', capability: 'vault_evolution' },
  [SEEDING_TASK]: { kind: 'capability', capability: 'vault_evolution' },
  [TITLING_TASK]: { kind: 'provider' },
};

export const RETAINED_TASKS = Object.keys(TASK_ADMISSION);

/**
 * The tools each retained task DECLARES, in the run-surface source vocabulary.
 *
 * A run's MCP surface is built from this list (`mcp/run-surface.ts`): each name
 * maps onto the `(tool, op)` pairs the run may call, and a task that declares no
 * tools of its own has an empty surface. The names are the 1.4 task files' own
 * vocabulary; `tests/myco-server/task-tools.test.ts` holds a task that still
 * has a file under `packages/myco/src/agent/definitions/tasks/` equal to it,
 * and holds every name here to one `RUN_TOOL_MAP` entry.
 */
export const TASK_TOOLS: Readonly<Record<string, readonly string[]>> = {
  [MAP_TASK]: ['code_grep', 'fs_list', 'fs_read', 'fs_tree', 'vault_report'],
  'embedding-reconcile': [],
  'container-smoke': [],
  [EXTRACTION_TASK]: [
    'vault_unprocessed', 'vault_mark_processed', 'vault_sessions', 'vault_spores', 'vault_spore', 'vault_state', 'vault_set_state',
    'vault_search_fts', 'vault_search_semantic', 'vault_create_spore', 'vault_resolve_spore', 'vault_report',
  ],
  [SEEDING_TASK]: ['vault_spores', 'vault_spore', 'vault_search_fts', 'vault_search_semantic', 'vault_create_spore', 'vault_report'],
  [TITLING_TASK]: ['vault_report', 'vault_session_summary_material', 'vault_unprocessed', 'vault_update_session'],
};

/** The tools a task declares, or none for a task this Deployment does not serve. */
export function taskTools(task: string | null): readonly string[] {
  return task === null ? [] : declared(TASK_TOOLS, task) ?? [];
}

/**
 * How long one run of a task may take, by task.
 *
 * The dispatcher's flat default is a titling run's shape: a handful of turns at
 * low reasoning, done in seconds. An extraction pass reads a page of prompts
 * and searches before each write; a seeding run explores a whole checkout. Both
 * take minutes, and a run aborted mid-work has spent its money and left only
 * what it had written. A task named here carries its own budget into the run's
 * context, which is also the window the run's own routes admit it inside and
 * the point past which the stale sweep gives up on it.
 */
export const TASK_RUN_TIMEOUT_SECONDS: Readonly<Record<string, number>> = {
  [MAP_TASK]: 900,
  [EXTRACTION_TASK]: 900,
  [SEEDING_TASK]: 3600,
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
 * Seeding is the one: it reads a whole checkout and writes a Project's first
 * spores, and a second pass over an already-seeded Project is a person's call.
 */
export const MANUAL_ONLY_TASKS: readonly string[] = [SEEDING_TASK];

/** The gate a task runs behind, or null for a name this Deployment does not serve. */
export function admissionForTask(taskName: string): RunAdmissionGate | null {
  return declared(TASK_ADMISSION, taskName) ?? null;
}
