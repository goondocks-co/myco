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

export class LmStudioBackend implements LlmProvider, EmbeddingProvider {
  static readonly DEFAULT_BASE_URL = 'http://localhost:1234';
  readonly name = 'lm-studio';
  private baseUrl: string;
  private model: string;
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
   * Supports per-request context_length, reasoning control, and system_prompt.
   */
  async summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse> {
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;

    const body: Record<string, unknown> = {
      model: this.model,
      input: prompt,
      max_output_tokens: maxTokens,
      store: false,
    };

    // Per-request context length (from opts or constructor config)
    const contextLength = opts?.contextLength ?? this.contextWindow;
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

    // keepalive: true prevents Node.js from closing the connection at its
    // default 5-minute idle timeout. Digest requests can take 5+ minutes
    // for large context windows on local models.
    const response = await fetch(`${this.baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS),
      keepalive: true,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
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
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
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
   * Ensure the model is loaded with the specified context length.
   * Uses LM Studio's native /api/v1/models/load endpoint.
   * If the model is already loaded, this is a no-op on LM Studio's side.
   */
  async ensureLoaded(contextLength?: number, gpuKvCache?: boolean): Promise<void> {
    const ctx = contextLength ?? this.contextWindow;
    const body: Record<string, unknown> = {
      model: this.model,
      flash_attention: true,
      offload_kv_cache_to_gpu: gpuKvCache ?? false,
    };
    if (ctx) {
      body.context_length = ctx;
    }

    const response = await fetch(`${this.baseUrl}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`LM Studio model load failed: ${response.status} ${errorBody.slice(0, 200)}`);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
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
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(timeoutMs ?? DAEMON_CLIENT_TIMEOUT_MS),
      });
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }
}
