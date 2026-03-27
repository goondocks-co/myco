import type { EmbeddingProvider, EmbeddingResponse } from '../../intelligence/llm.js';
import { EMBEDDING_REQUEST_TIMEOUT_MS, PROVIDER_DETECT_TIMEOUT_MS } from '../../constants.js';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS_ENDPOINT = '/models';
const OPENROUTER_EMBEDDINGS_ENDPOINT = '/embeddings';

/** Environment variable for OpenRouter API key (stored in secrets.env). */
const OPENROUTER_API_KEY_ENV = 'MYCO_OPENROUTER_API_KEY';

interface OpenRouterConfig {
  api_key?: string;
  model?: string;
}

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private model: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.api_key ?? process.env[OPENROUTER_API_KEY_ENV] ?? '';
    this.model = config.model ?? 'openai/text-embedding-3-small';
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${OPENROUTER_API_BASE}${OPENROUTER_EMBEDDINGS_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
      signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenRouter embed failed: ${response.status} ${body.slice(0, 500)}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }>; model: string };
    const embedding = data.data[0].embedding;
    return { embedding, model: data.model, dimensions: embedding.length };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${OPENROUTER_API_BASE}${OPENROUTER_MODELS_ENDPOINT}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(PROVIDER_DETECT_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(timeoutMs?: number): Promise<string[]> {
    try {
      const response = await fetch(`${OPENROUTER_API_BASE}${OPENROUTER_MODELS_ENDPOINT}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs ?? PROVIDER_DETECT_TIMEOUT_MS),
      });
      const data = await response.json() as { data: Array<{ id: string; context_length?: number }> };
      return data.data
        .filter((m) => m.id.includes('embed'))
        .map((m) => m.id);
    } catch {
      return [];
    }
  }
}
