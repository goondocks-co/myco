import type { EmbeddingProvider, EmbeddingResponse } from '../../intelligence/llm.js';
import { EMBEDDING_REQUEST_TIMEOUT_MS, PROVIDER_DETECT_TIMEOUT_MS } from '../../constants.js';

/** Max characters of error response body to include in error messages. */
const ERROR_BODY_PREVIEW_CHARS = 500;

interface CloudEmbeddingConfig {
  apiBase: string;
  modelsEndpoint: string;
  embeddingsEndpoint: string;
  apiKeyEnvVar: string;
  defaultModel: string;
  providerName: string;
  /** Filter predicate for model listing — only models matching this are returned. */
  modelFilter: (modelId: string) => boolean;
}

export abstract class CloudEmbeddingBase implements EmbeddingProvider {
  readonly name: string;
  protected apiKey: string;
  protected model: string;
  private config: CloudEmbeddingConfig;

  constructor(
    config: CloudEmbeddingConfig,
    opts?: { api_key?: string; model?: string },
  ) {
    this.config = config;
    this.name = config.providerName;
    this.apiKey = opts?.api_key ?? process.env[config.apiKeyEnvVar] ?? '';
    this.model = opts?.model ?? config.defaultModel;
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${this.config.apiBase}${this.config.embeddingsEndpoint}`, {
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
      throw new Error(`${this.name} embed failed: ${response.status} ${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }>; model: string };
    const embedding = data.data[0].embedding;
    return { embedding, model: data.model, dimensions: embedding.length };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.apiBase}${this.config.modelsEndpoint}`, {
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
      const response = await fetch(`${this.config.apiBase}${this.config.modelsEndpoint}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs ?? PROVIDER_DETECT_TIMEOUT_MS),
      });
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data
        .filter((m) => this.config.modelFilter(m.id))
        .map((m) => m.id);
    } catch {
      return [];
    }
  }
}
