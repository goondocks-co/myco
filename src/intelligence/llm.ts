import type { MycoConfig } from '../config/schema.js';

export interface LlmResponse {
  text: string;
  model: string;
}

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
  dimensions: number;
}

export interface LlmBackend {
  name: string;
  summarize(prompt: string): Promise<LlmResponse>;
  embed(text: string): Promise<EmbeddingResponse>;
  isAvailable(): Promise<boolean>;
}

export async function createLlmBackend(intelligence: MycoConfig['intelligence']): Promise<LlmBackend> {
  if (intelligence.backend === 'cloud') {
    const { HaikuBackend } = await import('./haiku.js');
    return new HaikuBackend(intelligence.cloud);
  }

  const provider = intelligence.local?.provider ?? 'ollama';
  if (provider === 'lm-studio') {
    const { LmStudioBackend } = await import('./lm-studio.js');
    return new LmStudioBackend(intelligence.local);
  }

  const { OllamaBackend } = await import('./ollama.js');
  return new OllamaBackend(intelligence.local);
}
