import { isLocalProvider } from './provider.js';
import type { ProviderConfig, ReasoningLevel } from './types.js';

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'default';

export function resolveReasoningModel(
  reasoningLevel: ReasoningLevel | undefined,
  provider: ProviderConfig | undefined,
  fallbackModel: string,
): string {
  const level = reasoningLevel ?? DEFAULT_REASONING_LEVEL;
  return provider?.reasoningMap?.[level]
    ?? provider?.model
    ?? fallbackModel;
}

// ---------------------------------------------------------------------------
// Claude thinking-budget resolution
// ---------------------------------------------------------------------------

/** Mirrors the Claude Agent SDK's `ThinkingConfig` union (sdk.d.ts, v0.3.195). */
export type ThinkingConfigResolution =
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' };

/**
 * Default reasoningLevel -> Claude ThinkingConfig mapping.
 *
 * `low` uses a small fixed budget (fast, cheap, still genuinely extended
 * thinking). `default` uses adaptive thinking — Claude decides depth per
 * turn, which fits Myco's phases better than a single fixed number since
 * per-turn complexity varies widely even within one tier. `high` uses a
 * large fixed budget reserved for the few phases that need opus-grade
 * depth (tune-agent-task-cost Pattern 6: use `high` sparingly).
 *
 * Deep-frozen (map + each row) because these row objects are handed to the
 * Claude SDK by reference (`resolveThinkingConfig` returns them directly,
 * and `runClaudeQuery` passes the result straight into `query()`'s
 * `thinking:` option). Freezing makes any future SDK-side mutation of a
 * returned row throw immediately in strict mode instead of silently
 * corrupting every subsequent call that resolves the same tier.
 */
const DEFAULT_THINKING_MAP: Record<ReasoningLevel, ThinkingConfigResolution> = Object.freeze({
  low: Object.freeze({ type: 'enabled', budgetTokens: 1024 }),
  default: Object.freeze({ type: 'adaptive' }),
  high: Object.freeze({ type: 'enabled', budgetTokens: 32000 }),
});

/**
 * Resolve a `reasoningLevel` + provider into a Claude SDK `ThinkingConfig`.
 *
 * Local providers (ollama/lmstudio/openai-compatible) always resolve to
 * `{ type: 'disabled' }` regardless of tier or `thinkingBudgetMap` — their
 * endpoints don't accept the SDK's thinking/reasoning fields. This is the
 * sole source of the `{ type: 'disabled' }` thinking config the Claude
 * harness's `runClaudeQuery` passes to `query()` for local providers.
 */
export function resolveThinkingConfig(
  reasoningLevel: ReasoningLevel | undefined,
  provider: ProviderConfig | undefined,
): ThinkingConfigResolution {
  if (isLocalProvider(provider)) return { type: 'disabled' };
  const level = reasoningLevel ?? DEFAULT_REASONING_LEVEL;
  const override = provider?.thinkingBudgetMap?.[level];
  if (override) {
    return 'adaptive' in override ? { type: 'adaptive' } : { type: 'enabled', budgetTokens: override.budgetTokens };
  }
  return DEFAULT_THINKING_MAP[level];
}

// ---------------------------------------------------------------------------
// OpenAI reasoning-effort / verbosity resolution
// ---------------------------------------------------------------------------

export type OpenAIReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAIVerbosity = 'low' | 'medium' | 'high';

export interface ModelSettingsResolution {
  reasoning: { effort: OpenAIReasoningEffort };
  text: { verbosity: OpenAIVerbosity };
}

/**
 * Default reasoningLevel -> OpenAI ModelSettings mapping (GPT-5-family
 * `reasoning.effort` / `text.verbosity`, per @openai/agents-core
 * `ModelSettings`, v0.12.0). `low`/`default`/`high` map onto the SDK's own
 * `low`/`medium`/`high` effort levels — deliberately not `'none'` for
 * `low`, since Myco's low tier still wants genuine (just cheap) reasoning,
 * not a reasoning-suppressed response.
 *
 * Deep-frozen (map + each row) for the same reason as `DEFAULT_THINKING_MAP`
 * above — these rows are handed to the OpenAI Agents SDK by reference via
 * `resolveModelSettings` -> `prepareOpenAIRun`'s `modelSettings`, which the
 * SDK's `Agent` stores directly. Freezing turns a future SDK mutation into
 * a loud failure instead of corrupting every subsequent run that resolves
 * the same tier.
 */
const DEFAULT_EFFORT_MAP: Record<ReasoningLevel, ModelSettingsResolution> = Object.freeze({
  low: Object.freeze({ reasoning: Object.freeze({ effort: 'low' }), text: Object.freeze({ verbosity: 'low' }) }),
  default: Object.freeze({ reasoning: Object.freeze({ effort: 'medium' }), text: Object.freeze({ verbosity: 'medium' }) }),
  high: Object.freeze({ reasoning: Object.freeze({ effort: 'high' }), text: Object.freeze({ verbosity: 'high' }) }),
});

/**
 * Resolve a `reasoningLevel` + provider into OpenAI `ModelSettings.reasoning`
 * / `ModelSettings.text` fields.
 *
 * Returns `undefined` for local providers (ollama/lmstudio/openai-compatible)
 * — most local backends don't parse GPT-5-style reasoning/verbosity params,
 * so the field is omitted entirely rather than sent with a value the backend
 * might reject or silently ignore.
 */
export function resolveModelSettings(
  reasoningLevel: ReasoningLevel | undefined,
  provider: ProviderConfig | undefined,
): ModelSettingsResolution | undefined {
  if (isLocalProvider(provider)) return undefined;
  const level = reasoningLevel ?? DEFAULT_REASONING_LEVEL;
  const override = provider?.effortMap?.[level];
  if (override) {
    return {
      reasoning: { effort: override.effort ?? DEFAULT_EFFORT_MAP[level].reasoning.effort },
      text: { verbosity: override.verbosity ?? DEFAULT_EFFORT_MAP[level].text.verbosity },
    };
  }
  return DEFAULT_EFFORT_MAP[level];
}
