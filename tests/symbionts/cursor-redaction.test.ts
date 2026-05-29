import { describe, it, expect } from 'bun:test';
import { cursorAdapter } from '@myco/symbionts/cursor.js';

// Cursor's JSONL transcript embeds literal `[REDACTED]` blocks for intermediate
// tool-reasoning / thinking turns. These MUST NOT leak into response_summary.

describe('cursorAdapter.parseTurns — [REDACTED] handling', () => {
  function build(lines: Array<Record<string, unknown>>): string {
    return lines.map((l) => JSON.stringify(l)).join('\n');
  }

  it('strips trailing [REDACTED] appended to the final assistant text', () => {
    const content = build([
      { role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello. I\'m here to help.\n\n[REDACTED]' },
          ],
        },
      },
    ]);
    const turns = cursorAdapter.parseTurns(content);
    expect(turns).toHaveLength(1);
    expect(turns[0].aiResponse).toBe("Hello. I'm here to help.");
  });

  it('drops aiResponse entirely when the text is just [REDACTED]', () => {
    const content = build([
      { role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
      {
        role: 'assistant',
        message: { content: [{ type: 'text', text: '[REDACTED]' }] },
      },
    ]);
    const turns = cursorAdapter.parseTurns(content);
    expect(turns).toHaveLength(1);
    expect(turns[0].aiResponse).toBeUndefined();
  });

  it('preserves substantive text fragments across multiple assistant entries, stripping interleaved [REDACTED] scratch', () => {
    // Real Cursor transcript shape: assistant entries appear line-by-line in a
    // multi-step turn (text → tool → text → tool → text). Before the
    // parser-concat fix the response was overwritten per entry so only the
    // trailing fragment survived; with concat both substantive fragments are
    // kept, and the redaction strip removes the [REDACTED] markers + collapses
    // the empty middle so the captured summary reads naturally.
    const content = build([
      { role: 'user', message: { content: [{ type: 'text', text: 'tell me about X' }] } },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Gathering info.\n\n[REDACTED]' },
            { type: 'tool_use', name: 'Shell', input: {} },
          ],
        },
      },
      {
        role: 'assistant',
        message: { content: [{ type: 'text', text: '[REDACTED]' }] },
      },
      {
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'Here is the answer.' }] },
      },
    ]);
    const turns = cursorAdapter.parseTurns(content);
    expect(turns).toHaveLength(1);
    expect(turns[0].aiResponse).toBe('Gathering info.\nHere is the answer.');
  });
});
