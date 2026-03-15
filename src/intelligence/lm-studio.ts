import type { LlmProvider, EmbeddingProvider, LlmResponse, EmbeddingResponse, LlmRequestOptions } from './llm.js';

interface LmStudioConfig {
  model?: string;
  base_url?: string;
  max_tokens?: number;
  // Legacy fields
  embedding_model?: string;
  summary_model?: string;
}

export class LmStudioBackend implements LlmProvider, EmbeddingProvider {
  readonly name = 'lm-studio';
  private baseUrl: string;
  private model: string;
  private defaultMaxTokens: number;

  constructor(config?: LmStudioConfig) {
    this.baseUrl = config?.base_url ?? 'http://localhost:1234';
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
      const response = await fetch(`${this.baseUrl}/v1/models`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
