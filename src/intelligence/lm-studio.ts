import type { LlmBackend, LlmResponse, EmbeddingResponse } from './llm.js';

interface LmStudioConfig {
  embedding_model?: string;
  summary_model?: string;
  base_url?: string;
}

export class LmStudioBackend implements LlmBackend {
  readonly name = 'lm-studio';
  private baseUrl: string;
  private summaryModel: string;
  private embeddingModel: string;

  constructor(config?: LmStudioConfig) {
    this.baseUrl = config?.base_url ?? 'http://localhost:1234';
    this.summaryModel = config?.summary_model ?? 'llama3.2';
    this.embeddingModel = config?.embedding_model ?? 'nomic-embed-text';
  }

  async summarize(prompt: string): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.summaryModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
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
        model: this.embeddingModel,
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
