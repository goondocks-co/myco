/**
 * API route handlers for provider detection and connectivity testing.
 *
 * Route overview:
 *   GET  /api/providers       — detect available LLM providers and their models
 *   POST /api/providers/test  — test connectivity to a specific provider
 */

import Anthropic from '@anthropic-ai/sdk';
import { checkLocalProvider } from '../../intelligence/provider-check.js';
import {
  createLocalOpenAIBackend,
  getLocalOpenAIBackendDefaultBaseUrl,
  getLocalOpenAIBackendLabel,
  inferLocalOpenAIBackendKind,
} from '../../intelligence/local-openai-backends.js';
import { OllamaBackend } from '../../intelligence/ollama.js';
import { LmStudioBackend } from '../../intelligence/lm-studio.js';
import {
  ANTHROPIC_MODELS,
  filterLlmModels,
  fetchRemoteProviderModels,
  getRemoteProviderApiKey,
} from './models.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import { PROVIDER_TYPES, isProviderType, type RuntimeId, type ProviderType } from '@myco/agent/types.js';
import { DEFAULT_OPENAI_URL, DEFAULT_OPENROUTER_URL } from '@myco/agent/provider.js';

/** Timeout for the live Anthropic model list query (short -- fall back fast). */
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;

/** TTL for the cached live Anthropic model list. The list changes rarely
 *  and the SDK call is the slowest part of `/providers`; cache to keep the
 *  endpoint snappy under React Query's 30s stale time. */
const ANTHROPIC_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let anthropicModelsCache: { ts: number; models: string[] } | null = null;

/** HTTP status codes. */
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderInfo {
  type: ProviderType;
  runtime: RuntimeId;
  available: boolean;
  authConfigured?: boolean;
  baseUrl?: string;
  models: string[];
}

interface TestResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Detect available providers (Ollama, LM Studio, Anthropic).
 *
 * Uses Promise.allSettled for parallel detection with timeouts so one
 * slow/unavailable provider doesn't block the others.
 */
export async function handleGetProviders(): Promise<RouteResponse> {
  const detectionPlan: Array<{
    detect: () => Promise<ProviderInfo>;
    fallback: ProviderInfo;
  }> = [
    {
      detect: () => detectAnthropic(),
      fallback: { type: 'anthropic', runtime: 'claude-sdk', available: false, models: [] },
    },
    {
      detect: () => detectLocalProviderInfo('ollama', OllamaBackend.DEFAULT_BASE_URL),
      fallback: { type: 'ollama', runtime: 'claude-sdk', available: false, baseUrl: OllamaBackend.DEFAULT_BASE_URL, models: [] },
    },
    {
      detect: () => detectLocalProviderInfo('lmstudio', LmStudioBackend.DEFAULT_BASE_URL),
      fallback: { type: 'lmstudio', runtime: 'claude-sdk', available: false, baseUrl: LmStudioBackend.DEFAULT_BASE_URL, models: [] },
    },
    {
      detect: () => detectRemoteProviderInfo('openai', DEFAULT_OPENAI_URL),
      fallback: { type: 'openai', runtime: 'openai-agents', available: false, authConfigured: false, baseUrl: DEFAULT_OPENAI_URL, models: [] },
    },
    {
      detect: () => detectRemoteProviderInfo('openrouter', DEFAULT_OPENROUTER_URL),
      fallback: { type: 'openrouter', runtime: 'openai-agents', available: false, authConfigured: false, baseUrl: DEFAULT_OPENROUTER_URL, models: [] },
    },
    {
      detect: () => detectLocalProviderInfo('openai-compatible', LmStudioBackend.DEFAULT_BASE_URL),
      fallback: { type: 'openai-compatible', runtime: 'openai-agents', available: false, baseUrl: LmStudioBackend.DEFAULT_BASE_URL, models: [] },
    },
  ];

  const results = await Promise.allSettled(detectionPlan.map((entry) => entry.detect()));
  const providers: ProviderInfo[] = results.map((result, index) =>
    result.status === 'fulfilled' ? result.value : detectionPlan[index].fallback,
  );

  return { status: HTTP_OK, body: { providers } };
}

/**
 * Test connectivity to a specific provider.
 *
 * Accepts: { type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible', baseUrl?: string, local_backend?: 'ollama' | 'lmstudio', model?: string }
 * Returns: { ok: boolean, latency_ms?: number, error?: string }
 */
