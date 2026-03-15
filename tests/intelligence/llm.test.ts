import { describe, it, expect, vi } from 'vitest';
import type { LlmBackend, LlmResponse, EmbeddingResponse } from '@myco/intelligence/llm';
import { createLlmBackend } from '@myco/intelligence/llm';

describe('LLM Abstraction', () => {
  it('defines LlmBackend interface with summarize and embed', () => {
    const mock: LlmBackend = {
      name: 'mock',
      async summarize(prompt: string): Promise<LlmResponse> {
        return { text: 'summary', model: 'mock-model' };
      },
      async embed(text: string): Promise<EmbeddingResponse> {
        return { embedding: [0.1, 0.2], model: 'mock-embed', dimensions: 2 };
      },
      async isAvailable(): Promise<boolean> {
        return true;
      },
    };
    expect(mock.name).toBe('mock');
  });

  it('createLlmBackend returns ollama backend for local config', async () => {
    const backend = await createLlmBackend({
      backend: 'local',
      local: {
        provider: 'ollama',
        embedding_model: 'nomic-embed-text',
        summary_model: 'llama3.2',
        base_url: 'http://localhost:11434',
      },
    });
    expect(backend.name).toBe('ollama');
  });

  it('createLlmBackend returns haiku backend for cloud config', async () => {
    const backend = await createLlmBackend({
      backend: 'cloud',
      cloud: {
        summary_model: 'claude-haiku-4-5-20251001',
        embedding_provider: 'voyage',
      },
    });
    expect(backend.name).toBe('haiku');
  });
});
