import { OllamaBackend } from './ollama.js';
import { LmStudioBackend } from './lm-studio.js';
import { AnthropicBackend } from './anthropic.js';

export interface LlmRequestOptions {
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
}

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
  dimensions: number;
}

export interface LlmProvider {
  name: string;
  summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse>;
  isAvailable(): Promise<boolean>;
}

export interface EmbeddingProvider {
  name: string;
  embed(text: string): Promise<EmbeddingResponse>;
  isAvailable(): Promise<boolean>;
}

interface ProviderConfig {
  provider: string;
  model: string;
  base_url?: string;
  context_window?: number;
  max_tokens?: number;
}

export function createLlmProvider(config: ProviderConfig): LlmProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaBackend(config);
    case 'lm-studio':
      return new LmStudioBackend(config);
    case 'anthropic':
      return new AnthropicBackend(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

export function createEmbeddingProvider(config: ProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaBackend(config);
    case 'lm-studio':
      return new LmStudioBackend(config);
    default:
      throw new Error(`Provider "${config.provider}" does not support embeddings. Use ollama or lm-studio.`);
  }
}
