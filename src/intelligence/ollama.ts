import type { LlmBackend, LlmResponse, EmbeddingResponse } from './llm.js';

interface OllamaConfig {
  embedding_model?: string;
  summary_model?: string;
  base_url?: string;
}

export class OllamaBackend implements LlmBackend {
  readonly name = 'ollama';
  private baseUrl: string;
  private summaryModel: string;
  private embeddingModel: string;

  constructor(config?: OllamaConfig) {
    this.baseUrl = config?.base_url ?? 'http://localhost:11434';
    this.summaryModel = config?.summary_model ?? 'llama3.2';
    this.embeddingModel = config?.embedding_model ?? 'nomic-embed-text';
  }

  async summarize(prompt: string): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.summaryModel,
        prompt,
        stream: false,
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
        model: this.embeddingModel,
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
