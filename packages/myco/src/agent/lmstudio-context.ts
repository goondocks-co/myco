/**
 * LM Studio model context window management.
 *
 * Mirrors the shape of `ollama-context.ts` (per-model setup +
 * cross-scope orchestration with max-wins reconciliation), but differs in
 * two ways that are intentional:
 *
 *  1. No model rename. LM Studio applies `context_length` to the running
 *     instance; the model identifier the agent sends to the
 *     Anthropic-compatible endpoint stays unchanged. We mutate LM Studio's
 *     server-side state, not the provider's `model` field.
 *
 *  2. Default applies. When `context_length` is unset on an `lmstudio`
 *     provider, we use `DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS` (32K).
 *     This matches the Ollama default — the constant is the contract for
 *     all local providers in Myco, and Myco's typical agent prompts
 *     (especially batch tasks like canopy-describe) routinely exceed the
 *     4K window LM Studio loads with by default.
 *
 * Failure semantics: load failures (network, 4xx/5xx, timeout) log a
 * warning and pass the provider through unchanged. The agent run still
 * proceeds; LM Studio may have the model already loaded at adequate
 * context, and we don't want to bury a working configuration on a
 * transient API hiccup.
 *
 * REST contract (https://lmstudio.ai/docs/developer/rest/load):
 *   POST {baseUrl}/api/v1/models/load
 *     body: { "model": string, "context_length"?: number, ... }
 *     200 → { type, instance_id, load_time_seconds, status: "loaded", ... }
 *   GET  {baseUrl}/api/v1/models
 *     200 → { models: [{ key, max_context_length, loaded_instances: [{ config: { context_length } }], ... }] }
 */

import type { ProviderConfig, ReasoningLevel } from './types.js';
import { DEFAULT_LMSTUDIO_URL } from './provider.js';
import { DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS } from './context-windows.js';
import { resolveReasoningModel } from './reasoning-levels.js';

/** Timeout for an LM Studio model load request (ms). */
const LMSTUDIO_LOAD_TIMEOUT_MS = 60_000;

/** Timeout for the cheaper list-models query used to short-circuit loads (ms). */
const LMSTUDIO_LIST_TIMEOUT_MS = 5_000;

interface LmStudioLoadedInstanceConfig {
  context_length?: number;
}

interface LmStudioLoadedInstance {
  config?: LmStudioLoadedInstanceConfig;
}

interface LmStudioModelEntry {
  key?: string;
  loaded_instances?: LmStudioLoadedInstance[];
}

interface LmStudioListResponse {
  models?: LmStudioModelEntry[];
}

/** Fetch wrapper that aborts after `timeoutMs`. */
export type TimedFetch = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

