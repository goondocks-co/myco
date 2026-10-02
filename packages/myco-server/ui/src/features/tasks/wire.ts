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
  };
  tier: ReasoningTier | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
  profileNote: string | null;
  promptTemplate: string | null;
  standingRules: string | null;
  templateVariants: readonly { name: string; prompt: string }[];
}

export interface TasksAnswer { tasks: TaskDescription[] }
