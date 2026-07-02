/**
 * Shared per-tier VALUE schemas for reasoning-level provider overrides.
 *
 * `config/schema.ts` (snake_case `ProviderOverrideSchema`, classic `zod`
 * entry point) and `agent/schemas.ts` (camelCase `ProviderConfigSchema`,
 * `zod/v4` entry point) both define a `{low, default, high}`-keyed map whose
 * VALUES are one of these two shapes:
 *   - thinking-budget: `{ budgetTokens: number }` or `{ adaptive: true }`
 *   - effort: `{ effort?, verbosity? }`
 *
 * Only the tier VALUE shape lives here — the field-name casing
 * (`thinking_budget_map` vs `thinkingBudgetMap`) and the per-tier key
 * structure stay local to each file, since that's exactly where the two
 * schemas diverge.
 *
 * Built with `zod/v4` (same as `agent/schemas.ts`); `config/schema.ts`'s
 * classic `zod` import and this module's `zod/v4` import resolve to the
 * same underlying zod-core in this zod version (v4.4.3), so schemas built
 * with either entry point compose freely — verified by
 * `packages/myco/src/config/schema.test.ts`.
 *
 * Lives under `agent/` (not `config/`) because `config/schema.ts` already
 * imports from `agent/schemas.ts` (for `ReasoningLevelSchema` /
 * `HarnessIdSchema`); `agent/schemas.ts` never imports from `config/schema.ts`,
 * so this keeps the existing one-way dependency direction intact.
 */

import { z } from 'zod/v4';

/**
 * Anthropic's API rejects a thinking budget below 1024 tokens — this is the
 * documented minimum, not an arbitrary floor. The 128000 ceiling guards
 * against config typos (e.g. an extra zero) that would silently burn spend
 * on every phase run using that tier.
 */
export const ThinkingBudgetValueSchema = z.union([
  z.object({ budgetTokens: z.number().int().min(1024).max(128000) }),
  z.object({ adaptive: z.literal(true) }),
]);

export const EffortValueSchema = z.object({
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  verbosity: z.enum(['low', 'medium', 'high']).optional(),
});
