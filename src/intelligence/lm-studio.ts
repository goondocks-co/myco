import type { LlmProvider, EmbeddingProvider, LlmResponse, EmbeddingResponse, LlmRequestOptions } from './llm.js';
import { LLM_REQUEST_TIMEOUT_MS, EMBEDDING_REQUEST_TIMEOUT_MS, DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';

interface LmStudioConfig {
  model?: string;
  base_url?: string;
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
  private defaultMaxTokens: number;

  constructor(config?: LmStudioConfig) {
    this.baseUrl = config?.base_url ?? LmStudioBackend.DEFAULT_BASE_URL;
    this.model = config?.model ?? config?.summary_model ?? 'llama3.2';
    this.defaultMaxTokens = config?.max_tokens ?? 1024;
  }

  async summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse> {
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`LM Studio summarize failed: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
    };
    return { text: data.choices[0].message.content, model: data.model };
  }

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
