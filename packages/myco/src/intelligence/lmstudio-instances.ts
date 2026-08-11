/**
 * LM Studio model-instance management — the single ensure-loaded path for
 * every Myco caller (agent executor pre-load, openai-agents harness, and
 * any future flow that talks to an LM Studio endpoint).
 *
 * Why this module exists (live-verified 2026-08-11):
 *
 *  1. `POST /api/v1/models/load` ALWAYS creates a new instance. It never
 *     reuses or resizes an existing one. Any caller that loads without an
 *     accurate "already loaded?" check leaks a ~full-model-size instance
 *     (`model`, `model:2`, `model:3`, ...) per call.
 *
 *  2. `GET /api/v1/models` reports `loaded_instances: []` on current
 *     LM Studio builds even while instances are loaded. The older
 *     `GET /api/v0/models` reports loaded state correctly (`state`,
 *     `loaded_context_length`, `:N`-suffixed instance ids). We therefore
 *     read v0 first and fall back to v1, logging loudly when the primary
 *     source looks rotted — a silent loaded-state source regression is
 *     exactly how the previous reuse-any fix decayed into an instance leak.
 *
 *  3. `POST /api/v1/models/load` has a strict body schema and rejects
 *     unknown keys (`ttl` → 400 unrecognized_keys), so idle auto-evict
 *     cannot be requested at load time. Instance count is bounded by the
 *     converge policy below instead.
 *
 * Policy — converge to ONE ready instance per (endpoint, model):
 *   - reuse the largest-context ready instance that satisfies the
 *     requested context length;
 *   - when nothing adequate is ready, load at the requested length FIRST
 *     and sweep the undersized instances afterwards — there is never a
 *     zero-instance gap, and an undersized instance is never silently
 *     reused (that would pin batch prompts to LM Studio's 4K default);
 *   - surplus ready instances are unloaded whenever they are observed,
 *     which also cleans up machines already poisoned by the leak;
 *   - instances still mid-load (v0 `state` neither loaded nor not-loaded)
 *     are never counted as adequate, never swept, and block a new load —
 *     the ensure reports not-loaded and the caller decides how loudly to
 *     fail.
 *   Residual race, accepted: a run pins its chat requests to the instance
 *   id its ensure chose; a LATER ensure needing a larger context (another
 *   task on the same endpoint, or another daemon) sweeps that instance
 *   after its replacement loads, and the pinned run's remaining requests
 *   fail loudly, recovering on its next run. Load-first ordering keeps
 *   that window small; never unloading at all would leak without bound,
 *   which is worse.
 *
 * Concurrency: ensure calls are single-flighted per (endpoint,
 * canonical model) via a module-level inflight map, so N concurrent agent
 * runs racing the check-then-load window share one load. The canonical
 * key strips the vendor prefix, so `openai/gpt-oss-20b` and
 * `gpt-oss-20b` — which the server treats as one model — share a flight.
 * A joiner needing a LARGER context than the flight it would join is
 * chained after it and re-ensured, never handed an undersized result.
 * NOTE: the map is process-local. All agent dispatch currently runs
 * inline in the daemon process (see runner-host.ts); if the planned
 * worker_threads execution-isolation backend lands, this map shards per
 * worker and the guarantee weakens — runner-host.ts documents the
 * coupling.
 */

import { createInstrumentedFetch } from '../utils/instrumented-fetch.js';

const instancesFetch = createInstrumentedFetch({
  component: 'intelligence.lmstudio-instances',
  responseHeadersTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
});

const ENDPOINT_MODELS_V0 = '/api/v0/models';
const ENDPOINT_MODELS_V1 = '/api/v1/models';
const ENDPOINT_MODELS_LOAD = '/api/v1/models/load';
const ENDPOINT_MODELS_UNLOAD = '/api/v1/models/unload';

/** Timeout for list queries — cheap, local, must not stall a run. */
const LIST_TIMEOUT_MS = 5_000;
/** Timeout for a load request — matches the LLM request ceiling; cold-loading a 20B model on a pressured machine can approach it. */
const LOAD_TIMEOUT_MS = 180_000;
/** Timeout for an unload request. */
const UNLOAD_TIMEOUT_MS = 30_000;

export type LmStudioWarn = (event: string, message: string, meta?: Record<string, unknown>) => void;