export async function handleTestProvider(req: RouteRequest): Promise<RouteResponse> {
  const body = req.body as Record<string, unknown> | undefined;
  const type = body?.type as string | undefined;

  if (!type || !isProviderType(type)) {
    return {
      status: HTTP_BAD_REQUEST,
      body: { error: `type is required and must be one of: ${PROVIDER_TYPES.join(', ')}` },
    };
  }

  const baseUrl = (body?.baseUrl as string | undefined) ?? (body?.base_url as string | undefined);
  const localBackend = (body?.local_backend as 'ollama' | 'lmstudio' | undefined);
  const start = performance.now();
  let result: TestResult;

  try {
    if (type === 'ollama') {
      result = await testResolvedLocalProvider('ollama', baseUrl);
    } else if (type === 'lmstudio') {
      result = await testResolvedLocalProvider('lmstudio', baseUrl);
    } else if (type === 'openai-compatible') {
      result = await testResolvedLocalProvider('openai-compatible', baseUrl, localBackend);
    } else if (type === 'openai') {
      // baseUrl deliberately dropped — remote providers always use the
      // hardcoded default to prevent SSRF via the daemon's bearer token.
      result = await testRemoteProvider('openai', 'OpenAI');
    } else if (type === 'openrouter') {
      result = await testRemoteProvider('openrouter', 'OpenRouter');
    } else {
      result = testAnthropic();
    }
  } catch (err) {
    result = { ok: false, error: String(err) };
  }

  if (result.ok) {
    result.latency_ms = Math.round(performance.now() - start);
  }

  return { status: HTTP_OK, body: result };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Detect a local provider (Ollama or LM Studio) and wrap as ProviderInfo.
 *  Filters embedding models out — the agent provider only runs LLM tasks. */
async function detectLocalProviderInfo(
  type: 'ollama' | 'lmstudio' | 'openai-compatible',
  defaultBaseUrl: string,
): Promise<ProviderInfo> {
  const status = await checkLocalProvider(type === 'openai-compatible' ? 'lmstudio' : type);
  // Filter out Myco-created context variants (e.g., gpt-oss-ctx32768)
  const variantFiltered = status.models.filter(m => !/-ctx\d+/.test(m));
  // Drop embedding models -- the agent provider only runs LLM tasks
  const models = filterLlmModels(variantFiltered);
  return {
    type,
    runtime: type === 'openai-compatible' ? 'openai-agents' : 'claude-sdk',
    available: status.available,
    baseUrl: defaultBaseUrl,
    models,
  };
}

async function detectAnthropic(): Promise<ProviderInfo> {
  // Anthropic is always available — the SDK handles auth internally via OAuth,
  // API key, Bedrock, Vertex, or Foundry. The daemon can't reliably detect
  // which method is in use since env vars aren't always inherited.
  //
  // The live model list is cached with a 10-minute TTL so we don't hit the
  // SDK on every `/providers` request. On any failure (no API key set in the
  // daemon's env, no network, OAuth-only auth) we fall back to the hardcoded
  // ANTHROPIC_MODELS constant so the dropdown is never empty.
  const now = Date.now();
  if (anthropicModelsCache && now - anthropicModelsCache.ts < ANTHROPIC_MODELS_CACHE_TTL_MS) {
    return { type: 'anthropic', runtime: 'claude-sdk', available: true, models: anthropicModelsCache.models };
  }

  let models = ANTHROPIC_MODELS;
  try {
    const client = new Anthropic();
    const response = await client.models.list(
      { limit: 50 },
      { timeout: ANTHROPIC_MODELS_TIMEOUT_MS },
    );
    const liveModels = response.data
      .map((m) => m.id)
      .filter((id) => id.startsWith('claude-'));
    if (liveModels.length > 0) {
      models = liveModels;
    }
  } catch {
    // Fall through to hardcoded ANTHROPIC_MODELS
  }
  anthropicModelsCache = { ts: now, models };
  return { type: 'anthropic', runtime: 'claude-sdk', available: true, models };
}

async function detectRemoteProviderInfo(
  type: 'openai' | 'openrouter',
  baseUrl: string,
): Promise<ProviderInfo> {
  const authConfigured = Boolean(getRemoteProviderApiKey(type));
  let models: string[] = [];
  let available = false;

  if (authConfigured) {
    try {
      models = await fetchRemoteProviderModels(type, baseUrl, ANTHROPIC_MODELS_TIMEOUT_MS);
      available = true;
    } catch {
      available = false;
    }
  }

  return {
    type,
    runtime: 'openai-agents',
    available,
    authConfigured,
    baseUrl,
    models,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Test a local provider's connectivity — shared pattern. */
async function testLocalProvider(
  backend: { isAvailable(): Promise<boolean> },
  label: string,
  defaultBaseUrl: string,
  baseUrl?: string,
): Promise<TestResult> {
  const available = await backend.isAvailable();
  if (!available) {
    return { ok: false, error: `${label} not reachable at ${baseUrl ?? defaultBaseUrl}` };
  }
  return { ok: true };
}

async function testResolvedLocalProvider(
  type: 'ollama' | 'lmstudio' | 'openai-compatible',
  baseUrl?: string,
  localBackend?: 'ollama' | 'lmstudio',
): Promise<TestResult> {
  const kind = inferLocalOpenAIBackendKind({ type, localBackend, baseUrl }) ?? 'lmstudio';
  const label = type === 'openai-compatible'
    ? `OpenAI-compatible ${getLocalOpenAIBackendLabel(kind)} provider`
    : getLocalOpenAIBackendLabel(kind);
  return testLocalProvider(
    createLocalOpenAIBackend(kind, baseUrl),
    label,
    getLocalOpenAIBackendDefaultBaseUrl(kind),
    baseUrl,
  );
}

function testAnthropic(): TestResult {
  // SDK handles auth — always report OK. Auth failures surface at runtime.
  return { ok: true };
}

async function testRemoteProvider(
  provider: 'openai' | 'openrouter',
  label: string,
): Promise<TestResult> {
  if (!getRemoteProviderApiKey(provider)) {
    return { ok: false, error: `${label} API key not configured in daemon secrets or environment` };
  }
  try {
    await fetchRemoteProviderModels(provider);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : `${label} connection failed` };
  }
}
