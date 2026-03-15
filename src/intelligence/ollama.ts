import type { LlmProvider, EmbeddingProvider, LlmResponse, EmbeddingResponse, LlmRequestOptions } from './llm.js';
import { CHARS_PER_TOKEN } from '../constants.js';

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
  readonly name = 'ollama';
  private baseUrl: string;
  private model: string;
  private contextWindow: number;
  private defaultMaxTokens: number;

  constructor(config?: OllamaConfig) {
    this.baseUrl = config?.base_url ?? 'http://localhost:11434';
    this.model = config?.model ?? config?.summary_model ?? 'llama3.2';
    this.contextWindow = config?.context_window ?? 8192;
    this.defaultMaxTokens = config?.max_tokens ?? 1024;
  }

  async summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse> {
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;
    const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    const numCtx = Math.max(promptTokens + maxTokens, this.contextWindow);

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: { num_ctx: numCtx },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama summarize failed: ${response.status} ${response.statusText}`);
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
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
