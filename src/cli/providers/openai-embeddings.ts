import type { EmbeddingProvider, EmbeddingResponse } from '../../intelligence/llm.js';
import { EMBEDDING_REQUEST_TIMEOUT_MS, PROVIDER_DETECT_TIMEOUT_MS } from '../../constants.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const OPENAI_MODELS_ENDPOINT = '/models';
const OPENAI_EMBEDDINGS_ENDPOINT = '/embeddings';

/** Environment variable for OpenAI API key (stored in secrets.env). */
const OPENAI_API_KEY_ENV = 'MYCO_OPENAI_API_KEY';

interface OpenAIEmbeddingConfig {
  api_key?: string;
  model?: string;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  private apiKey: string;
  private model: string;

  constructor(config: OpenAIEmbeddingConfig) {
    this.apiKey = config.api_key ?? process.env[OPENAI_API_KEY_ENV] ?? '';
    this.model = config.model ?? 'text-embedding-3-small';
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${OPENAI_API_BASE}${OPENAI_EMBEDDINGS_ENDPOINT}`, {
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
      throw new Error(`OpenAI embed failed: ${response.status} ${body.slice(0, 500)}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }>; model: string };
    const embedding = data.data[0].embedding;
    return { embedding, model: data.model, dimensions: embedding.length };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${OPENAI_API_BASE}${OPENAI_MODELS_ENDPOINT}`, {
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
      const response = await fetch(`${OPENAI_API_BASE}${OPENAI_MODELS_ENDPOINT}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs ?? PROVIDER_DETECT_TIMEOUT_MS),
      });
      const data = await response.json() as { data: Array<{ id: string; owned_by: string }> };
      return data.data
        .filter((m) => m.id.includes('embedding'))
        .map((m) => m.id);
    } catch {
      return [];
    }
  }
}
