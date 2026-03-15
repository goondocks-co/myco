import { describe, it, expect } from 'vitest';
import { BufferProcessor } from '@myco/daemon/processor';
import type { LlmBackend, LlmResponse, EmbeddingResponse } from '@myco/intelligence/llm';

function mockBackend(response: string): LlmBackend {
  return {
    name: 'mock',
    summarize: async () => ({ text: response, model: 'mock' }),
    embed: async () => ({ embedding: [], model: 'mock', dimensions: 0 }),
    isAvailable: async () => true,
  };
}

function failingBackend(): LlmBackend {
  return {
    name: 'mock',
    summarize: async () => { throw new Error('LLM unavailable'); },
    embed: async () => ({ embedding: [], model: 'mock', dimensions: 0 }),
    isAvailable: async () => false,
  };
}

describe('classifyArtifacts', () => {
  it('parses valid classification response', async () => {
    const backend = mockBackend(JSON.stringify({
      artifacts: [
        {
          source_path: 'docs/spec.md',
          artifact_type: 'spec',
          title: 'Design Spec',
          tags: ['auth'],
        },
      ],
    }));
    const processor = new BufferProcessor(backend);

    const result = await processor.classifyArtifacts(
      [{ path: 'docs/spec.md', content: '# Spec' }],
      'test-session',
    );

    expect(result).toHaveLength(1);
    expect(result[0].source_path).toBe('docs/spec.md');
    expect(result[0].artifact_type).toBe('spec');
    expect(result[0].title).toBe('Design Spec');
  });

  it('returns empty array for no artifacts response', async () => {
    const backend = mockBackend('{"artifacts": []}');
    const processor = new BufferProcessor(backend);

    const result = await processor.classifyArtifacts(
      [{ path: 'src/index.ts', content: 'export const x = 1;' }],
      'test-session',
    );

    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty candidates', async () => {
    const backend = mockBackend('should not be called');
    const processor = new BufferProcessor(backend);

    const result = await processor.classifyArtifacts([], 'test-session');

    expect(result).toHaveLength(0);
  });

  it('throws on LLM failure so caller can log at warn level', async () => {
    const processor = new BufferProcessor(failingBackend());

    await expect(
      processor.classifyArtifacts(
        [{ path: 'docs/spec.md', content: '# Spec' }],
        'test-session',
      ),
    ).rejects.toThrow('LLM unavailable');
  });

  it('throws on malformed JSON so caller can log at warn level', async () => {
    const backend = mockBackend('not valid json {{{');
    const processor = new BufferProcessor(backend);

    await expect(
      processor.classifyArtifacts(
        [{ path: 'docs/spec.md', content: '# Spec' }],
        'test-session',
      ),
    ).rejects.toThrow();
  });
});
