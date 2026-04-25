/**
 * canopy-describe executor — single-shot LLM call for one CanopyEntry row.
 *
 * Pre-assembles a fixed prompt from the row's mechanical metadata plus the
 * first N lines of file content. The LLM never sees a tool surface; the
 * caller (run.ts) is responsible for post-processing, retries, and writes.
 *
 * Provider/model resolution looks at `agent.tasks['canopy-describe'].provider`
 * first, then falls back to `agent.provider`. Reasoning-tier comes from
 * `cortex.canopy.llm.reasoning_tier` (low | medium | high) and maps onto the
 * provider's `reasoning_map` (where the harness uses `low | default | high`,
 * so `medium` is treated as `default`).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CanopyEntry } from '@myco/db/schema.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { createLlmProvider, type LlmProvider } from '../../intelligence/llm.js';
import { loadPrompt } from '../../prompts/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanopyDescribeProviderConfig {
  provider: 'ollama' | 'lm-studio' | 'openai-compatible' | 'anthropic';
  model: string;
  base_url?: string;
  context_window?: number;
}

export interface CanopyDescribeExecutorContext {
  /** Active merged config — provider override resolution reads from here. */
  config: MycoConfig;
  /** Repo root used to resolve `entry.path` to an absolute file. */
  projectRoot: string;
  /**
   * Override the provider factory — primarily for tests. Default constructs
   * via `createLlmProvider` from `intelligence/llm.ts`.
   */
  llmFactory?: (cfg: CanopyDescribeProviderConfig) => LlmProvider;
}

export interface ExecutorInput {
  /** The canopy_entries row driving this run. */
  entry: CanopyEntry;
}

export interface ExecutorOutput {
  /** Raw LLM text — pre-post-process. */
  raw: string;
  /** Resolved model identifier — recorded for observability. */
  model: string;
}

// Number of leading file lines included in the prompt. The spec also mentions
// "middle M lines" but for one-sentence summaries the head is overwhelmingly
// the strongest signal; expanding the window blows the local-model context
// budget without improving output. Keep it tight by default.
const FIRST_LINES = 60;

// Generation budget — well above the per-description char cap so post-process
// can truncate cleanly. Local models often emit a leading explanation token
// or two before the actual sentence; we want enough headroom that the cap
// doesn't cut mid-word.
const GENERATION_MAX_TOKENS = 256;

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the provider config for canopy-describe from MycoConfig. Returns
 * null if no provider is configured — the caller must treat that as a no-op
 * (consistent with `cortex.canopy.llm.enabled` being effectively unusable
 * without a provider).
 */
export function resolveProviderConfig(config: MycoConfig): CanopyDescribeProviderConfig | null {
  const taskOverride = config.agent.tasks?.['canopy-describe']?.provider;
  const globalOverride = config.agent.provider;
  const provider = taskOverride ?? globalOverride;
  if (!provider) return null;

  const tier = config.cortex.canopy.llm.reasoning_tier;
  // Provider's reasoning_map keys are low | default | high; the LLM tier is
  // low | medium | high. Treat medium as the default tier so existing per-
  // provider model mappings continue to work without an extra "medium" key.
  const tierKey = tier === 'medium' ? 'default' : tier;
  const model = provider.reasoning_map?.[tierKey] ?? provider.model;
  if (!model) return null;

  // intelligence/llm.ts uses dashed names; agent.provider.type uses
  // condensed forms. Translate.
  const providerName = mapProviderName(provider.type);
  if (!providerName) return null;

  return {
    provider: providerName,
    model,
    base_url: provider.base_url,
    context_window: provider.context_length,
  };
}

function mapProviderName(
  type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible',
): CanopyDescribeProviderConfig['provider'] | null {
  switch (type) {
    case 'ollama':
      return 'ollama';
    case 'lmstudio':
      return 'lm-studio';
    case 'anthropic':
      return 'anthropic';
    case 'openai-compatible':
      return 'openai-compatible';
    // OpenAI / OpenRouter run through the agent harness, not the
    // intelligence/llm.ts shim — bail out so the caller can skip cleanly.
    case 'openai':
    case 'openrouter':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

interface PromptVars {
  budget: string;
  path: string;
  language: string;
  exports: string;
  imports: string;
  top_comment: string;
  first_n: string;
  first_lines: string;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function readFirstLines(absolutePath: string, limit: number): Promise<string> {
  // Read the whole file then slice. Files large enough to make this expensive
  // are excluded by the scanner's size ceiling, so a streaming reader would
  // be premature optimization.
  let content: string;
  try {
    content = await fs.readFile(absolutePath, 'utf-8');
  } catch {
    return '';
  }
  return content.split(/\r?\n/).slice(0, limit).join('\n');
}

export async function assemblePrompt(
  entry: CanopyEntry,
  budget: number,
  projectRoot: string,
  templateName = 'canopy-describe',
): Promise<string> {
  const exports = parseJsonArray(entry.exports_json);
  const imports = parseJsonArray(entry.imports_json);
  const firstLines = await readFirstLines(join(projectRoot, entry.path), FIRST_LINES);

  const vars: PromptVars = {
    budget: String(budget),
    path: entry.path,
    language: entry.language ?? 'unknown',
    exports: exports.length > 0 ? exports.join(', ') : '(none)',
    imports: imports.length > 0 ? imports.join(', ') : '(none)',
    top_comment: entry.top_comment?.trim() || '(none)',
    first_n: String(FIRST_LINES),
    first_lines: firstLines || '(empty)',
  };

  let template = loadPrompt(templateName);
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  return template;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single canopy-describe LLM call for one entry. Returns the raw text
 * before post-processing.
 *
 * Throws if no provider is configured — the caller (run.ts) should treat
 * that as a soft no-op for the whole task rather than a per-row failure.
 */
export async function runDescriber(
  input: ExecutorInput,
  ctx: CanopyDescribeExecutorContext,
): Promise<ExecutorOutput> {
  const providerConfig = resolveProviderConfig(ctx.config);
  if (!providerConfig) {
    throw new Error('canopy-describe: no provider configured (set agent.provider or agent.tasks["canopy-describe"].provider)');
  }

  const prompt = await assemblePrompt(
    input.entry,
    ctx.config.cortex.canopy.llm.max_description_chars,
    ctx.projectRoot,
    ctx.config.cortex.canopy.llm.prompt_ref,
  );

  const llm = ctx.llmFactory
    ? ctx.llmFactory(providerConfig)
    : createLlmProvider(providerConfig);

  const response = await llm.summarize(prompt, {
    maxTokens: GENERATION_MAX_TOKENS,
    contextLength: providerConfig.context_window,
    // Suppress chain-of-thought when supported — descriptions are one
    // sentence, reasoning traces just bloat the response.
    reasoning: 'off',
  });

  return { raw: response.text, model: response.model };
}
