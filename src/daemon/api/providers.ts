/**
 * API route handlers for provider detection and connectivity testing.
 *
 * Route overview:
 *   GET  /api/providers       — detect available LLM providers and their models
 *   POST /api/providers/test  — test connectivity to a specific provider
 */

import { PROVIDER_DETECT_TIMEOUT_MS } from '../../constants.js';
import { OllamaBackend } from '../../intelligence/ollama.js';
import { LmStudioBackend } from '../../intelligence/lm-studio.js';
import { ANTHROPIC_MODELS } from './models.js';
import type { RouteRequest, RouteResponse } from '../router.js';

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
    detectLocalProvider(new OllamaBackend(), 'ollama', OllamaBackend.DEFAULT_BASE_URL),
    detectLocalProvider(new LmStudioBackend(), 'lmstudio', LmStudioBackend.DEFAULT_BASE_URL),
    detectCloud(),
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
 * Accepts: { type: 'cloud' | 'ollama' | 'lmstudio', baseUrl?: string, model?: string }
 * Returns: { ok: boolean, latency_ms?: number, error?: string }
 */
export async function handleTestProvider(req: RouteRequest): Promise<RouteResponse> {
  const body = req.body as Record<string, unknown> | undefined;
  const type = body?.type as string | undefined;

  if (!type || !['cloud', 'ollama', 'lmstudio'].includes(type)) {
    return {
      status: HTTP_BAD_REQUEST,
      body: { error: 'type is required and must be one of: cloud, ollama, lmstudio' },
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
      result = testCloud();
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

/** Detect a local provider (Ollama or LM Studio) — shared pattern. */
async function detectLocalProvider(
  backend: { isAvailable(): Promise<boolean>; listModels(timeout: number): Promise<string[]> },
  type: string,
  defaultBaseUrl: string,
): Promise<ProviderInfo> {
  const available = await backend.isAvailable();
  const allModels = available ? await backend.listModels(PROVIDER_DETECT_TIMEOUT_MS) : [];
  // Filter out Myco-created context variants (e.g., gpt-oss-ctx32768)
  const models = allModels.filter(m => !/-ctx\d+/.test(m));
  return { type, available, baseUrl: defaultBaseUrl, models };
}

async function detectCloud(): Promise<ProviderInfo> {
  // Cloud is always available — the SDK handles auth internally via OAuth,
  // API key, Bedrock, Vertex, or Foundry. The daemon can't reliably detect
  // which method is in use since env vars aren't always inherited.
  return { type: 'cloud', available: true, models: ANTHROPIC_MODELS };
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

function testCloud(): TestResult {
  // SDK handles auth — always report OK. Auth failures surface at runtime.
  return { ok: true };
}
