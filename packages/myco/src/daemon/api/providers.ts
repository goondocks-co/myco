/**
 * API route handlers for provider detection and connectivity testing.
 *
 * Route overview:
 *   GET  /api/providers       — detect available LLM providers and their models
 *   POST /api/providers/test  — test connectivity to a specific provider
 */

import { z } from 'zod';
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
import type { DaemonLogger } from '../logger.js';
import { PROVIDER_TYPES, HARNESS_CLAUDE_SDK, HARNESS_OPENAI_AGENTS, type HarnessId, type ProviderType } from '@myco/agent/types.js';
import { DEFAULT_OPENAI_URL, DEFAULT_OPENROUTER_URL } from '@myco/agent/provider.js';
import { getSupportedHarnessesForProviderType } from '@myco/agent/provider-harness.js';
import { errorMessage } from '@myco/utils/error-message.js';

/** Timeout for the live remote-provider model list query (OpenAI/OpenRouter). */
const REMOTE_PROVIDER_MODELS_TIMEOUT_MS = 5000;

/** HTTP status codes. */
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderInfo {
  type: ProviderType;
  /** Default harness for this provider type. */
  harness: HarnessId;
  /** Every harness this provider type can run on (default first). */
  availableHarnesses: readonly HarnessId[];
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
export async function handleGetProviders(logger?: DaemonLogger): Promise<RouteResponse> {
  const fallback = (
    type: ProviderType,
    extras: Omit<ProviderInfo, 'type' | 'harness' | 'availableHarnesses'>,
  ): ProviderInfo => ({
    type,
    harness: getSupportedHarnessesForProviderType(type)[0] ?? HARNESS_CLAUDE_SDK,
    availableHarnesses: getSupportedHarnessesForProviderType(type),
    ...extras,
  });
  const detectionPlan: Array<{
    detect: () => Promise<ProviderInfo>;
    fallback: ProviderInfo;
  }> = [
    {
      detect: () => Promise.resolve(detectAnthropic()),
      fallback: fallback('anthropic', { available: false, models: [] }),
    },
    {
      detect: () => detectLocalProviderInfo('ollama', OllamaBackend.DEFAULT_BASE_URL),
      fallback: fallback('ollama', { available: false, baseUrl: OllamaBackend.DEFAULT_BASE_URL, models: [] }),
    },
    {
      detect: () => detectLocalProviderInfo('lmstudio', LmStudioBackend.DEFAULT_BASE_URL),
      fallback: fallback('lmstudio', { available: false, baseUrl: LmStudioBackend.DEFAULT_BASE_URL, models: [] }),
    },
    {
      detect: () => detectRemoteProviderInfo('openai', DEFAULT_OPENAI_URL, logger),
      fallback: fallback('openai', { available: false, authConfigured: false, baseUrl: DEFAULT_OPENAI_URL, models: [] }),
    },
    {
      detect: () => detectRemoteProviderInfo('openrouter', DEFAULT_OPENROUTER_URL, logger),
      fallback: fallback('openrouter', { available: false, authConfigured: false, baseUrl: DEFAULT_OPENROUTER_URL, models: [] }),
    },
    {
      detect: () => detectLocalProviderInfo('openai-compatible', LmStudioBackend.DEFAULT_BASE_URL),
      fallback: fallback('openai-compatible', { available: false, baseUrl: LmStudioBackend.DEFAULT_BASE_URL, models: [] }),
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
const ProviderTestBody = z.object({
  type: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().optional(),
  /**
   * Deprecated: `base_url` is the legacy snake_case key. Accepted for one
   * release and then removed. Use `baseUrl` going forward.
   */
  base_url: z.string().optional(),
  local_backend: z.enum(['ollama', 'lmstudio']).optional(),
  model: z.string().optional(),
});

export async function handleTestProvider(req: RouteRequest): Promise<RouteResponse> {
  const parse = ProviderTestBody.safeParse(req.body);
  if (!parse.success) {
    return {
      status: HTTP_BAD_REQUEST,
      body: { error: `type is required and must be one of: ${PROVIDER_TYPES.join(', ')}` },
    };
  }
  const parsed = parse.data;
  if (parsed.base_url !== undefined && parsed.baseUrl === undefined) {
    process.stderr.write(
      '[myco providers] POST /api/providers/test: base_url is deprecated; use baseUrl\n',
    );
  }
  const type = parsed.type;
  const baseUrl = parsed.baseUrl ?? parsed.base_url;
  const localBackend = parsed.local_backend;
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
    result = {
      ok: false,
      error: errorMessage(err),
    };
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
  const supported = getSupportedHarnessesForProviderType(type);
  return {
    type,
    harness: type === 'openai-compatible' ? HARNESS_OPENAI_AGENTS : HARNESS_CLAUDE_SDK,
    availableHarnesses: supported,
    available: status.available,
    baseUrl: defaultBaseUrl,
    models,
  };
}

function detectAnthropic(): ProviderInfo {
  // Anthropic is always available — the harness uses @anthropic-ai/claude-agent-sdk,
  // which spawns the `claude` CLI subprocess and inherits its auth (OAuth, API key,
  // Bedrock, Vertex, Foundry). The daemon process itself has no Anthropic auth,
  // so a live `models.list` call from this side isn't reachable.
  //
  // Aliases (sonnet/opus/haiku) sidestep the staleness problem the live fetch
  // tried to solve — Anthropic resolves each to the latest version of the
  // family at request time. Users who want to pin a specific version can type
  // a full model ID into the field directly.
  return {
    type: 'anthropic',
    harness: HARNESS_CLAUDE_SDK,
    availableHarnesses: getSupportedHarnessesForProviderType('anthropic'),
    available: true,
    models: ANTHROPIC_MODELS,
  };
}

async function detectRemoteProviderInfo(
  type: 'openai' | 'openrouter',
  baseUrl: string,
  logger?: DaemonLogger,
): Promise<ProviderInfo> {
  const authConfigured = Boolean(getRemoteProviderApiKey(type));
  let models: string[] = [];
  let available = false;

  if (authConfigured) {
    try {
      // baseUrl is intentionally ignored by fetchRemoteProviderModels for remote
      // providers (always uses the hardcoded default); see SSRF lockdown.
      models = await fetchRemoteProviderModels(type, undefined, REMOTE_PROVIDER_MODELS_TIMEOUT_MS);
      available = true;
    } catch (err) {
      available = false;
      const detail = errorMessage(err);
      logger?.warn(`providers.${type}.models-unavailable`, `${type} model list unavailable`, { error: detail });
    }
  }

  return {
    type,
    harness: HARNESS_OPENAI_AGENTS,
    availableHarnesses: getSupportedHarnessesForProviderType(type),
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
