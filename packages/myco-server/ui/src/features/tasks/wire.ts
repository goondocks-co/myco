import type { ReasoningTier } from '@goondocks/myco-shared/execution-profile';

/** The task catalogue answered by the server. */
export interface TaskDescription {
  task: string;
  name: string;
  description: string;
  triggers: readonly string[];
  tools: readonly string[];
  done: readonly string[];
  budget: {
    timeoutSeconds: number;
    readWindow: {
      sporePage: number;
      sporePreviewChars: number;
      sporeBodyChars: number;
      sporeFullReads: number;
      sessionPage: number;
      sessionTitleChars: number;
      sessionSummaryChars: number;
      sessionLabelChars: number;
      promptPage: number;
    };
  } | null;
  tier: ReasoningTier | null;
  profiles: readonly { harness: string; model: string | null; effort: string | null; note: string | null }[];
  profileNote: string | null;
  availabilityNote: string | null;
  /** A person may start it by hand from Run a task. */
  startable: boolean;
  promptTemplate: string | null;
  standingRules: string | null;
  templateVariants: readonly { name: string; prompt: string }[];
}

export interface TasksAnswer { tasks: TaskDescription[] }
export interface TaskNamesAnswer { tasks: { task: string; name: string }[] }

/** `GET /api/tasks/start`: what starting a task by hand in one project would do now. */
export interface TaskStartPreview {
  task: string;
  projectId: string;
  /** The agent, tier, model and effort the first able worker would run it with; null when none could take it now. */
  execution: { harness: string; tier: ReasoningTier; model: string; effort: string | null } | null;
  /** What a queued run would wait under while no worker can take it, in the holder vocabulary of `run-holds`; null when one can. */
  heldBy: string | null;
  /** How many workers have been heard from lately. */
  workers: number;
  /** The task's own condition for running and whether it holds in the project now; null for a task that names none. */
  readiness: { condition: string; met: boolean } | null;
  /** A run of the task is already waiting or running in the project. */
  live: boolean;
  /** The capability the task needs and whether the project has it on; null for a task no capability gates. */
  capability: { name: string; on: boolean } | null;
  /** The caller's own day of runs of the task; null for an admin, who starts runs uncapped. */
  allowance: { perDay: number; used: number; resetsAt: number | null } | null;
}
