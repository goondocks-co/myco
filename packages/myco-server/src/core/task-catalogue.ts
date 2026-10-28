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
 * - **A capability**, per Project, enabled unless explicitly switched off.
 * - **Capture**, for request-driven titling. The worker claim selects the
 *   harness, tier profile and login; no provider setting gates the request.
 * - **An embedding provider**, per Deployment, for deterministic vector work.
 *
 * Four of the retained tasks are run outcomes: one prompt each, built by the
 * Deployment, with declared expected evidence
 * (`core/run-postconditions.ts`). `OUTCOME_TASKS` names them, and
 * `tests/myco-server/task-catalogue.test.ts` holds the close rules, the input
 * builders and this list to one another.
 */
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { MAX_WORKER_RUN_SECONDS } from '@goondocks/myco-shared/harness-health';
import { declared } from './declared.js';
import type { RunAdmissionGate } from './runs.js';

/** The task that writes a session's title and summary. */
export const TITLING_TASK = 'title-summary';
/** The task that learns durable knowledge from session material. */
export const EXTRACTION_TASK = 'extract-curate';
/** The task that writes one card per completed turn on the cheap tier, the material learning reads. */
export const CARD_TASK = 'turn-cards';
/** The task that seeds a Project from a checkout of its code and git history. */
export const SEEDING_TASK = 'vault-seed';

/** The task that keeps a Project's repository map from a checkout of its code. */
export { MAP_TASK };

/** The four run outcomes: every worker-served task with a prompt of its own. */
export const OUTCOME_TASKS: readonly string[] = [EXTRACTION_TASK, CARD_TASK, SEEDING_TASK, TITLING_TASK, MAP_TASK];

/** The reasoning tier each worker outcome declares. */
export const TASK_TIERS: Readonly<Record<string, import('@goondocks/myco-shared/execution-profile').ReasoningTier>> = {
  [TITLING_TASK]: 'low',
  [EXTRACTION_TASK]: 'default',
  [CARD_TASK]: 'low',
  [MAP_TASK]: 'default',
  [SEEDING_TASK]: 'default',
};

/** Tasks whose required worker capability is not available for dispatch. */
export const UNLANDED_TASKS: readonly string[] = [];
export const LEARNING_PAUSE_MESSAGE = 'Learning resumes with whole-session reading';

/** The declared reason a retained task is unavailable on this Deployment. */
export function taskAvailabilityNote(task: string): string | null {
  return UNLANDED_TASKS.includes(task) && (task === EXTRACTION_TASK || task === CARD_TASK) ? LEARNING_PAUSE_MESSAGE : null;
}

/** Every retained task, with the gate it runs behind. */
export const TASK_ADMISSION = {
  [MAP_TASK]: { kind: 'capability', capability: 'canopy' },
  'embedding-reconcile': { kind: 'embedding' },
  [EXTRACTION_TASK]: { kind: 'capability', capability: 'vault_evolution' },
  [CARD_TASK]: { kind: 'capability', capability: 'vault_evolution' },
  [SEEDING_TASK]: { kind: 'capability', capability: 'vault_evolution' },
  [TITLING_TASK]: { kind: 'capture' },
} satisfies Readonly<Record<string, RunAdmissionGate>>;

export type RetainedTask = keyof typeof TASK_ADMISSION;
export const RETAINED_TASKS = Object.keys(TASK_ADMISSION) as RetainedTask[];

/**
 * The tools each retained task DECLARES, in the run-surface source vocabulary.
 *
 * A run's MCP surface is built from this list (`mcp/run-surface.ts`): each name
 * maps onto the `(tool, op)` pairs the run may call, and a task that declares no
 * tools of its own has an empty surface. The task-tools suite compares these
 * names with the frozen task contract and holds each to one RUN_TOOL_MAP entry.
 */
export const TASK_TOOLS: Readonly<Record<string, readonly string[]>> = {
  [MAP_TASK]: ['vault_canopy_map', 'vault_report'],
  'embedding-reconcile': [],
  [EXTRACTION_TASK]: [
    'vault_learning', 'vault_mark_processed', 'vault_spores', 'vault_spore',
    'vault_search_fts', 'vault_search_semantic', 'vault_create_spore', 'vault_resolve_spore', 'vault_report',
  ],
  [CARD_TASK]: ['vault_turn_cards', 'vault_report'],
  [SEEDING_TASK]: ['vault_spores', 'vault_spore', 'vault_search_fts', 'vault_search_semantic', 'vault_create_spore', 'vault_report'],
  [TITLING_TASK]: ['vault_report', 'vault_session_summary_material', 'vault_update_session'],
};

/** The tools a task declares, or none for a task this Deployment does not serve. */
export function taskTools(task: string | null): readonly string[] {
  return task === null ? [] : declared(TASK_TOOLS, task) ?? [];
}

/**
 * How long one run of a task may take, by task.
 *
 * The dispatcher's flat default is a titling run's shape: a handful of turns at
 * low reasoning, done in seconds. Learning searches before each write;
 * a seeding or map run explores a whole
 * checkout. Each takes minutes, and a run aborted mid-work has spent its money and left only
 * what it had written. A task named here carries its own budget into the run's
 * context, which is also the window the run's own routes admit it inside and
 * the point past which the stale sweep gives up on it.
 */
export const TASK_RUN_TIMEOUT_SECONDS: Readonly<Record<string, number>> = {
  [MAP_TASK]: 900,
  [EXTRACTION_TASK]: 900,
  [CARD_TASK]: 600,
  [SEEDING_TASK]: MAX_WORKER_RUN_SECONDS,
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
/** Tasks only a claim pulls: they have no hand start, so the Deployment builds them no queued input. */
export const PULLED_ONLY_TASKS: readonly string[] = [CARD_TASK];

/** The gate a task runs behind, or null for a name this Deployment does not serve. */
export function admissionForTask(taskName: string): RunAdmissionGate | null {
  return declared(TASK_ADMISSION, taskName) ?? null;
}

/** Reader descriptions owned by the task declarations. */
export const TASK_WORDS: Readonly<Record<RetainedTask, { name: string; description: string }>> = {
  [CARD_TASK]: { name: 'Card session turns', description: 'Write a short card for each finished turn of a session, keeping errors, fixes and decisions word for word.' },
  [EXTRACTION_TASK]: { name: 'Learn from sessions', description: 'Save durable knowledge from sessions as spores, and retire knowledge they replace.' },
  [SEEDING_TASK]: { name: 'Seed project memory', description: 'Read the connected code and git history to write the project’s first spores.' },
  [TITLING_TASK]: { name: 'Title and summarize sessions', description: 'Read a session’s prompts and write a title and summary of what was accomplished.' },
  [MAP_TASK]: { name: 'Keep the code map', description: 'Read the connected code to keep a grounded guide to its directories and key files.' },
  'embedding-reconcile': { name: 'Keep search current', description: 'Update the search index for project memory so similar knowledge can be found.' },
};
