import { describe, it, expect } from 'vitest';
import { codexAdapter } from '@myco/symbionts/codex.js';

/** Build a JSONL string from an array of objects. */
function toJsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

/** Helper: build a Codex response_item with a message payload. */
function messageItem(
  role: string,
  blocks: Array<{ type: string; text?: string }>,
  timestamp?: string,
): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: { type: 'message', role, content: blocks },
    ...(timestamp ? { timestamp } : {}),
  };
}

/** Helper: build a Codex response_item with a function_call payload. */
function functionCallItem(name: string, args: string, timestamp?: string): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: args },
    ...(timestamp ? { timestamp } : {}),
  };
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
        messageItem('user', [{ type: 'input_text', text: 'Hello from Codex' }], '2026-04-13T10:00:00Z'),
        messageItem(
          'assistant',
          [{ type: 'output_text', text: 'Hi there!' }],
          '2026-04-13T10:00:30Z',
        ),
        functionCallItem('Read', '{}', '2026-04-13T10:00:20Z'),
      ]);

      const turns = codexAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Hello from Codex');
      expect(turns[0].aiResponse).toBe('Hi there!');
      expect(turns[0].toolCount).toBe(1);
    });

    it('handles multiple conversation turns', () => {
      const content = toJsonl([
        messageItem('user', [{ type: 'input_text', text: 'First prompt' }], '2026-04-13T10:00:00Z'),
        messageItem(
          'assistant',
          [{ type: 'output_text', text: 'First response' }],
          '2026-04-13T10:00:30Z',
        ),
        messageItem('user', [{ type: 'input_text', text: 'Second prompt' }], '2026-04-13T10:01:00Z'),
        functionCallItem('Edit', '{"path":"/foo.ts"}', '2026-04-13T10:01:10Z'),
        functionCallItem('Write', '{"path":"/bar.ts"}', '2026-04-13T10:01:20Z'),
        messageItem(
          'assistant',
          [{ type: 'output_text', text: 'Done editing' }],
          '2026-04-13T10:01:30Z',
        ),
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
        // user message with no input_text blocks — should be skipped
        messageItem('user', [{ type: 'other_type', text: 'ignored' }], '2026-04-13T10:00:00Z'),
        messageItem('user', [{ type: 'input_text', text: 'Real prompt' }], '2026-04-13T10:00:10Z'),
        messageItem(
          'assistant',
          [{ type: 'output_text', text: 'Response' }],
          '2026-04-13T10:00:30Z',
        ),
      ]);

      const turns = codexAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Real prompt');
    });

    it('returns empty array for empty content', () => {
      expect(codexAdapter.parseTurns('')).toHaveLength(0);
    });

    it('skips malformed JSON lines', () => {
      const validLine = JSON.stringify(
        messageItem('user', [{ type: 'input_text', text: 'Valid line' }], '2026-04-13T10:00:00Z'),
      );
      const content = 'not json\n' + validLine;

      const turns = codexAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Valid line');
    });
  });
});
