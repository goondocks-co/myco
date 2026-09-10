/**
 * The shapes a Deployment's agent configuration is validated against, shared by
 * the member's config schema and the server.
 *
 * A harness id, a reasoning tier, the per-tier value shapes a provider override
 * carries, and a scheduler accelerator. Each is declared once here so the
 * config schema and anything that reads these fields agree on the vocabulary
 * without either importing the other's package.
 */
import { z } from 'zod/v4';

export const HarnessIdSchema = z.string().min(1);
export const ReasoningLevelSchema = z.enum(['low', 'default', 'high']);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/** The two harness ids the 1.4 executor drove tasks under; config migrations and the provider map still name them. */
export const HARNESS_CLAUDE_SDK = 'claude-sdk' as const;
export const HARNESS_OPENAI_AGENTS = 'openai-agents' as const;

/**
 * A thinking budget: Anthropic's API refuses a budget below 1024 tokens, and
 * the ceiling bounds a typo that would spend every tier's run on reasoning.
 */
export const ThinkingBudgetValueSchema = z.union([
  z.object({ budgetTokens: z.number().int().min(1024).max(128000) }),
  z.object({ adaptive: z.literal(true) }),
]);

export const EffortValueSchema = z.object({
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  verbosity: z.enum(['low', 'medium', 'high']).optional(),
});

/** Named counts of pending work that shorten a scheduled task's interval under backlog. */
export const AcceleratorNameSchema = z.enum([
  'canopy-pending-describe',
  'unprocessed-settled-batches',
]);
export type AcceleratorName = z.infer<typeof AcceleratorNameSchema>;

/** An accelerator and the two thresholds its tiers switch at; the divisors on the interval are the scheduler's. */
export const AcceleratorConfigSchema = z.object({
  name: AcceleratorNameSchema,
  thresholds: z.object({
    steady: z.number().int().nonnegative(),
    accelerated: z.number().int().nonnegative(),
  }),
});
export type AcceleratorConfig = z.infer<typeof AcceleratorConfigSchema>;
