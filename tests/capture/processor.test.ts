import { describe, it, expect, vi } from 'vitest';
import { BufferProcessor, type ProcessorResult } from '@myco/daemon/processor';
import type { LlmBackend } from '@myco/intelligence/llm';

describe('BufferProcessor', () => {
  const mockBackend: LlmBackend = {
    name: 'mock',
    async summarize(prompt: string): Promise<{ text: string; model: string }> {
      return {
        text: JSON.stringify({
          summary: 'Refactored auth middleware to use JWT rotation.',
          observations: [
            {
              type: 'decision',
              title: 'RS256 over HS256',
              content: 'Chose RS256 for key rotation support. HS256 cannot rotate without invalidating all tokens.',
              tags: ['auth', 'jwt'],
            },
          ],
        }),
        model: 'mock',
      };
    },
    async embed() { return { embedding: [], model: 'mock', dimensions: 0 }; },
    async isAvailable() { return true; },
  };

  it('processes buffer events into summary + observations', async () => {
    const events = [
      { type: 'tool_use', tool: 'Read', input: { path: 'src/auth.ts' }, timestamp: '2026-03-12T09:00:00Z' },
      { type: 'tool_use', tool: 'Edit', input: { path: 'src/auth.ts' }, timestamp: '2026-03-12T09:01:00Z' },
      { type: 'tool_use', tool: 'Bash', input: { command: 'npm test' }, timestamp: '2026-03-12T09:02:00Z' },
    ];

    const processor = new BufferProcessor(mockBackend);
    const result = await processor.process(events, 'session-abc');

    expect(result.summary).toContain('auth');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].type).toBe('decision');
  });

  it('builds extraction prompt with event summary', async () => {
    const events = [
      { type: 'tool_use', tool: 'Read', input: { path: 'src/foo.ts' } },
    ];

    const processor = new BufferProcessor(mockBackend);
    const promptSpy = vi.spyOn(mockBackend, 'summarize');
    await processor.process(events, 'session-abc');

    const calledPrompt = promptSpy.mock.calls[0][0];
    expect(calledPrompt).toContain('session-abc');
    expect(calledPrompt).toContain('Read');
  });

  it('returns empty observations when LLM returns none', async () => {
    const emptyBackend: LlmBackend = {
      ...mockBackend,
      async summarize() {
        return {
          text: JSON.stringify({ summary: 'Explored the codebase.', observations: [] }),
          model: 'mock',
        };
      },
    };

    const processor = new BufferProcessor(emptyBackend);
    const result = await processor.process([{ type: 'tool_use', tool: 'Grep' }], 's1');

    expect(result.summary).toBe('Explored the codebase.');
    expect(result.observations).toEqual([]);
  });

  it('handles LLM failure gracefully', async () => {
    const failBackend: LlmBackend = {
      ...mockBackend,
      async summarize() { throw new Error('LLM unavailable'); },
    };

    const processor = new BufferProcessor(failBackend);
    const result = await processor.process([{ type: 'tool_use', tool: 'Read' }], 's1');

    expect(result.summary).toContain('LLM processing failed');
    expect(result.degraded).toBe(true);
  });
});
