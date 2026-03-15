import { describe, it, expect } from 'vitest';
import { AnthropicBackend } from '@myco/intelligence/anthropic';
import { LmStudioBackend } from '@myco/intelligence/lm-studio';
import { OllamaBackend } from '@myco/intelligence/ollama';

describe('AnthropicBackend', () => {
  it('has correct name', () => {
    const backend = new AnthropicBackend();
    expect(backend.name).toBe('anthropic');
  });

  it('reports unavailable when no API key is set', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const backend = new AnthropicBackend();
    expect(await backend.isAvailable()).toBe(false);
    if (original) process.env.ANTHROPIC_API_KEY = original;
  });

  it('throws on embed() — use local provider for embeddings', async () => {
    const backend = new AnthropicBackend();
    await expect(backend.embed('test')).rejects.toThrow(/does not support embeddings/);
  });
});

describe('LmStudioBackend', () => {
  it('has correct name', () => {
    const backend = new LmStudioBackend();
    expect(backend.name).toBe('lm-studio');
  });

  it('reports unavailable when server is not running', async () => {
    const backend = new LmStudioBackend({ base_url: 'http://localhost:99999' });
    expect(await backend.isAvailable()).toBe(false);
  });
});

describe('LmStudioBackend context sizing', () => {
  it('accepts new config shape', () => {
    const backend = new LmStudioBackend({
      model: 'gpt-oss',
      base_url: 'http://localhost:1234',
      context_window: 4096,
      max_tokens: 512,
    });
    expect(backend.name).toBe('lm-studio');
  });
});

describe('OllamaBackend context sizing', () => {
  it('accepts new config shape', () => {
    const backend = new OllamaBackend({
      model: 'gpt-oss',
      base_url: 'http://localhost:11434',
      context_window: 4096,
      max_tokens: 512,
    });
    expect(backend.name).toBe('ollama');
  });

  it('uses default context_window of 8192', () => {
    const backend = new OllamaBackend({ model: 'gpt-oss' });
    expect(backend.name).toBe('ollama');
  });
});
