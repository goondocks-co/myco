/**
 * LM Studio model context orchestration for a task run.
 *
 * Mirrors the shape of `ollama-context.ts` (per-model setup + cross-scope
 * orchestration with max-wins reconciliation). The actual load/reuse
 * mechanics live in `intelligence/lmstudio-instances.ts` — the single
 * shared ensure-loaded path with single-flight and the converge-to-one
 * instance policy; this module only decides WHICH (model, endpoint,
 * context length) tuples a run needs.
 *
 * Two intentional differences from the Ollama resolver:
 *
 *  1. No model rename. LM Studio applies `context_length` to the running
 *     instance; the model identifier the agent sends stays unchanged.
 *
 *  2. Default applies. When `context_length` is unset on an LM Studio
 *     provider, `DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS` (32K) is used.
 *     The constant is the contract for all local providers in Myco, and
 *     Myco's typical agent prompts (especially batch tasks like
 *     canopy-describe) routinely exceed the 4K window LM Studio loads
 *     with by default.
 *
 * Providers are recognized via `inferLocalOpenAIBackendKind`, not a bare
 * `type === 'lmstudio'` check — an `openai-compatible` provider pointed at
 * an LM Studio port is the same server and needs the same instance
 * management.
 *
 * Failure semantics: load failures log inside the shared helper and the
 * provider passes through unchanged. The agent run still proceeds;
 * LM Studio may JIT-load on the chat request, and a dead endpoint fails
 * the run with a clearer error at chat time.
 */

import type { ProviderConfig, ReasoningLevel } from './types.js';
import { DEFAULT_LMSTUDIO_URL } from './provider.js';
import { DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS } from './context-windows.js';
import { resolveReasoningModel } from './reasoning-levels.js';
import {
  ensureLmStudioModelInstance,
  normalizeLmStudioControlUrl,
  type LmStudioWarn,
} from '../intelligence/lmstudio-instances.js';
import { inferLocalOpenAIBackendKind } from '../intelligence/local-openai-backends.js';

/**
 * Ensure LM Studio has the given model loaded with at least
 * `contextLength` tokens of context. Thin wrapper over the shared
 * single-flight helper; kept as the injectable seam for tests and as the
 * executor-path entry point.
 *
 * Returns `true` when an instance is confirmed loaded and `false` when we
 * couldn't confirm. Never throws.
 */
export async function ensureLmStudioModelLoaded(
  model: string,
  contextLength: number,
  baseUrl: string = DEFAULT_LMSTUDIO_URL,
  warn?: LmStudioWarn,
): Promise<boolean> {
  const result = await ensureLmStudioModelInstance({ baseUrl, model, contextLength, warn });
  return result.loaded;
}

// ---------------------------------------------------------------------------
// Cross-scope resolution for task + phase scopes
// ---------------------------------------------------------------------------

/**
 * Per-phase provider override shape. Mirrors the type used by the Ollama
 * resolver so callers can use the same shape for both.
 */
export interface PhaseProviderOverride {
  provider?: ProviderConfig;
  maxTurns?: number;
  reasoningLevel?: ReasoningLevel;
}

function isLmStudioProvider(p: ProviderConfig | undefined): p is ProviderConfig {
  if (!p) return false;
  return inferLocalOpenAIBackendKind({
    type: p.type,
    localBackend: p.localBackend,
    baseUrl: p.baseUrl,
  }) === 'lmstudio';
}

/**
 * Resolve every LM Studio model referenced by a task run into a single
 * load operation per (model, endpoint) pair.
 *
 * Reconciliation rule (matches ollama-context.ts): when the same model
 * appears with different `context_length` values across scopes, the MAX is
 * used. This guarantees every call site has at least as much context as it
 * asked for.
 *
 * Non-LM-Studio providers and providers without a resolved model name pass
 * through unchanged.
 */