/** Fetch seam for tests: same shape the instrumented default provides. */
export type LmStudioTimedFetch = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

const defaultWarn: LmStudioWarn = (event, message, meta) => {
  console.warn(`[${event}] ${message}`, meta ?? '');
};

const defaultTimedFetch: LmStudioTimedFetch = async (url, init, timeoutMs) => {
  return instancesFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
};

/** A loaded instance as reported by the server, API-version agnostic. */
export interface LmStudioInstance {
  /** Instance identifier the unload endpoint and chat routing accept (v0-style, `:N`-suffixed). */
  id: string;
  /** Context length the instance was loaded with, when the API reports it. */
  contextLength: number | null;
  /** False while the server reports the instance mid-load (v0 `state` neither loaded nor not-loaded). */
  ready: boolean;
}

export interface EnsureLmStudioInstanceResult {
  /** Instance id to pin chat requests to, or null when nothing could be confirmed loaded. */
  instanceId: string | null;
  /** True when an instance satisfying the request is confirmed loaded. */
  loaded: boolean;
}

/**
 * Normalize a configured base URL to the control root the native API lives
 * under: strips a trailing `/v1` (OpenAI-compat path segment) and any
 * trailing slash, so `http://host:1234/v1` and `http://host:1234/` key and
 * route identically.
 */
export function normalizeLmStudioControlUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl.replace(/\/$/, '');
  }
  if (url.pathname === '/v1') {
    url.pathname = '/';
  } else if (url.pathname.startsWith('/v1/')) {
    url.pathname = url.pathname.slice('/v1'.length) || '/';
  }
  return url.toString().replace(/\/$/, '');
}

/** Strip an LM Studio duplicate-instance suffix: `gpt-oss-20b:2` → `gpt-oss-20b`. */
function stripInstanceSuffix(id: string): string {
  return id.replace(/:\d+$/, '');
}

/** Strip a `<vendor>/` prefix: `openai/gpt-oss-20b` → `gpt-oss-20b`. */
function stripVendorPrefix(model: string): string {
  const slashIndex = model.indexOf('/');
  return slashIndex === -1 ? model : model.slice(slashIndex + 1);
}

/**
 * Whether a server-reported model/instance id refers to the configured
 * model. Exact match (after `:N` stripping) wins. When exactly ONE side
 * carries a vendor prefix, comparison happens on the stripped form —
 * bridging the config-vs-v0 asymmetry (config `openai/gpt-oss-20b`, v0 id
 * `gpt-oss-20b`). When BOTH sides carry a prefix they must match exactly:
 * `lmstudio-community/qwen3-8b` and `unsloth/qwen3-8b` are different
 * artifacts (different quantizations) and must never alias, or the wrong
 * build gets reused — and worse, swept as "surplus".
 */
export function lmStudioModelMatches(serverId: string, configModel: string): boolean {
  const server = stripInstanceSuffix(serverId);
  if (server === configModel) return true;
  const serverHasPrefix = server.includes('/');
  const configHasPrefix = configModel.includes('/');
  if (serverHasPrefix === configHasPrefix) return false;
  return stripVendorPrefix(server) === stripVendorPrefix(configModel);
}

interface V0ModelEntry {
  id?: string;
  state?: string;
  loaded_context_length?: number;
}

interface V1LoadedInstance {
  id?: string;
  config?: { context_length?: number };
}

interface V1ModelEntry {
  key?: string;
  loaded_instances?: V1LoadedInstance[];
}

