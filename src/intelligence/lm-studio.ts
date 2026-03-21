import type { LlmProvider, EmbeddingProvider, LlmResponse, EmbeddingResponse, LlmRequestOptions } from './llm.js';
import { LLM_REQUEST_TIMEOUT_MS, EMBEDDING_REQUEST_TIMEOUT_MS, DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';

interface LmStudioConfig {
  model?: string;
  base_url?: string;
  context_window?: number;
  max_tokens?: number;
  // Legacy fields
  embedding_model?: string;
  summary_model?: string;
}

// LM Studio API endpoints
const ENDPOINT_CHAT = '/api/v1/chat';
const ENDPOINT_MODELS_LOAD = '/api/v1/models/load';
const ENDPOINT_MODELS_LIST = '/v1/models';
const ENDPOINT_MODELS_NATIVE = '/api/v1/models';
const ENDPOINT_EMBEDDINGS = '/v1/embeddings';

/** Shape of a loaded instance from the LM Studio native models API.
 *  Config fields vary by engine — llama.cpp models include flash_attention
 *  and offload_kv_cache_to_gpu, but other engines (MLX, etc.) may omit them. */
interface NativeLoadedInstance {
  id: string;
  config: {
    context_length: number;
    flash_attention?: boolean;
    offload_kv_cache_to_gpu?: boolean;
  };
}

/** Shape of a model entry from the LM Studio native models API. */
interface NativeModelEntry {
  type: string;
  key: string;
  loaded_instances: NativeLoadedInstance[];
}

export class LmStudioBackend implements LlmProvider, EmbeddingProvider {
  static readonly DEFAULT_BASE_URL = 'http://localhost:1234';
  readonly name = 'lm-studio';
  private baseUrl: string;
  private model: string;
  private instanceId: string | null = null;
  private contextWindow: number | undefined;
  private defaultMaxTokens: number;

  constructor(config?: LmStudioConfig) {
    this.baseUrl = config?.base_url ?? LmStudioBackend.DEFAULT_BASE_URL;
    this.model = config?.model ?? config?.summary_model ?? 'llama3.2';
    this.contextWindow = config?.context_window;
    this.defaultMaxTokens = config?.max_tokens ?? 1024;
  }

  /**
   * Generate text using LM Studio's native REST API (/api/v1/chat).
   * Routes to our specific instance by ID when available, with model name +
   * context_length as fallback. This ensures correct routing when multiple
   * daemons share the same LM Studio, and graceful degradation when our
   * instance is evicted by idle TTL.
   */
  async summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse> {
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;
    const contextLength = opts?.contextLength ?? this.contextWindow;

    const body: Record<string, unknown> = {
      model: this.instanceId ?? this.model,
      input: prompt,
      max_output_tokens: maxTokens,
      store: false,
    };

    // Always send context_length — even when routing by instance ID.
    // If our instance was evicted and LM Studio auto-loads, this ensures
    // the replacement gets the correct context window.
    if (contextLength) {
      body.context_length = contextLength;
    }

    // System prompt — sent separately from user content
    if (opts?.systemPrompt) {
      body.system_prompt = opts.systemPrompt;
    }

    // Reasoning control — 'off' suppresses chain-of-thought for reasoning models
    if (opts?.reasoning) {
      body.reasoning = opts.reasoning;
    }

    const response = await fetch(`${this.baseUrl}${ENDPOINT_CHAT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      // If our instance was evicted, clear the ID so ensureLoaded
      // reloads on the next cycle instead of hitting a stale ID repeatedly
      if (response.status === 404 && this.instanceId) {
        this.instanceId = null;
      }
      throw new Error(`LM Studio summarize failed: ${response.status} ${errorBody.slice(0, 500)}`);
    }

    const data = await response.json() as {
      model_instance_id: string;
      output: Array<{ type: string; content: string }>;
    };
    const messageOutput = data.output.find((o) => o.type === 'message');
    const text = messageOutput?.content ?? '';
    return { text, model: data.model_instance_id };
  }

  /**
   * Generate embeddings using LM Studio's OpenAI-compatible endpoint.
   * (The native API doesn't have an embedding endpoint — OpenAI-compat is fine here.)
   */
  async embed(text: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${this.baseUrl}${ENDPOINT_EMBEDDINGS}`, {
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

  /**
   * Ensure a model instance is loaded and capture its ID for routing.
   * Called every digest cycle so it recovers from idle TTL eviction.
   *
   * Strategy: reuse ANY loaded instance of this model. Only load a new one
   * when zero instances exist. This avoids the previous bug where strict
   * config matching (context_length, offload_kv_cache_to_gpu) caused new
   * instances to spawn every cycle — exhausting system resources.
   *
   * context_length is set per-request on /api/v1/chat, so we don't need
   * to match it at load time. Load-time-only params like
   * offload_kv_cache_to_gpu are llama.cpp-specific and may not apply to
   * all models (e.g., glm-4.7-flash has no KV cache setting).
   */
  async ensureLoaded(contextLength?: number, gpuKvCache?: boolean): Promise<void> {
    // Query native API for existing loaded instances of this model
    const instances = await this.getLoadedInstances();

    if (instances.length > 0) {
      // Reuse the first available instance — don't reject over config differences.
      // context_length is set per-request; load-time params like kv_cache are
      // model-dependent and may not even appear in the instance config.
      this.instanceId = instances[0].id;
      return;
    }

    // No instances loaded — load one with our preferred settings.
    // These are hints; LM Studio silently ignores params that don't apply to the model's engine.
    const ctx = contextLength ?? this.contextWindow;
    const body: Record<string, unknown> = {
      model: this.model,
      // llama.cpp-specific — ignored by other engines (MLX, etc.)
      flash_attention: true,
    };
    if (ctx) {
      body.context_length = ctx;
    }
    if (gpuKvCache) {
      body.offload_kv_cache_to_gpu = true;
    }

    const response = await fetch(`${this.baseUrl}${ENDPOINT_MODELS_LOAD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`LM Studio model load failed: ${response.status} ${errorBody.slice(0, 200)}`);
    }

    const loadResult = await response.json() as Record<string, unknown>;
    const id = (loadResult.instance_id ?? loadResult.id ?? loadResult.model_instance_id) as string | undefined;
    if (id) {
      this.instanceId = id;
    }
  }

  /**
   * Query the LM Studio native API for loaded instances of this model.
   * Returns an empty array if the API is unavailable or the model has no loaded instances.
   */
  private async getLoadedInstances(): Promise<NativeLoadedInstance[]> {
    try {
      const response = await fetch(`${this.baseUrl}${ENDPOINT_MODELS_NATIVE}`, {
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      });
      if (!response.ok) return [];

      const data = await response.json() as { models: NativeModelEntry[] };
      const entry = data.models.find((m) => m.key === this.model);
      return entry?.loaded_instances ?? [];
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}${ENDPOINT_MODELS_LIST}`, {
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
      const response = await fetch(`${this.baseUrl}${ENDPOINT_MODELS_LIST}`, {
        signal: AbortSignal.timeout(timeoutMs ?? DAEMON_CLIENT_TIMEOUT_MS),
      });
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }
}
