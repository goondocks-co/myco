import { describe, it, expect } from 'bun:test';
import { CodexJsonlParser } from '@myco/symbionts/parsers/codex-jsonl.js';

/**
 * Build a JSONL string from an array of entry objects.
 */
function toJsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Helper to build a Codex response_item with a message payload. */
function messageItem(role: string, blocks: Array<{ type: string; text?: string }>, timestamp?: string): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: { type: 'message', role, content: blocks },
    ...(timestamp ? { timestamp } : {}),
  };
}

/** Helper to build a Codex response_item with a function_call payload. */
function functionCallItem(name: string, args: string, timestamp?: string): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: args },
    ...(timestamp ? { timestamp } : {}),
  };
}

describe('CodexJsonlParser', () => {
  const parser = new CodexJsonlParser();

  it('parses user and assistant messages from nested payload', () => {
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: 'Fix the bug' }], '2026-04-12T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'I found the issue and fixed it.' }], '2026-04-12T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('Fix the bug');
    expect(turns[0].aiResponse).toBe('I found the issue and fixed it.');
    expect(turns[0].toolCount).toBe(0);
    expect(turns[0].timestamp).toBe('2026-04-12T10:00:00Z');
  });

  it('counts function_call entries as tool use', () => {
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: 'Read and edit the file' }], '2026-04-12T10:00:00Z'),
      functionCallItem('read_file', '{"path":"/foo.ts"}', '2026-04-12T10:00:10Z'),
      functionCallItem('edit_file', '{"path":"/foo.ts"}', '2026-04-12T10:00:20Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Done.' }], '2026-04-12T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].toolCount).toBe(2);
    expect(turns[0].aiResponse).toBe('Done.');
  });

  it('skips developer messages', () => {
    const content = toJsonl([
      messageItem('developer', [{ type: 'input_text', text: 'System instructions here' }], '2026-04-12T09:59:00Z'),
      messageItem('user', [{ type: 'input_text', text: 'Hello' }], '2026-04-12T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Hi!' }], '2026-04-12T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('Hello');
  });

  it('skips event_msg, session_meta, turn_context, and reasoning entries', () => {
    const content = toJsonl([
      { type: 'event_msg', data: 'connected' },
      { type: 'session_meta', session_id: 'abc123' },
      { type: 'turn_context', context: 'something' },
      { type: 'reasoning', content: 'thinking...' },
      messageItem('user', [{ type: 'input_text', text: 'Hello' }], '2026-04-12T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Hi!' }], '2026-04-12T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('Hello');
    expect(turns[0].aiResponse).toBe('Hi!');
  });

  it('handles multiple user-assistant turns', () => {
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: 'First question' }], '2026-04-12T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'First answer' }], '2026-04-12T10:00:30Z'),
      messageItem('user', [{ type: 'input_text', text: 'Second question' }], '2026-04-12T10:01:00Z'),
      functionCallItem('read_file', '{"path":"/bar.ts"}', '2026-04-12T10:01:10Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Second answer' }], '2026-04-12T10:01:30Z'),
      messageItem('user', [{ type: 'input_text', text: 'Third question' }], '2026-04-12T10:02:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Third answer' }], '2026-04-12T10:02:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(3);
    expect(turns[0].prompt).toBe('First question');
    expect(turns[0].aiResponse).toBe('First answer');
    expect(turns[0].toolCount).toBe(0);
    expect(turns[1].prompt).toBe('Second question');
    expect(turns[1].aiResponse).toBe('Second answer');
    expect(turns[1].toolCount).toBe(1);
    expect(turns[2].prompt).toBe('Third question');
    expect(turns[2].aiResponse).toBe('Third answer');
    expect(turns[2].toolCount).toBe(0);
  });

  it('concatenates multiple output_text blocks in a single assistant message', () => {
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: 'Explain' }], '2026-04-12T10:00:00Z'),
      messageItem('assistant', [
        { type: 'output_text', text: 'First part.' },
        { type: 'output_text', text: 'Second part.' },
      ], '2026-04-12T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].aiResponse).toBe('First part.\nSecond part.');
  });

  it('preserves proposed_plan tags in aiResponse', () => {
    const planText = '<proposed_plan>\n## Phase 1\nDo the thing\n</proposed_plan>\n\nHere is my plan.';
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: 'Plan the feature' }], '2026-04-12T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: planText }], '2026-04-12T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].aiResponse).toContain('<proposed_plan>');
    expect(turns[0].aiResponse).toContain('</proposed_plan>');
    expect(turns[0].aiResponse).toBe(planText);
  });

  it('returns empty array for empty content', () => {
    expect(parser.parseTurns('')).toEqual([]);
  });

  it('skips malformed JSON lines', () => {
    const validEntry = JSON.stringify(
      messageItem('user', [{ type: 'input_text', text: 'Hello' }], '2026-04-12T10:00:00Z'),
    );
    const content = `not json\n${validEntry}\n{broken\n`;

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('Hello');
  });

  it('skips user messages with no text content', () => {
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: '' }], '2026-04-12T10:00:00Z'),
      messageItem('user', [{ type: 'input_text', text: '   ' }], '2026-04-12T10:00:10Z'),
      messageItem('user', [{ type: 'other_type', text: 'ignored' }], '2026-04-12T10:00:20Z'),
      messageItem('user', [{ type: 'input_text', text: 'Real prompt' }], '2026-04-12T10:01:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Response' }], '2026-04-12T10:01:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('Real prompt');
  });

  it('handles response_item with missing payload', () => {
    const content = toJsonl([
      { type: 'response_item' },
      messageItem('user', [{ type: 'input_text', text: 'Hello' }], '2026-04-12T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Hi!' }], '2026-04-12T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('Hello');
  });

  it('defaults timestamp to empty string when not present', () => {
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: 'No timestamp' }]),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].timestamp).toBe('');
  });

  it('extracts images from input_image blocks with data URLs', () => {
    const content = toJsonl([
      {
        type: 'response_item',
        timestamp: '2026-04-13T10:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Here is a screenshot' },
            { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
            { type: 'input_text', text: 'What do you see?' },
          ],
        },
      },
      messageItem('assistant', [{ type: 'output_text', text: 'I see a screenshot.' }], '2026-04-13T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toContain('Here is a screenshot');
    expect(turns[0].images).toHaveLength(1);
    expect(turns[0].images![0].data).toBe('iVBORw0KGgoAAAANSUhEUg==');
    expect(turns[0].images![0].mediaType).toBe('image/png');
  });

  it('extracts multiple images from a single user message', () => {
    const content = toJsonl([
      {
        type: 'response_item',
        timestamp: '2026-04-13T10:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Compare these two screenshots' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB' },
          ],
        },
      },
      messageItem('assistant', [{ type: 'output_text', text: 'They look different.' }], '2026-04-13T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].images).toHaveLength(2);
    expect(turns[0].images![0].mediaType).toBe('image/png');
    expect(turns[0].images![0].data).toBe('AAAA');
    expect(turns[0].images![1].mediaType).toBe('image/jpeg');
    expect(turns[0].images![1].data).toBe('BBBB');
  });

  it('does not set images field when no input_image blocks present', () => {
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: 'No images here' }], '2026-04-13T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Ok.' }], '2026-04-13T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].images).toBeUndefined();
  });

  it('skips input_image blocks with invalid data URLs', () => {
    const content = toJsonl([
      {
        type: 'response_item',
        timestamp: '2026-04-13T10:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Broken images' },
            { type: 'input_image', image_url: 'not-a-data-url' },
            { type: 'input_image', image_url: 'data:image/png;base64,VALID' },
          ],
        },
      },
      messageItem('assistant', [{ type: 'output_text', text: 'Got it.' }], '2026-04-13T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].images).toHaveLength(1);
    expect(turns[0].images![0].data).toBe('VALID');
  });

  it('strips Codex Desktop file-mention preamble from prompts', () => {
    const content = toJsonl([
      {
        type: 'response_item',
        timestamp: '2026-04-13T10:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '\n# Files mentioned by the user:\n\n## CleanShot 2026-04-13.png: /Users/chris/Library/Application Support/CleanShot/media/screenshot.png\n\n## My request for Codex:\nhello, what do you see in this screenshot?\n' },
            { type: 'input_text', text: '<image name=[Image #1]>' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_text', text: '</image>' },
          ],
        },
      },
      messageItem('assistant', [{ type: 'output_text', text: 'I see a screenshot.' }], '2026-04-13T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    // Preamble stripped, image wrapper tags stripped, only the actual question remains
    expect(turns[0].prompt).toBe('hello, what do you see in this screenshot?');
    expect(turns[0].images).toHaveLength(1);
  });

  it('strips image wrapper tags from prompts', () => {
    const content = toJsonl([
      {
        type: 'response_item',
        timestamp: '2026-04-13T10:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Look at this' },
            { type: 'input_text', text: '<image name=[Image #1]>' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_text', text: '</image>' },
          ],
        },
      },
      messageItem('assistant', [{ type: 'output_text', text: 'Got it.' }], '2026-04-13T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('Look at this');
    // Image wrapper tags should not appear in the prompt
    expect(turns[0].prompt).not.toContain('<image');
    expect(turns[0].prompt).not.toContain('</image>');
  });

  it('passes through normal prompts without preamble unchanged', () => {
    const content = toJsonl([
      messageItem('user', [{ type: 'input_text', text: 'Fix the bug in main.ts' }], '2026-04-13T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'On it.' }], '2026-04-13T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('Fix the bug in main.ts');
  });

  it('function_call before any user message does not crash', () => {
    const content = toJsonl([
      functionCallItem('init_fn', '{}', '2026-04-12T09:59:00Z'),
      messageItem('user', [{ type: 'input_text', text: 'Hello' }], '2026-04-12T10:00:00Z'),
      messageItem('assistant', [{ type: 'output_text', text: 'Hi!' }], '2026-04-12T10:00:30Z'),
    ]);

    const turns = parser.parseTurns(content);

    expect(turns).toHaveLength(1);
    expect(turns[0].toolCount).toBe(0); // function_call before user message is ignored
  });
});
