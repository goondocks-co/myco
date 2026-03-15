import { describe, it, expect } from 'vitest';
import type { LlmProvider, LlmResponse, EmbeddingProvider, EmbeddingResponse, LlmRequestOptions } from '@myco/intelligence/llm';
import { createLlmProvider, createEmbeddingProvider } from '@myco/intelligence/llm';

describe('LlmProvider interface', () => {
  it('defines summarize with optional LlmRequestOptions', () => {
    const mock: LlmProvider = {
      name: 'mock',
      async summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse> {
        return { text: 'result', model: 'mock' };
      },
      async isAvailable() { return true; },
    };
    expect(mock.name).toBe('mock');
  });
});

describe('EmbeddingProvider interface', () => {
  it('defines embed', () => {
    const mock: EmbeddingProvider = {
      name: 'mock',
      async embed(text: string): Promise<EmbeddingResponse> {
        return { embedding: [0.1], model: 'mock', dimensions: 1 };
      },
      async isAvailable() { return true; },
    };
    expect(mock.name).toBe('mock');
  });
});

describe('createLlmProvider', () => {
  it('returns OllamaBackend for ollama provider', () => {
    const backend = createLlmProvider({ provider: 'ollama', model: 'gpt-oss' });
    expect(backend.name).toBe('ollama');
  });

  it('returns LmStudioBackend for lm-studio provider', () => {
    const backend = createLlmProvider({ provider: 'lm-studio', model: 'gpt-oss' });
    expect(backend.name).toBe('lm-studio');
  });

  it('returns AnthropicBackend for anthropic provider', () => {
    const backend = createLlmProvider({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    expect(backend.name).toBe('anthropic');
  });

  it('throws for unknown provider', () => {
    expect(() => createLlmProvider({ provider: 'unknown' as any, model: 'x' })).toThrow(/Unknown LLM provider/);
  });
});

describe('createEmbeddingProvider', () => {
  it('returns OllamaBackend for ollama provider', () => {
    const backend = createEmbeddingProvider({ provider: 'ollama', model: 'bge-m3' });
    expect(backend.name).toBe('ollama');
  });

  it('returns LmStudioBackend for lm-studio provider', () => {
    const backend = createEmbeddingProvider({ provider: 'lm-studio', model: 'bge-m3' });
    expect(backend.name).toBe('lm-studio');
  });

  it('throws for anthropic provider', () => {
    expect(() => createEmbeddingProvider({ provider: 'anthropic', model: 'x' })).toThrow(/does not support embeddings/);
  });

  it('throws for unknown provider', () => {
    expect(() => createEmbeddingProvider({ provider: 'unknown' as any, model: 'x' })).toThrow(/does not support embeddings/);
  });
});
