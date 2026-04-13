import { CloudEmbeddingBase } from './cloud-embedding-base.js';

/** Environment variable for OpenRouter API key (stored in secrets.env). */
export const OPENROUTER_API_KEY_ENV = 'MYCO_OPENROUTER_API_KEY';

export class OpenRouterEmbeddingProvider extends CloudEmbeddingBase {
  constructor(opts?: { api_key?: string; model?: string }) {
    super({
      apiBase: 'https://openrouter.ai/api/v1',
      modelsEndpoint: '/models',
      embeddingsEndpoint: '/embeddings',
      apiKeyEnvVar: OPENROUTER_API_KEY_ENV,
      defaultModel: 'openai/text-embedding-3-small',
      providerName: 'openrouter',
      modelFilter: (id) => id.includes('embed'),
    }, opts);
  }
}
