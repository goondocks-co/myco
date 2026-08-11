import type { EmbeddingProvider, EmbeddingResponse } from './llm.js';
import { EMBEDDING_REQUEST_TIMEOUT_MS, DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';
import { createInstrumentedFetch } from '../utils/instrumented-fetch.js';

/**
 * Module-level instrumented fetch for every LMStudio request — adds the
 * no-progress watchdog and per-chunk loop yields on top of the existing
 * `AbortSignal.timeout(...)` wall-clock cap. The previous wall-clock
 * timeout protects only the *total* duration; the watchdog catches
 * "stream drips one byte every 30 minutes" and any sync work inside
 * undici's chunk delivery is interleaved with `setImmediate`.
 */
const lmStudioFetch = createInstrumentedFetch({
  component: 'intelligence.lm-studio',
  responseHeadersTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
});

interface LmStudioConfig {
  model?: string;
  base_url?: string;
  context_window?: number;
  max_tokens?: number;
  // Legacy fields
  embedding_model?: string;
  summary_model?: string;
}

// LM Studio API endpoints. Model-instance management (load/unload/loaded
// state) lives in lmstudio-instances.ts — the shared ensure-loaded path.
const ENDPOINT_MODELS_LIST = '/v1/models';
const ENDPOINT_EMBEDDINGS = '/v1/embeddings';

/**
 * Embedding + availability client for an LM Studio server. Text
 * generation goes through the openai-agents harness, and model-instance
 * lifecycle goes through `lmstudio-instances.ts` — this backend
 * intentionally carries neither.
 */
export class LmStudioBackend implements EmbeddingProvider {
  static readonly DEFAULT_BASE_URL = 'http://localhost:1234';
  readonly name = 'lm-studio';
  private baseUrl: string;
  private model: string;

  constructor(config?: LmStudioConfig) {
    this.baseUrl = config?.base_url ?? LmStudioBackend.DEFAULT_BASE_URL;
    this.model = config?.model ?? config?.summary_model ?? 'llama3.2';
  }

  /**
   * Generate embeddings using LM Studio's OpenAI-compatible endpoint.
   * (The native API doesn't have an embedding endpoint — OpenAI-compat is
   * fine here, and it JIT-loads/reuses embedding models on its own.)
   */
  async embed(text: string): Promise<EmbeddingResponse> {
    const response = await lmStudioFetch(`${this.baseUrl}${ENDPOINT_EMBEDDINGS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
      signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`LM Studio embed failed: ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      model: string;
    };
    const embedding = data.data[0].embedding;
    return { embedding, model: data.model, dimensions: embedding.length };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await lmStudioFetch(`${this.baseUrl}${ENDPOINT_MODELS_LIST}`, {
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** List available models on this LM Studio instance. */
  async listModels(timeoutMs?: number): Promise<string[]> {
    try {
      const response = await lmStudioFetch(`${this.baseUrl}${ENDPOINT_MODELS_LIST}`, {
        signal: AbortSignal.timeout(timeoutMs ?? DAEMON_CLIENT_TIMEOUT_MS),
      });
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }
}
