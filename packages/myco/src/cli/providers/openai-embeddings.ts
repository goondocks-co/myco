import { CloudEmbeddingBase } from './cloud-embedding-base.js';
import { OPENAI_API_KEY_ENV } from '@myco/providers/env.js';

export class OpenAIEmbeddingProvider extends CloudEmbeddingBase {
  constructor(opts?: { api_key?: string; model?: string }) {
    super({
      apiBase: 'https://api.openai.com/v1',
      modelsEndpoint: '/models',
      embeddingsEndpoint: '/embeddings',
      apiKeyEnvVar: OPENAI_API_KEY_ENV,
      defaultModel: 'text-embedding-3-small',
      providerName: 'openai',
      modelFilter: (id) => id.includes('embedding'),
    }, opts);
  }
}
