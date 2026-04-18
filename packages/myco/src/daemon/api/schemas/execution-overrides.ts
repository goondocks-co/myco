/**
 * Shared zod schemas for execution override wire shapes.
 *
 * These schemas describe the camelCase provider/phase override packets that
 * clients (eval CLI, RunTaskDialog, etc.) POST to /api/agent/run and
 * /api/agent/evaluations. They mirror the runtime `ProviderConfig` and
 * `RunOptions.executionOverrides` types in `@myco/agent/types.ts`.
 *
 * The provider wire shape is camelCase (matches the runtime ProviderConfig),
 * unlike the snake_case myco.yaml persisted shape. Clients that read from
 * myco.yaml convert to camelCase before posting — see RunTaskDialog's
 * override builder.
 */

import { z } from 'zod';

export const ReasoningLevelEnum = z.enum(['low', 'default', 'high']);

export const RuntimeIdEnum = z.enum(['claude-sdk', 'openai-agents']);

export const ProviderTypeEnum = z.enum([
  'anthropic',
  'ollama',
  'lmstudio',
  'openai',
  'openrouter',
  'openai-compatible',
]);

/**
 * Provider override wire shape.
 *
 * `apiKey` is intentionally not accepted here — secrets must flow through
 * `.myco/secrets.env` and provider-specific env vars, never through an API
 * body (feedback_secrets_not_in_yaml). `baseUrl` is parsed for all provider
 * types but is stripped by the run handler for `openai` and `openrouter`
 * before it can reach the runtime, so the daemon's bearer key cannot be
 * redirected to an attacker-controlled host.
 */
export const ProviderOverrideWireSchema = z.object({
  runtime: RuntimeIdEnum.optional(),
  type: ProviderTypeEnum,
  localBackend: z.enum(['ollama', 'lmstudio']).optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  reasoningMap: z.object({
    low: z.string().optional(),
    default: z.string().optional(),
    high: z.string().optional(),
  }).optional(),
  contextLength: z.number().int().positive().optional(),
});

/** `{reasoningLevel?, model?, provider?, maxTurns?}` shape for per-phase pins. */
export const PhaseExecutionOverrideBody = z.object({
  reasoningLevel: ReasoningLevelEnum.optional(),
  model: z.string().optional(),
  provider: ProviderOverrideWireSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
});

/**
 * Full per-run execution overrides. Used by the agent-runs handler (as
 * `AgentRunBody.executionOverrides`) and indirectly by the evaluations
 * fanout (per-cell overrides are derived from the matrix dimensions plus
 * the shared `phases` overlay).
 */
export const ExecutionOverrideBody = z.object({
  runtime: RuntimeIdEnum.optional(),
  reasoningLevel: ReasoningLevelEnum.optional(),
  model: z.string().optional(),
  provider: ProviderOverrideWireSchema.optional(),
  phases: z.record(z.string(), PhaseExecutionOverrideBody).optional(),
}).optional();
