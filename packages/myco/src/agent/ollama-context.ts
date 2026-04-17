/**
 * Ollama model context window management.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig } from './types.js';
import { DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS } from './context-windows.js';

/** Timeout for Ollama model pre-load request (ms). */
const OLLAMA_PRELOAD_TIMEOUT_MS = 30_000;

/**
 * Default context window for Ollama models when no `context_length` is
 * configured. 32K is comfortably larger than any current agent task prompt
 * (skill-generate's source-material payload is the worst case and stays
 * well under 16K) and dramatically smaller than the 128K–256K native
 * defaults modern Ollama models ship with — which would otherwise allocate
 * tens of GB of KV cache for context that is never filled.
 *
 * Override by setting `context_length` on the provider config, either
 * globally, per-task, or per-phase (all scopes are reconciled to a single
 * variant per model — see `resolveOllamaContextVariants`).
 */
export const DEFAULT_OLLAMA_CONTEXT_LENGTH = DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS;

/**
 * Ensure an Ollama model variant exists with the desired context length.
 *
 * The Anthropic-compatible endpoint (/v1/messages) always loads models at
 * default context — it ignores /api/chat preloads and API-created params.
 * The only reliable way is `ollama create` with a Modelfile containing
 * `PARAMETER num_ctx`. Creates a variant named `{model}-ctx{contextLength}`.
 */
export async function ensureOllamaContextVariant(
  model: string,
  contextLength: number,
): Promise<string> {

  const baseName = model.replace(/:latest$/, '');
  const variantName = `${baseName}-ctx${contextLength}`;

  try {
    // Check if variant already exists
    execFileSync('ollama', ['show', variantName], { stdio: 'ignore' });
    return variantName;
  } catch {
    // Doesn't exist — create it
  }

  try {
    const modelfilePath = join(tmpdir(), `myco-modelfile-${Date.now()}`);
    writeFileSync(modelfilePath, `FROM ${model}\nPARAMETER num_ctx ${contextLength}\n`);
    execFileSync('ollama', ['create', variantName, '-f', modelfilePath], {
      stdio: 'ignore',
      timeout: OLLAMA_PRELOAD_TIMEOUT_MS,
    });
    try { unlinkSync(modelfilePath); } catch { /* cleanup best-effort */ }
    return variantName;
  } catch {
    return model; // Fall back to original
  }
}

// ---------------------------------------------------------------------------
// Unified variant resolution for task + phase scopes
// ---------------------------------------------------------------------------

/**
 * Per-phase provider override shape. Mirrors the record passed through
 * `runAgent` → `executePhasedQuery`; kept here so the ollama-context module
 * doesn't have to import executor-internal types.
 */
export interface PhaseProviderOverride {
  provider?: ProviderConfig;
  maxTurns?: number;
}

/**
 * Resolve every Ollama model referenced by a task run into a single variant
 * per (model) pair and return rewritten providers that point at those
 * variants.
 *
 * Why this exists at all:
 *   - The runtime default for gemma4:26b and similar modern Ollama models
 *     is 128K–256K tokens, which allocates tens of GB of KV cache for
 *     context we never come close to filling. Applying a sensible default
 *     (32K) on behalf of users who haven't set `context_length` recovers
 *     that VRAM without changing anything else.
 *   - Historically the variant-creation call only ran at the task scope,
 *     so a phase override that pointed at a different Ollama model bypassed
 *     the variant logic entirely and loaded at native default.
 *   - If the same model is referenced at multiple scopes with different
 *     `context_length` values, creating a variant per scope would load the
 *     same base model multiple times. That's the failure mode this function
 *     prevents — one (model) → one variant → one Ollama load per run.
 *
 * Reconciliation rule: when the same model appears with different
 * `context_length` values across scopes, the MAX is used. This guarantees
 * every call site has at least as much context as it asked for, at the cost
 * of slightly more VRAM than the smallest-asking scope requested. Users who
 * want scope-specific contexts should use different *models*, not different
 * context values on the same model.
 *
 * Providers that aren't Ollama (cloud, lmstudio) and providers without a
 * resolved model name pass through unchanged.
 */
export async function resolveOllamaContextVariants(
  taskProvider: ProviderConfig | undefined,
  phaseOverrides: Record<string, PhaseProviderOverride>,
  // Injected variant creator for testability. Defaults to the real
  // `ensureOllamaContextVariant` which shells out to `ollama`; tests pass
  // a pure stub so the logic can be exercised without the CLI.
  createVariant: (model: string, contextLength: number) => Promise<string> = ensureOllamaContextVariant,
): Promise<{
  taskProvider: ProviderConfig | undefined;
  phaseOverrides: Record<string, PhaseProviderOverride>;
  conflicts: Array<{ model: string; values: number[]; resolved: number }>;
}> {
  // --- Pass 1: collect ---------------------------------------------------
  // For each Ollama model we find, track every distinct context value we
  // saw for it. We need the full set (not just a running max) so we can
  // report conflicts afterwards.
  const seen = new Map<string, Set<number>>();

  const recordOllama = (p: ProviderConfig | undefined): void => {
    if (p?.type !== 'ollama' || !p.model) return;
    const ctx = p.contextLength ?? DEFAULT_OLLAMA_CONTEXT_LENGTH;
    const set = seen.get(p.model) ?? new Set<number>();
    set.add(ctx);
    seen.set(p.model, set);
  };

  recordOllama(taskProvider);
  for (const override of Object.values(phaseOverrides)) {
    recordOllama(override.provider);
  }

  // No Ollama providers at all — pass through unchanged.
  if (seen.size === 0) {
    return { taskProvider, phaseOverrides, conflicts: [] };
  }

  // --- Pass 2: reconcile -------------------------------------------------
  const resolvedContext = new Map<string, number>();
  const conflicts: Array<{ model: string; values: number[]; resolved: number }> = [];
  for (const [model, values] of seen) {
    const sorted = [...values].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1];
    resolvedContext.set(model, max);
    if (sorted.length > 1) {
      conflicts.push({ model, values: sorted, resolved: max });
    }
  }

  // --- Pass 3: create variants in parallel -------------------------------
  const variantEntries = await Promise.all(
    [...resolvedContext.entries()].map(async ([model, ctx]) => {
      const variant = await createVariant(model, ctx);
      return [model, variant] as const;
    }),
  );
  const variantByModel = new Map(variantEntries);

  // --- Pass 4: rewrite providers -----------------------------------------
  const rewriteProvider = (p: ProviderConfig | undefined): ProviderConfig | undefined => {
    if (!p) return p;
    if (p.type !== 'ollama' || !p.model) return p;
    const variant = variantByModel.get(p.model);
    const resolvedCtx = resolvedContext.get(p.model);
    if (!variant) return p;
    // Preserve the resolved context_length on the rewritten provider so
    // downstream code (env var builders, diagnostics) sees the effective
    // value rather than undefined. Update the model to the variant name.
    return { ...p, model: variant, contextLength: resolvedCtx };
  };

  const rewrittenPhaseOverrides: Record<string, PhaseProviderOverride> = {};
  for (const [name, override] of Object.entries(phaseOverrides)) {
    rewrittenPhaseOverrides[name] = {
      ...override,
      ...(override.provider ? { provider: rewriteProvider(override.provider) } : {}),
    };
  }

  return {
    taskProvider: rewriteProvider(taskProvider),
    phaseOverrides: rewrittenPhaseOverrides,
    conflicts,
  };
}