const defaultTimedFetch: TimedFetch = async (url, init, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Query LM Studio's loaded-models list. Returns the largest
 * `context_length` already loaded for the given model, or `null` when the
 * model has no loaded instances or the request fails.
 *
 * Used as a best-effort optimisation: when an instance is already loaded
 * at adequate context, the load call is skipped.
 */
async function queryLoadedContextLength(
  model: string,
  rootUrl: string,
  fetchImpl: TimedFetch,
): Promise<number | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${rootUrl}/api/v1/models`, { method: 'GET' }, LMSTUDIO_LIST_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: LmStudioListResponse;
  try {
    body = (await response.json()) as LmStudioListResponse;
  } catch {
    return null;
  }

  const entry = body.models?.find((m) => m.key === model);
  if (!entry?.loaded_instances?.length) return null;

  let maxLoaded = 0;
  for (const inst of entry.loaded_instances) {
    const ctx = inst.config?.context_length;
    if (typeof ctx === 'number' && ctx > maxLoaded) maxLoaded = ctx;
  }
  return maxLoaded > 0 ? maxLoaded : null;
}

/**
 * Ensure LM Studio has the given model loaded with at least
 * `contextLength` tokens of context.
 *
 * Returns `true` when the model is loaded at >= contextLength and `false`
 * when we couldn't confirm. Never throws.
 */
export async function ensureLmStudioModelLoaded(
  model: string,
  contextLength: number,
  baseUrl: string = DEFAULT_LMSTUDIO_URL,
  fetchImpl: TimedFetch = defaultTimedFetch,
): Promise<boolean> {
  const root = baseUrl.replace(/\/$/, '');

  const loadedCtx = await queryLoadedContextLength(model, root, fetchImpl);
  if (loadedCtx !== null && loadedCtx >= contextLength) return true;

  try {
    const response = await fetchImpl(
      `${root}/api/v1/models/load`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, context_length: contextLength }),
      },
      LMSTUDIO_LOAD_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
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

/**
 * Resolve every LM Studio model referenced by a task run into a single
 * load operation per (model, baseUrl) pair.
 *
 * Reconciliation rule (matches ollama-context.ts): when the same model
 * appears with different `context_length` values across scopes, the MAX is
 * used. This guarantees every call site has at least as much context as it
 * asked for.
 *
 * Providers without `contextLength` set pass through untouched — see the
 * file header for why we don't apply a default for LM Studio.
 *
 * Non-lmstudio providers and providers without a resolved model name pass
 * through unchanged.
 */
export async function resolveLmStudioContextLoads(
  taskProvider: ProviderConfig | undefined,
  phaseOverrides: Record<string, PhaseProviderOverride>,
  loadModel: (
    model: string,
    contextLength: number,
    baseUrl: string,
  ) => Promise<boolean> = ensureLmStudioModelLoaded,
  taskReasoningLevel?: ReasoningLevel,
): Promise<{
  taskProvider: ProviderConfig | undefined;
  phaseOverrides: Record<string, PhaseProviderOverride>;
  conflicts: Array<{ model: string; values: number[]; resolved: number }>;
}> {
  // Pass 1: collect (model, baseUrl) → set<contextLength>. We key on the
  // pair so two LM Studio instances on different ports get distinct loads.
  type Key = string;
  const makeKey = (model: string, baseUrl: string): Key => `${baseUrl}\0${model}`;
  const seen = new Map<Key, { model: string; baseUrl: string; values: Set<number> }>();

  const recordLmStudio = (p: ProviderConfig | undefined, level: ReasoningLevel | undefined): void => {
    if (p?.type !== 'lmstudio') return;
    // Resolve the actual model that will be used at run time, not the
    // static provider.model field. With reasoning_map configured, the
    // run uses reasoningMap[level], NOT provider.model — pre-loading
    // provider.model wastes a load on a model the run never invokes.
    const model = resolveReasoningModel(level, p, p.model ?? '');
    if (!model) return;
    const ctx = p.contextLength ?? DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS;
    const baseUrl = p.baseUrl ?? DEFAULT_LMSTUDIO_URL;
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

  // Pass 3: load in parallel. Failures are swallowed (logged by caller via
  // conflicts? — no, ensureLmStudioModelLoaded returns false). We still
  // emit the rewrite in pass 4: the contextLength carried on the provider
  // is informational; load success/failure doesn't change the provider
  // shape the agent uses to talk to LM Studio.
  await Promise.all(
    [...resolvedContext.entries()].map(async ([key, ctx]) => {
      const entry = seen.get(key);
      if (!entry) return;
      await loadModel(entry.model, ctx, entry.baseUrl);
    }),
  );

  // Pass 4: rewrite providers so downstream code sees the reconciled
  // context length. Looks up by the reasoning-resolved model, mirroring
  // Pass 1's keying.
  const rewriteProvider = (
    p: ProviderConfig | undefined,
    level: ReasoningLevel | undefined,
  ): ProviderConfig | undefined => {
    if (!p) return p;
    if (p.type !== 'lmstudio') return p;
    const model = resolveReasoningModel(level, p, p.model ?? '');
    if (!model) return p;
    const baseUrl = p.baseUrl ?? DEFAULT_LMSTUDIO_URL;
    const ctx = resolvedContext.get(makeKey(model, baseUrl));
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
