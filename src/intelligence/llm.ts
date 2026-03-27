import { OllamaBackend } from './ollama.js';
import { LmStudioBackend } from './lm-studio.js';
import { AnthropicBackend } from './anthropic.js';
import { OpenRouterEmbeddingProvider } from '../cli/providers/openrouter.js';
import { OpenAIEmbeddingProvider } from '../cli/providers/openai-embeddings.js';

export interface LlmRequestOptions {
  maxTokens?: number;
  timeoutMs?: number;
  /** Per-request context length (tokens). Supported by LM Studio and Ollama. */
  contextLength?: number;
  /** Control reasoning/thinking output. 'off' suppresses chain-of-thought. LM Studio native API only. */
  reasoning?: 'off' | 'low' | 'medium' | 'high' | 'on';
  /** System prompt, sent separately from user content. Supported by LM Studio and Ollama native APIs. */
  systemPrompt?: string;
  /** Keep model loaded for this duration after request (e.g., "10m"). Ollama only. */
  keepAlive?: string;
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
  /** Pre-load the model with specific settings. Optional — only LM Studio implements this. */
  ensureLoaded?(contextLength?: number, gpuKvCache?: boolean): Promise<void>;
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
    case 'openai-compatible':
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
    case 'openai-compatible':
      return new LmStudioBackend(config);
    case 'openrouter':
      return new OpenRouterEmbeddingProvider({ model: config.model });
    case 'openai':
      return new OpenAIEmbeddingProvider({ model: config.model });
    default:
      throw new Error(`Provider "${config.provider}" does not support embeddings.`);
  }
}
