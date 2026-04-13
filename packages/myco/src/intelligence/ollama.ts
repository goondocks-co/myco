import type { LlmProvider, EmbeddingProvider, LlmResponse, EmbeddingResponse, LlmRequestOptions } from './llm.js';
import { LLM_REQUEST_TIMEOUT_MS, EMBEDDING_REQUEST_TIMEOUT_MS, DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';

interface OllamaConfig {
  model?: string;
  base_url?: string;
  context_window?: number;
  max_tokens?: number;
  // Legacy fields (ignored, kept for backward compat during migration)
  embedding_model?: string;
  summary_model?: string;
}

// Ollama API endpoints
const ENDPOINT_GENERATE = '/api/generate';
const ENDPOINT_EMBED = '/api/embed';
const ENDPOINT_TAGS = '/api/tags';

export class OllamaBackend implements LlmProvider, EmbeddingProvider {
  static readonly DEFAULT_BASE_URL = 'http://localhost:11434';
  readonly name = 'ollama';
  private baseUrl: string;
  private model: string;
  private defaultMaxTokens: number;
  private contextWindow: number | undefined;

  constructor(config?: OllamaConfig) {
    this.baseUrl = config?.base_url ?? OllamaBackend.DEFAULT_BASE_URL;
    this.model = config?.model ?? config?.summary_model ?? 'llama3.2';
    this.defaultMaxTokens = config?.max_tokens ?? 1024;
    this.contextWindow = config?.context_window;
  }

  async summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse> {
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;

    // Send num_ctx from config or per-call override. Ollama reloads the model
    // on num_ctx changes, but consistent values (same num_ctx every call)
    // only cause one reload on first use. Without this, Ollama falls back to
    // its model default (often 2048), ignoring the user's configured context.
    const contextLength = opts?.contextLength ?? this.contextWindow;
    const options: Record<string, unknown> = { num_predict: maxTokens };
    if (contextLength) {
      options.num_ctx = contextLength;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: true,
      options,
    };

    // System prompt — sent as a separate field instead of concatenated into prompt
    if (opts?.systemPrompt) {
      body.system = opts.systemPrompt;
    }

    // Thinking control — false suppresses chain-of-thought for reasoning models
    if (opts?.reasoning) {
      body.think = opts.reasoning === 'off' ? false : opts.reasoning;
    }

    // Keep model loaded between requests (useful for digest cycles)
    if (opts?.keepAlive) {
      body.keep_alive = opts.keepAlive;
    }

    const response = await fetch(`${this.baseUrl}${ENDPOINT_GENERATE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Ollama summarize failed: ${response.status} ${errorBody.slice(0, 500)}`);
    }

    return this.readStream(response);
  }

  /** Read an Ollama streaming response (newline-delimited JSON) and accumulate the result. */
  private async readStream(response: Response): Promise<LlmResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let model = this.model;
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line) as { response?: string; model?: string; error?: string };
          if (chunk.error) throw new Error(`Ollama stream error: ${chunk.error}`);
          text += chunk.response ?? '';
          if (chunk.model) model = chunk.model;
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const chunk = JSON.parse(buffer) as { response?: string; model?: string; error?: string };
        if (chunk.error) throw new Error(`Ollama stream error: ${chunk.error}`);
        text += chunk.response ?? '';
        if (chunk.model) model = chunk.model;
      }
    } finally {
      reader.releaseLock();
    }

    return { text, model };
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${this.baseUrl}${ENDPOINT_EMBED}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
      signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][]; model: string };
    const embedding = data.embeddings[0];
    return { embedding, model: data.model, dimensions: embedding.length };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}${ENDPOINT_TAGS}`, {
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** List available models on this Ollama instance. */
  async listModels(timeoutMs?: number): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}${ENDPOINT_TAGS}`, {
        signal: AbortSignal.timeout(timeoutMs ?? DAEMON_CLIENT_TIMEOUT_MS),
      });
      const data = await response.json() as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }
}
