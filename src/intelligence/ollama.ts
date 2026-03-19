import type { LlmProvider, EmbeddingProvider, LlmResponse, EmbeddingResponse, LlmRequestOptions } from './llm.js';
import { estimateTokens, LLM_REQUEST_TIMEOUT_MS, EMBEDDING_REQUEST_TIMEOUT_MS, DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';

interface OllamaConfig {
  model?: string;
  base_url?: string;
  context_window?: number;
  max_tokens?: number;
  // Legacy fields (ignored, kept for backward compat during migration)
  embedding_model?: string;
  summary_model?: string;
}

export class OllamaBackend implements LlmProvider, EmbeddingProvider {
  static readonly DEFAULT_BASE_URL = 'http://localhost:11434';
  readonly name = 'ollama';
  private baseUrl: string;
  private model: string;
  private contextWindow: number;
  private defaultMaxTokens: number;

  constructor(config?: OllamaConfig) {
    this.baseUrl = config?.base_url ?? OllamaBackend.DEFAULT_BASE_URL;
    this.model = config?.model ?? config?.summary_model ?? 'llama3.2';
    this.contextWindow = config?.context_window ?? 8192;
    this.defaultMaxTokens = config?.max_tokens ?? 1024;
  }

  async summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse> {
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;
    const contextLength = opts?.contextLength ?? this.contextWindow;
    const promptTokens = estimateTokens(prompt);
    const numCtx = Math.max(promptTokens + maxTokens, contextLength);

    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: false,
      options: {
        num_ctx: numCtx,
        num_predict: maxTokens,
      },
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

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Ollama summarize failed: ${response.status} ${errorBody.slice(0, 500)}`);
    }

    const data = await response.json() as { response: string; model: string };
    return { text: data.response, model: data.model };
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
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
      const response = await fetch(`${this.baseUrl}/api/tags`, {
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
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs ?? DAEMON_CLIENT_TIMEOUT_MS),
      });
      const data = await response.json() as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }
}
