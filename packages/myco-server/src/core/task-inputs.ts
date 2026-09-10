/**
 * The tasks whose prompt the server builds: the three run outcomes.
 *
 * A dispatched run holds no vault. For these tasks the Deployment assembles the
 * instruction itself, carries it on the run row, and hashes what went into it.
 * Two texts make one instruction: the ask, which the worker hands the harness as
 * its prompt, and the standing rules, which the worker writes into the run's
 * scratch directory as the instructions file a harness reads from its working
 * directory. The ask says what this pass does; the rules say what a good result
 * is, and they hold on every turn rather than only in the opening prompt.
 *
 * The build happens at every decision point that could start a run — an owner's
 * ask, the clock's wake, and the claim that hands a queued row to a worker — so
 * a run always carries the instruction as it stands at the instant it launched.
 * A worker-served task with no builder here cannot be instructed, and its
 * dispatch is refused before a row exists (`prepareDispatch`, `no_instruction`).
 */
import type { ServerEnv } from './adapters.js';
import type { RepositoryCheckoutSpec } from '@goondocks/myco-shared/repository';
import { buildExtractionInput } from './extraction-input.js';
import { buildSeedingInput } from './seeding-input.js';
import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from './task-catalogue.js';
import { buildTitlingInput } from './titling-input.js';

/** What one build answers: the run's prompt, the standing rules for its instructions file, the hash of the material behind it, and what that material counted. */
export interface TaskInput {
  instruction: string;
  /** The instructions file the worker writes into the run's scratch directory; absent for a task whose whole instruction is the prompt. */
  instructions?: string;
  inputHash: string;
  counts: Readonly<Record<string, number | boolean>>;
  repository?: RepositoryCheckoutSpec;
}

/** What a caller asks of one build beyond the Project and the instant. */
export interface TaskInputOptions {
  /** The run writes its artifact from the material alone rather than carrying the current one forward. */
  fresh?: boolean;
  /** The parameters the dispatch carries, for a task whose instruction is about one thing the dispatch names rather than the Project as a whole. */
  params?: Record<string, unknown>;
}

/** Builds a task's prompt for one Project, and where the task is deduped, reads the hash the Project's current artifact carries. */
export interface TaskInputBuilder {
  /** The instruction, or null when what the run carries is not enough to write one. */
  build(env: ServerEnv, projectId: string, now: number, options: TaskInputOptions): Promise<TaskInput | null>;
  /**
   * The hash on the artifact this task last wrote, or null where it has written
   * none. A builder that offers none is never deduped. No retained task offers
   * one: each outcome's pass judges for itself what is worth writing and says so
   * in its report, so a build that matched what the Project holds would refuse a
   * pass the run itself would have skipped for free.
   */
  currentHash?(env: ServerEnv, projectId: string): Promise<string | null>;
}

export const INPUT_BUILDERS: Readonly<Record<string, TaskInputBuilder>> = {
  [EXTRACTION_TASK]: { build: () => buildExtractionInput() },
  [SEEDING_TASK]: { build: (env, projectId) => buildSeedingInput(env, projectId) },
  [TITLING_TASK]: { build: (_env, _projectId, _now, options) => buildTitlingInput(options.params ?? {}) },
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
  if (input === null) return null;
  return builder.currentHash !== undefined && held === input.inputHash ? { unchanged: true } : { unchanged: false, input };
}

/**
 * How a run nobody can instruct is recorded.
 *
 * A worker hands its harness the instruction the claim answers, and a harness
 * given an empty prompt ends its turn at once, having called nothing; the
 * Deployment then records a run that reports nothing. That run never reaches a
 * worker: a queued run whose build answers nothing and whose dispatch carried no
 * instruction is ended at the claim, under this error, where the runs page
 * shows it.
 */
export function uninstructedError(task: string): string {
  return `the Deployment has no instruction for a ${task} run`;
}

/**
 * The instruction a claimed run is driven under.
 *
 * A task with a builder is driven by its build alone: a build that answers
 * nothing means what the prompt described is gone — a repository disconnected
 * after the dispatch, a session the dispatch never named — and the instruction
 * the dispatch stored would drive a run about a thing that is not there. Only a
 * task with no builder is driven by what its dispatch carried. Null when there
 * is neither.
 */
export function instructionFor(built: BuiltInput | null, stored: string | null, hasBuilder: boolean): string | null {
  const instruction = built !== null && !built.unchanged ? built.input.instruction : hasBuilder ? null : stored;
  return instruction === null || instruction.trim() === '' ? null : instruction;
}

/** The instructions file a claimed run is handed beside its prompt, or null for a task whose whole instruction is the prompt. */
export function instructionsFileFor(built: BuiltInput | null): string | null {
  return built !== null && !built.unchanged ? built.input.instructions ?? null : null;
}
