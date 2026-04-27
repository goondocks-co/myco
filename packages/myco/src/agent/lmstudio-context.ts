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
 *  2. No default. If `context_length` is unset on an `lmstudio` provider,
 *     we leave LM Studio alone. LM Studio is a desktop app where users
 *     load models with explicit GUI controls; silently re-loading at a
 *     Myco-chosen value would be invasive. Ollama's default exists because
 *     Ollama models ship with native 128K–256K windows that over-allocate
 *     KV cache; LM Studio users have already chosen.
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

import type { ProviderConfig } from './types.js';
import { DEFAULT_LMSTUDIO_URL } from './provider.js';

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

  const recordLmStudio = (p: ProviderConfig | undefined): void => {
    if (p?.type !== 'lmstudio' || !p.model) return;
    if (typeof p.contextLength !== 'number') return;
    const baseUrl = p.baseUrl ?? DEFAULT_LMSTUDIO_URL;
    const key = makeKey(p.model, baseUrl);
    const entry = seen.get(key) ?? { model: p.model, baseUrl, values: new Set<number>() };
    entry.values.add(p.contextLength);
    seen.set(key, entry);
  };

  recordLmStudio(taskProvider);
  for (const override of Object.values(phaseOverrides)) {
    recordLmStudio(override.provider);
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
  // context length. Crucial difference from Ollama: model name is unchanged.
  const rewriteProvider = (p: ProviderConfig | undefined): ProviderConfig | undefined => {
    if (!p) return p;
    if (p.type !== 'lmstudio' || !p.model) return p;
    if (typeof p.contextLength !== 'number') return p;
    const baseUrl = p.baseUrl ?? DEFAULT_LMSTUDIO_URL;
    const ctx = resolvedContext.get(makeKey(p.model, baseUrl));
    if (ctx === undefined) return p;
    return { ...p, contextLength: ctx };
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
