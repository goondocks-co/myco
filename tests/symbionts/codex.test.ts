import { describe, it, expect } from 'vitest';
import { codexAdapter } from '../../src/symbionts/codex.js';

/** Build a JSONL string from an array of objects. */
function toJsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

describe('codexAdapter', () => {
  it('has correct adapter metadata', () => {
    expect(codexAdapter.name).toBe('codex');
    expect(codexAdapter.displayName).toBe('Codex');
    expect(codexAdapter.pluginRootEnvVar).toBe('CODEX_PLUGIN_ROOT');
    expect(codexAdapter.hookFields.sessionId).toBe('session_id');
  });

  describe('parseTurns', () => {
    it('parses user and assistant turns from JSONL with role field', () => {
      const content = toJsonl([
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'Hello from Codex' }] },
        },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Hi there!' },
              { type: 'tool_use', name: 'Read', id: 't1' },
            ],
          },
        },
      ]);

      const turns = codexAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Hello from Codex');
      expect(turns[0].aiResponse).toBe('Hi there!');
      expect(turns[0].toolCount).toBe(1);
    });

    it('handles multiple conversation turns', () => {
      const content = toJsonl([
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'First prompt' }] },
        },
        {
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'First response' }] },
        },
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'Second prompt' }] },
        },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', id: 't1' },
              { type: 'tool_use', name: 'Write', id: 't2' },
              { type: 'text', text: 'Done editing' },
            ],
          },
        },
      ]);

      const turns = codexAdapter.parseTurns(content);
      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('First prompt');
      expect(turns[0].aiResponse).toBe('First response');
      expect(turns[0].toolCount).toBe(0);
      expect(turns[1].prompt).toBe('Second prompt');
      expect(turns[1].aiResponse).toBe('Done editing');
      expect(turns[1].toolCount).toBe(2);
    });

    it('skips entries with no text content', () => {
      const content = toJsonl([
        {
          role: 'user',
          message: { content: [{ type: 'image', source: { data: 'abc' } }] },
        },
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'Real prompt' }] },
        },
        {
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'Response' }] },
        },
      ]);

      const turns = codexAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Real prompt');
    });

    it('returns empty array for empty content', () => {
      expect(codexAdapter.parseTurns('')).toHaveLength(0);
    });

    it('skips malformed JSON lines', () => {
      const content = 'not json\n' + JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'Valid line' }] },
      });

      const turns = codexAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Valid line');
    });
  });
});
