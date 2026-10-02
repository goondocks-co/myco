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
  promptTemplate: string | null;
  standingRules: string | null;
  templateVariants: readonly { name: string; prompt: string }[];
}

export interface TasksAnswer { tasks: TaskDescription[] }
export interface TaskNamesAnswer { tasks: { task: string; name: string }[] }
