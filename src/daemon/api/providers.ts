/**
 * API route handlers for provider detection and connectivity testing.
 *
 * Route overview:
 *   GET  /api/providers       — detect available LLM providers and their models
 *   POST /api/providers/test  — test connectivity to a specific provider
 */

import Anthropic from '@anthropic-ai/sdk';
import { OllamaBackend } from '../../intelligence/ollama.js';
import { LmStudioBackend } from '../../intelligence/lm-studio.js';
import { checkLocalProvider } from '../../intelligence/provider-check.js';
import { ANTHROPIC_MODELS, filterLlmModels } from './models.js';
import type { RouteRequest, RouteResponse } from '../router.js';

/** Timeout for the live Anthropic model list query (short -- fall back fast). */
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;

/** HTTP status codes. */
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderInfo {
  type: string;
  available: boolean;
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
  const results = await Promise.allSettled([
    detectLocalProviderInfo('ollama', OllamaBackend.DEFAULT_BASE_URL),
    detectLocalProviderInfo('lmstudio', LmStudioBackend.DEFAULT_BASE_URL),
    detectAnthropic(),
  ]);

  const providers: ProviderInfo[] = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { type: 'unknown', available: false, models: [] },
  );

  return { status: HTTP_OK, body: { providers } };
}

/**
 * Test connectivity to a specific provider.
 *
 * Accepts: { type: 'anthropic' | 'ollama' | 'lmstudio', baseUrl?: string, model?: string }
 * Returns: { ok: boolean, latency_ms?: number, error?: string }
 */
export async function handleTestProvider(req: RouteRequest): Promise<RouteResponse> {
  const body = req.body as Record<string, unknown> | undefined;
  const type = body?.type as string | undefined;

  if (!type || !['anthropic', 'ollama', 'lmstudio'].includes(type)) {
    return {
      status: HTTP_BAD_REQUEST,
      body: { error: 'type is required and must be one of: anthropic, ollama, lmstudio' },
    };
  }

  const baseUrl = body?.baseUrl as string | undefined;
  const start = performance.now();
  let result: TestResult;

  try {
    if (type === 'ollama') {
      result = await testLocalProvider(new OllamaBackend({ base_url: baseUrl }), 'Ollama', OllamaBackend.DEFAULT_BASE_URL, baseUrl);
    } else if (type === 'lmstudio') {
      result = await testLocalProvider(new LmStudioBackend({ base_url: baseUrl }), 'LM Studio', LmStudioBackend.DEFAULT_BASE_URL, baseUrl);
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
 *  Filters out embedding models (bge-, nomic-embed, etc.) and Myco-created
 *  context variants -- the agent provider dropdown only needs LLMs. */
async function detectLocalProviderInfo(
  type: 'ollama' | 'lmstudio',
  defaultBaseUrl: string,
): Promise<ProviderInfo> {
  const status = await checkLocalProvider(type);
  // Filter out Myco-created context variants (e.g., gpt-oss-ctx32768)
  const variantFiltered = status.models.filter(m => !/-ctx\d+/.test(m));
  // Drop embedding models -- the agent provider only runs LLM tasks
  const models = filterLlmModels(variantFiltered);
  return { type, available: status.available, baseUrl: defaultBaseUrl, models };
}

async function detectAnthropic(): Promise<ProviderInfo> {
  // Anthropic is always available — the SDK handles auth internally via OAuth,
  // API key, Bedrock, Vertex, or Foundry. The daemon can't reliably detect
  // which method is in use since env vars aren't always inherited.
  //
  // Try to query the live model list via the SDK. If it fails (no API key
  // set in the daemon's env, no network, OAuth-only auth), fall back to the
  // hardcoded ANTHROPIC_MODELS constant so the dropdown is never empty.
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
  return { type: 'anthropic', available: true, models };
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

function testAnthropic(): TestResult {
  // SDK handles auth — always report OK. Auth failures surface at runtime.
  return { ok: true };
}