async function queryV0Instances(
  controlUrl: string,
  model: string,
  fetchImpl: LmStudioTimedFetch,
): Promise<LmStudioInstance[] | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${controlUrl}${ENDPOINT_MODELS_V0}`, { method: 'GET' }, LIST_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: { data?: V0ModelEntry[] };
  try {
    body = (await response.json()) as { data?: V0ModelEntry[] };
  } catch {
    return null;
  }
  if (!Array.isArray(body.data)) return null;
  const instances: LmStudioInstance[] = [];
  for (const entry of body.data) {
    if (!entry.id || !entry.state || entry.state === 'not-loaded') continue;
    if (!lmStudioModelMatches(entry.id, model)) continue;
    instances.push({
      id: entry.id,
      contextLength: typeof entry.loaded_context_length === 'number' ? entry.loaded_context_length : null,
      ready: entry.state === 'loaded',
    });
  }
  return instances;
}

async function queryV1Instances(
  controlUrl: string,
  model: string,
  fetchImpl: LmStudioTimedFetch,
): Promise<LmStudioInstance[] | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${controlUrl}${ENDPOINT_MODELS_V1}`, { method: 'GET' }, LIST_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: { models?: V1ModelEntry[] };
  try {
    body = (await response.json()) as { models?: V1ModelEntry[] };
  } catch {
    return null;
  }
  if (!Array.isArray(body.models)) return null;
  const instances: LmStudioInstance[] = [];
  // The catalog can list the same key more than once (one entry per
  // downloaded variant/format) — scan every matching entry, not the first.
  for (const entry of body.models) {
    if (!entry.key || !lmStudioModelMatches(entry.key, model)) continue;
    for (const inst of entry.loaded_instances ?? []) {
      if (!inst.id) continue;
      instances.push({
        id: inst.id,
        contextLength: typeof inst.config?.context_length === 'number' ? inst.config.context_length : null,
        ready: true,
      });
    }
  }
  return instances;
}

interface InstanceQueryResult {
  instances: LmStudioInstance[];
  /** False when neither list source answered — indistinguishable states must not trigger speculative loads. */
  available: boolean;
}

async function queryInstancesWithAvailability(
  baseUrl: string,
  model: string,
  warn: LmStudioWarn,
  fetchImpl: LmStudioTimedFetch,
): Promise<InstanceQueryResult> {
  const controlUrl = normalizeLmStudioControlUrl(baseUrl);
  const [v0, v1] = await Promise.all([
    queryV0Instances(controlUrl, model, fetchImpl),
    queryV1Instances(controlUrl, model, fetchImpl),
  ]);
  // v1 empty while v0 reports instances is the KNOWN v1 defect this module
  // works around — not worth a warning per ensure. The reverse (primary
  // source empty while the fallback sees instances) means v0 has rotted:
  // that's the disagreement worth surfacing.
  if (v0 !== null && v1 !== null && v0.length === 0 && v1.length > 0) {
    warn(
      'lmstudio.instances.source-disagreement',
      `LM Studio v0 model list reports no loaded instance of "${model}" while v1 reports ${v1.length} — trusting v1; the v0 loaded-state source may have regressed`,
      { model, baseUrl: controlUrl, v0Count: v0.length, v1Count: v1.length },
    );
  }
  if (v0 === null && v1 === null) {
    return { instances: [], available: false };
  }
  if (v0 !== null && v0.length > 0) return { instances: v0, available: true };
  if (v1 !== null && v1.length > 0) return { instances: v1, available: true };
  return { instances: [], available: true };
}

/**
 * Query loaded instances of `model`. v0 is the primary source (v1's
 * `loaded_instances` is unreliably empty — see module header); v1 fills in
 * only when v0 is unavailable.
 */
export async function queryLmStudioInstances(
  baseUrl: string,
  model: string,
  warn: LmStudioWarn = defaultWarn,
  fetchImpl: LmStudioTimedFetch = defaultTimedFetch,
): Promise<LmStudioInstance[]> {
  const result = await queryInstancesWithAvailability(baseUrl, model, warn, fetchImpl);
  return result.instances;
}

