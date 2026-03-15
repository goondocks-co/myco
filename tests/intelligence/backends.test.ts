import { describe, it, expect } from 'vitest';
import { HaikuBackend } from '@myco/intelligence/haiku';
import { LmStudioBackend } from '@myco/intelligence/lm-studio';

describe('HaikuBackend', () => {
  it('has correct name', () => {
    const backend = new HaikuBackend();
    expect(backend.name).toBe('haiku');
  });

  it('reports unavailable when no API key is set', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const backend = new HaikuBackend();
    expect(await backend.isAvailable()).toBe(false);
    if (original) process.env.ANTHROPIC_API_KEY = original;
  });

  it('throws on embed() — cloud embeddings use Voyage AI', async () => {
    const backend = new HaikuBackend();
    await expect(backend.embed('test')).rejects.toThrow(/Voyage/);
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
