/**
 * The tasks whose prompt the server builds, and the artifact each one's build is
 * compared against.
 *
 * A dispatched run holds no vault. For these tasks the Deployment assembles the
 * material itself, carries it on the run row as the run's instruction, and
 * hashes what went into it. The hash is the dedup: a dispatch whose build
 * matches the artifact the Project already holds starts no run at all, which is
 * what keeps a daily schedule from spending a model call on unchanged material.
 *
 * The build happens at every decision point that could start a run — an owner's
 * ask, the clock's wake, and the drain that launches a queued row — so a run
 * always carries the vault as it stood at the instant it launched.
 */
import type { ServerEnv } from './adapters.js';
import { buildInstructionsInput, type InstructionsCounts } from './cortex-input.js';
import { readRecallLeaves } from './recall.js';
import { settingsWriter } from './settings.js';
import { newestInstructionsHash } from '../read/cortex.js';

/** The task whose run authors this Project's session-start instructions. */
export const CORTEX_INSTRUCTIONS_TASK = 'cortex-instructions';

/** The tasks whose runs read their prompt back over `/runs/instruction`. */
export const INSTRUCTED_TASKS: readonly string[] = [CORTEX_INSTRUCTIONS_TASK];

/** The tasks whose runs list this Project's sessions over the run routes. */
export const SESSION_LIST_TASKS: readonly string[] = [CORTEX_INSTRUCTIONS_TASK];

/** The tasks whose runs read this Project's digest over the run routes. */
export const DIGEST_READ_TASKS: readonly string[] = [CORTEX_INSTRUCTIONS_TASK];

/** The report action a `cortex-instructions` run records its artifact under. */
export const CORTEX_INSTRUCTIONS_ACTION = 'cortex_instructions';

/** What one build answers: the run's prompt, the hash of the material behind it, and what that material counted. */
export interface TaskInput {
  instruction: string;
  inputHash: string;
  counts: InstructionsCounts;
}

/** Builds a task's prompt for one Project, and reads the hash the Project's current artifact carries. */
export interface TaskInputBuilder {
  build(env: ServerEnv, projectId: string, now: number): Promise<TaskInput>;
  /** The hash on the artifact this task last wrote, or null where it has written none. */
  currentHash(env: ServerEnv, projectId: string): Promise<string | null>;
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
};

/** The builder for this task, or null for a task the server builds no input for. */
export function inputBuilderFor(task: string): TaskInputBuilder | null {
  return INPUT_BUILDERS[task] ?? null;
}

/** What a decision to dispatch answers once the input is built: the run's material, or that the Project has not moved. */
export type BuiltInput = { unchanged: true } | { unchanged: false; input: TaskInput };

/** Build this task's input and compare it against the artifact the Project holds. A task with no builder answers null. */
export async function buildTaskInput(env: ServerEnv, task: string, projectId: string, now: number): Promise<BuiltInput | null> {
  const builder = inputBuilderFor(task);
  if (builder === null) return null;
  const [input, held] = await Promise.all([builder.build(env, projectId, now), builder.currentHash(env, projectId)]);
  return held === input.inputHash ? { unchanged: true } : { unchanged: false, input };
}