export async function resolveLmStudioContextLoads(
  taskProvider: ProviderConfig | undefined,
  phaseOverrides: Record<string, PhaseProviderOverride>,
  loadModel?: (
    model: string,
    contextLength: number,
    baseUrl: string,
  ) => Promise<boolean>,
  taskReasoningLevel?: ReasoningLevel,
  warn?: LmStudioWarn,
): Promise<{
  taskProvider: ProviderConfig | undefined;
  phaseOverrides: Record<string, PhaseProviderOverride>;
  conflicts: Array<{ model: string; values: number[]; resolved: number }>;
}> {
  const load = loadModel
    ?? ((model: string, contextLength: number, baseUrl: string) =>
      ensureLmStudioModelLoaded(model, contextLength, baseUrl, warn));

  // Pass 1: collect (model, endpoint) → set<contextLength>. We key on the
  // pair so two LM Studio instances on different ports get distinct loads.
  // The endpoint is normalized to its control root so `http://host:1234`
  // and `http://host:1234/v1` key (and load) identically.
  type Key = string;
  const makeKey = (model: string, baseUrl: string): Key => `${baseUrl}\0${model}`;
  const seen = new Map<Key, { model: string; baseUrl: string; values: Set<number> }>();

  const resolveControlUrl = (p: ProviderConfig): string =>
    normalizeLmStudioControlUrl(p.baseUrl ?? DEFAULT_LMSTUDIO_URL);

  const recordLmStudio = (p: ProviderConfig | undefined, level: ReasoningLevel | undefined): void => {
    if (!isLmStudioProvider(p)) return;
    // Resolve the actual model that will be used at run time, not the
    // static provider.model field. With reasoning_map configured, the
    // run uses reasoningMap[level], NOT provider.model — pre-loading
    // provider.model wastes a load on a model the run never invokes.
    const model = resolveReasoningModel(level, p, p.model ?? '');
    if (!model) return;
    const ctx = p.contextLength ?? DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS;
    const baseUrl = resolveControlUrl(p);
    const key = makeKey(model, baseUrl);
    const entry = seen.get(key) ?? { model, baseUrl, values: new Set<number>() };
    entry.values.add(ctx);
    seen.set(key, entry);
  };

  recordLmStudio(taskProvider, taskReasoningLevel);
  for (const override of Object.values(phaseOverrides)) {
    recordLmStudio(override.provider, override.reasoningLevel ?? taskReasoningLevel);
  }

  if (seen.size === 0) {
    return { taskProvider, phaseOverrides, conflicts: [] };
  }

  // Pass 2: reconcile (max wins) and surface conflicts.
  const resolvedContext = new Map<Key, number>();
  const conflicts: Array<{ model: string; values: number[]; resolved: number }> = [];
  for (const [key, entry] of seen) {
    const sorted = [...entry.values].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1];
    resolvedContext.set(key, max);
    if (sorted.length > 1) {
      conflicts.push({ model: entry.model, values: sorted, resolved: max });
    }
  }

  // Pass 3: load in parallel. Failures are logged by the shared helper;
  // we still emit the rewrite in pass 4: the contextLength carried on the
  // provider is informational; load success/failure doesn't change the
  // provider shape the agent uses to talk to LM Studio.
  await Promise.all(
    [...resolvedContext.entries()].map(async ([key, ctx]) => {
      const entry = seen.get(key);
      if (!entry) return;
      await load(entry.model, ctx, entry.baseUrl);
    }),
  );

  // Pass 4: rewrite providers so downstream code sees the reconciled
  // context length. Looks up by the reasoning-resolved model, mirroring
  // Pass 1's keying.
  const rewriteProvider = (
    p: ProviderConfig | undefined,
    level: ReasoningLevel | undefined,
  ): ProviderConfig | undefined => {
    if (!isLmStudioProvider(p)) return p;
    const model = resolveReasoningModel(level, p, p.model ?? '');
    if (!model) return p;
    const ctx = resolvedContext.get(makeKey(model, resolveControlUrl(p)));
    if (ctx === undefined) return p;
    return { ...p, contextLength: ctx };
  };

  const rewrittenPhaseOverrides: Record<string, PhaseProviderOverride> = {};
  for (const [name, override] of Object.entries(phaseOverrides)) {
    const level = override.reasoningLevel ?? taskReasoningLevel;
    rewrittenPhaseOverrides[name] = {
      ...override,
      ...(override.provider ? { provider: rewriteProvider(override.provider, level) } : {}),
    };
  }

  return {
    taskProvider: rewriteProvider(taskProvider, taskReasoningLevel),
    phaseOverrides: rewrittenPhaseOverrides,
    conflicts,
  };
}