/** Unload a single instance. Failures are logged and swallowed. */
export async function unloadLmStudioInstance(
  baseUrl: string,
  instanceId: string,
  warn: LmStudioWarn = defaultWarn,
  fetchImpl: LmStudioTimedFetch = defaultTimedFetch,
): Promise<boolean> {
  const controlUrl = normalizeLmStudioControlUrl(baseUrl);
  try {
    const response = await fetchImpl(
      `${controlUrl}${ENDPOINT_MODELS_UNLOAD}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: instanceId }),
      },
      UNLOAD_TIMEOUT_MS,
    );
    if (!response.ok && response.status !== 404) {
      warn('lmstudio.instances.unload-failed', `LM Studio unload of "${instanceId}" returned ${response.status}`, {
        instanceId,
        baseUrl: controlUrl,
        status: response.status,
      });
    }
    // 404 means it's already gone (evicted or unloaded elsewhere) — success.
    return response.ok || response.status === 404;
  } catch (error) {
    warn('lmstudio.instances.unload-failed', `LM Studio unload of "${instanceId}" failed`, {
      instanceId,
      baseUrl: controlUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

interface InflightEnsure {
  promise: Promise<EnsureLmStudioInstanceResult>;
  /** Largest context length any joined caller has requested from this flight. */
  contextLength: number;
}

const inflightEnsures = new Map<string, InflightEnsure>();

export interface EnsureLmStudioInstanceOptions {
  baseUrl: string;
  model: string;
  contextLength: number;
  warn?: LmStudioWarn;
  fetchImpl?: LmStudioTimedFetch;
}

/**
 * Ensure one ready instance of `model` is loaded with at least
 * `contextLength` tokens of context, and return its id for chat pinning.
 *
 * Never throws: on any failure the result is `{ instanceId: null,
 * loaded: false }`. Callers decide the failure posture — the harness
 * treats not-loaded as a run-fatal error (silently proceeding would
 * JIT-load at LM Studio's ~4K default and truncate batch prompts into
 * garbage), while the executor pre-load is best-effort.
 */
export async function ensureLmStudioModelInstance(
  options: EnsureLmStudioInstanceOptions,
): Promise<EnsureLmStudioInstanceResult> {
  const controlUrl = normalizeLmStudioControlUrl(options.baseUrl);
  // Canonical key: vendor-prefix spellings of one model must share a
  // flight, or both spellings load "their own" instance — the exact leak
  // this module prevents — and their sweeps fight over the survivors.
  const key = `${controlUrl}\0${stripVendorPrefix(options.model)}`;

  const existing = inflightEnsures.get(key);
  if (existing) {
    if (options.contextLength <= existing.contextLength) {
      return existing.promise;
    }
    // A joiner needing MORE context than the in-flight ensure must not
    // accept its result — chain a fresh ensure behind it (still one flight
    // at a time per key, so no duplicate load race).
    const chained = existing.promise
      .catch(() => undefined)
      .then(() => ensureInstanceNow({ ...options, baseUrl: controlUrl }));
    const entry: InflightEnsure = { promise: chained, contextLength: options.contextLength };
    inflightEnsures.set(key, entry);
    try {
      return await chained;
    } finally {
      if (inflightEnsures.get(key) === entry) inflightEnsures.delete(key);
    }
  }

  const promise = ensureInstanceNow({ ...options, baseUrl: controlUrl });
  const entry: InflightEnsure = { promise, contextLength: options.contextLength };
  inflightEnsures.set(key, entry);
  try {
    return await promise;
  } finally {
    if (inflightEnsures.get(key) === entry) inflightEnsures.delete(key);
  }
}

async function ensureInstanceNow(
  options: EnsureLmStudioInstanceOptions,
): Promise<EnsureLmStudioInstanceResult> {
  const { baseUrl, model, contextLength } = options;
  const warn = options.warn ?? defaultWarn;
  const fetchImpl = options.fetchImpl ?? defaultTimedFetch;

  const { instances, available } = await queryInstancesWithAvailability(baseUrl, model, warn, fetchImpl);

  // Both list sources down is NOT "zero instances" — loading on that guess
  // would speculatively stack a full-model-size instance. Report
  // not-loaded and let the caller fail loudly.
  if (!available) {
    warn(
      'lmstudio.instances.state-unavailable',
      `LM Studio model lists are unreachable — cannot determine loaded state of "${model}"; skipping load`,
      { model, baseUrl },
    );
    return { instanceId: null, loaded: false };
  }

  // Reuse: the largest-context READY instance that satisfies the request.
  // An unknown context length on a ready instance counts as satisfying —
  // reuse-any beats spawning a duplicate, and the length is unreported
  // only when the API can't tell us anything better.
  const ready = instances.filter((inst) => inst.ready);
  const adequate = ready
    .filter((inst) => inst.contextLength === null || inst.contextLength >= contextLength)
    .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));

  if (adequate.length > 0) {
    const chosen = adequate[0];
    await unloadSurplus(baseUrl, ready, chosen.id, warn, fetchImpl);
    return { instanceId: chosen.id, loaded: true };
  }

  // An instance is still mid-load (GUI/JIT racing us): don't sweep it,
  // don't stack another load — report not-loaded and let the caller fail
  // loudly rather than pin a batch run to what may finish as a 4K window.
  const loading = instances.filter((inst) => !inst.ready);
  if (loading.length > 0) {
    warn(
      'lmstudio.instances.instance-still-loading',
      `LM Studio instance(s) of "${model}" are still loading — cannot confirm an adequate instance for this run`,
      { model, baseUrl, loading: loading.map((i) => i.id) },
    );
    return { instanceId: null, loaded: false };
  }

  if (ready.length > 0) {
    warn(
      'lmstudio.instances.replacing-undersized',
      `LM Studio instance(s) of "${model}" loaded below the requested ${contextLength}-token context — loading a replacement`,
      { model, baseUrl, contextLength, existing: ready.map((i) => ({ id: i.id, contextLength: i.contextLength })) },
    );
  }

  // Load FIRST, sweep after: the undersized instances stay valid while
  // the replacement loads (no zero-instance gap for runs pinned to them),
  // and the post-load sweep below removes them. Transiently two instances
  // exist — bounded, and strictly better than "unload first" stranding
  // every pinned run the moment the unload lands.
  let loadedId: string | null = null;
  try {
    const response = await fetchImpl(
      `${baseUrl}${ENDPOINT_MODELS_LOAD}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // flash_attention is a llama.cpp-engine hint; other engines ignore it.
        body: JSON.stringify({ model, context_length: contextLength, flash_attention: true }),
      },
      LOAD_TIMEOUT_MS,
    );
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      warn('lmstudio.instances.load-failed', `LM Studio load of "${model}" returned ${response.status}`, {
        model,
        baseUrl,
        status: response.status,
        error: errorBody.slice(0, 200),
      });
      return { instanceId: null, loaded: false };
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const id = body.instance_id ?? body.id ?? body.model_instance_id;
    loadedId = typeof id === 'string' ? id : null;
  } catch (error) {
    warn('lmstudio.instances.load-failed', `LM Studio load of "${model}" failed`, {
      model,
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return { instanceId: null, loaded: false };
  }

  // Post-load verification — the deterministic gate against the next
  // silent loaded-state regression: a load just succeeded, so a follow-up
  // query reporting zero instances means the source is lying again.
  const after = await queryLmStudioInstances(baseUrl, model, warn, fetchImpl);
  if (after.length === 0) {
    warn(
      'lmstudio.instances.loaded-state-source-lying',
      `LM Studio reported a successful load of "${model}" but no loaded instance is visible in the model lists — the loaded-state source has regressed and every run may now leak an instance`,
      { model, baseUrl, loadedId },
    );
    return { instanceId: loadedId, loaded: true };
  }

  // Confirm the instance to pin: the load-response id when the list shows
  // it (id namespaces can differ across endpoints — compare fuzzily), else
  // the best instance that actually satisfies the request. Never blindly
  // after[0]: with a failed sweep the list can still lead with a stale
  // undersized instance.
  const afterReady = after.filter((inst) => inst.ready);
  const byLoadedId = loadedId === null
    ? undefined
    : afterReady.find((inst) => inst.id === loadedId || lmStudioModelMatches(inst.id, loadedId));
  const bestAdequate = afterReady
    .filter((inst) => inst.contextLength === null || inst.contextLength >= contextLength)
    .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))[0];
  const confirmed = byLoadedId ?? bestAdequate;
  if (!confirmed) {
    // The list answered but shows nothing ready/adequate despite a
    // successful load — trust the load response over an incoherent list.
    return { instanceId: loadedId, loaded: true };
  }
  await unloadSurplus(baseUrl, afterReady, confirmed.id, warn, fetchImpl);
  return { instanceId: confirmed.id, loaded: true };
}

/** Unload every READY instance except `keepId` — the converge-to-one sweep. */
async function unloadSurplus(
  baseUrl: string,
  readyInstances: LmStudioInstance[],
  keepId: string,
  warn: LmStudioWarn,
  fetchImpl: LmStudioTimedFetch,
): Promise<void> {
  const surplus = readyInstances.filter((inst) => inst.id !== keepId && inst.ready);
  if (surplus.length === 0) return;
  warn(
    'lmstudio.instances.converge-sweep',
    `Unloading ${surplus.length} surplus LM Studio instance(s) — converging on "${keepId}"`,
    { baseUrl, keepId, surplus: surplus.map((i) => i.id) },
  );
  for (const inst of surplus) {
    await unloadLmStudioInstance(baseUrl, inst.id, warn, fetchImpl);
  }
}
