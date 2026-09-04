/**
 * The tasks whose prompt the server builds, and the artifact each one's build is
 * compared against.
 *
 * A dispatched run holds no vault. For these tasks the Deployment assembles the
 * material itself, carries it on the run row as the run's instruction, and
 * hashes what went into it. For a task that names the artifact its build is
 * compared against, the hash is the dedup: a dispatch whose build matches what
 * the Project already holds starts no run at all, which is what keeps a daily
 * schedule from spending a model call on unchanged material. A task that names
 * none always runs, and its hash travels only as the record of what its run was
 * handed.
 *
 * The build happens at every decision point that could start a run — an owner's
 * ask, the clock's wake, and the drain that launches a queued row — so a run
 * always carries the vault as it stood at the instant it launched.
 */
import type { ServerEnv } from './adapters.js';
import { buildDigestInput, buildInstructionsInput } from './cortex-input.js';
import { readRecallLeaves } from './recall.js';
import { settingsWriter } from './settings.js';
import { newestInstructionsHash } from '../read/cortex.js';

/** The task whose run authors this Project's session-start instructions. */
export const CORTEX_INSTRUCTIONS_TASK = 'cortex-instructions';

/** The task whose run regenerates this Project's digest extracts. */
export const DIGEST_TASK = 'digest-only';

/** The tasks whose runs read their prompt back over `/runs/instruction`. */
export const INSTRUCTED_TASKS: readonly string[] = [CORTEX_INSTRUCTIONS_TASK, DIGEST_TASK];

/** The tasks whose runs list this Project's sessions over the run routes. */
export const SESSION_LIST_TASKS: readonly string[] = [CORTEX_INSTRUCTIONS_TASK, DIGEST_TASK];

/** The tasks whose runs read this Project's digest over the run routes. */
export const DIGEST_READ_TASKS: readonly string[] = [CORTEX_INSTRUCTIONS_TASK, DIGEST_TASK];

/** The tasks whose runs write this Project's digest over the run routes. */
export const DIGEST_WRITE_TASKS: readonly string[] = [DIGEST_TASK];

/** The report action a `cortex-instructions` run records its artifact under. */
export const CORTEX_INSTRUCTIONS_ACTION = 'cortex_instructions';

/** What one build answers: the run's prompt, the hash of the material behind it, and what that material counted. */
export interface TaskInput {
  instruction: string;
  inputHash: string;
  counts: Readonly<Record<string, number | boolean>>;
}

/** What a caller asks of one build beyond the Project and the instant. */
export interface TaskInputOptions {
  /** The run writes its artifact from the material alone rather than carrying the current one forward. */
  fresh?: boolean;
}

/** Builds a task's prompt for one Project, and where the task is deduped, reads the hash the Project's current artifact carries. */
export interface TaskInputBuilder {
  build(env: ServerEnv, projectId: string, now: number, options: TaskInputOptions): Promise<TaskInput>;
  /**
   * The hash on the artifact this task last wrote, or null where it has written
   * none. A builder that offers none is never deduped: its run judges tier by
   * tier what is worth rewriting and says so in its own report, so a build that
   * matched what the Project holds would refuse a pass the run itself would have
   * skipped for free.
   */
  currentHash?(env: ServerEnv, projectId: string): Promise<string | null>;
}

export const INPUT_BUILDERS: Readonly<Record<string, TaskInputBuilder>> = {
  [CORTEX_INSTRUCTIONS_TASK]: {
    async build(env, projectId, now) {
      const [leaves, capabilities] = await Promise.all([
        readRecallLeaves(env.db),
        settingsWriter(env.db).capabilities(projectId),
      ]);
      return buildInstructionsInput(env.db, { projectId }, { leaves, capabilities, now });
    },
    currentHash(env, projectId) {
      return newestInstructionsHash(env.db, { projectId });
    },
  },
  [DIGEST_TASK]: {
    async build(env, projectId, now, options) {
      const leaves = await readRecallLeaves(env.db);
      return buildDigestInput(env.db, { projectId }, { leaves, fresh: options.fresh === true, now });
    },
  },
};

/** The builder for this task, or null for a task the server builds no input for. */
export function inputBuilderFor(task: string): TaskInputBuilder | null {
  return INPUT_BUILDERS[task] ?? null;
}

/** What a decision to dispatch answers once the input is built: the run's material, or that the Project has not moved. */
export type BuiltInput = { unchanged: true } | { unchanged: false; input: TaskInput };

/**
 * Build this task's input and, where the task is deduped, compare it against the
 * artifact the Project holds. A task with no builder answers null; a builder
 * that names no held hash always answers its build.
 */
export async function buildTaskInput(
  env: ServerEnv, task: string, projectId: string, now: number, options: TaskInputOptions = {},
): Promise<BuiltInput | null> {
  const builder = inputBuilderFor(task);
  if (builder === null) return null;
  const [input, held] = await Promise.all([
    builder.build(env, projectId, now, options),
    builder.currentHash === undefined ? Promise.resolve(null) : builder.currentHash(env, projectId),
  ]);
  return builder.currentHash !== undefined && held === input.inputHash ? { unchanged: true } : { unchanged: false, input };
}
