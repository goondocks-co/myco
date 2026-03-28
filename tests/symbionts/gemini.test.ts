import { describe, it, expect } from 'vitest';
import { geminiAdapter } from '../../src/symbionts/gemini.js';

/** Build a minimal Gemini transcript JSON. */
function buildGeminiTranscript(messages: Array<{
  type: string;
  content: string | Array<{ text: string }>;
  timestamp?: string;
  toolCalls?: Array<{ name: string; args?: unknown }>;
}>): string {
  return JSON.stringify({ sessionId: 'test-session', messages });
}

describe('geminiAdapter.parseTurns', () => {
  it('parses user + gemini turn', () => {
    const content = buildGeminiTranscript([
      { type: 'user', content: [{ text: 'What files are in this project?' }], timestamp: '2026-03-28T19:29:10Z' },
      { type: 'gemini', content: 'I will start by reading README.md' },
    ]);
    const turns = geminiAdapter.parseTurns(content);
    expect(turns.length).toBe(1);
    expect(turns[0].prompt).toBe('What files are in this project?');
    expect(turns[0].aiResponse).toBe('I will start by reading README.md');
    expect(turns[0].toolCount).toBe(0);
    expect(turns[0].timestamp).toBe('2026-03-28T19:29:10Z');
  });

  it('counts tool calls from gemini messages', () => {
    const content = buildGeminiTranscript([
      { type: 'user', content: [{ text: 'Review the code' }] },
      { type: 'gemini', content: 'Let me read the files.', toolCalls: [
        { name: 'read_file', args: { file_path: 'README.md' } },
        { name: 'read_file', args: { file_path: 'package.json' } },
        { name: 'read_file', args: { file_path: 'tsconfig.json' } },
      ] },
    ]);
    const turns = geminiAdapter.parseTurns(content);
    expect(turns.length).toBe(1);
    expect(turns[0].toolCount).toBe(3);
  });

  it('accumulates tool calls across multiple gemini messages', () => {
    const content = buildGeminiTranscript([
      { type: 'user', content: [{ text: 'Analyze everything' }] },
      { type: 'gemini', content: 'Reading first file.', toolCalls: [{ name: 'read_file' }] },
      { type: 'gemini', content: 'Reading second file.', toolCalls: [{ name: 'read_file' }] },
      { type: 'gemini', content: 'Here is my analysis.' },
    ]);
    const turns = geminiAdapter.parseTurns(content);
    expect(turns.length).toBe(1);
    expect(turns[0].toolCount).toBe(2);
    expect(turns[0].aiResponse).toBe('Here is my analysis.');
  });

  it('handles multiple user turns', () => {
    const content = buildGeminiTranscript([
      { type: 'user', content: [{ text: 'First question' }] },
      { type: 'gemini', content: 'First answer' },
      { type: 'user', content: [{ text: 'Second question' }] },
      { type: 'gemini', content: 'Second answer' },
    ]);
    const turns = geminiAdapter.parseTurns(content);
    expect(turns.length).toBe(2);
    expect(turns[0].prompt).toBe('First question');
    expect(turns[1].prompt).toBe('Second question');
  });

  it('handles empty messages array', () => {
    const content = JSON.stringify({ sessionId: 'test', messages: [] });
    const turns = geminiAdapter.parseTurns(content);
    expect(turns.length).toBe(0);
  });

  it('handles malformed JSON gracefully', () => {
    const turns = geminiAdapter.parseTurns('not valid json');
    expect(turns.length).toBe(0);
  });

  it('handles string content on user messages', () => {
    const content = buildGeminiTranscript([
      { type: 'user', content: 'Plain string prompt' as unknown as Array<{ text: string }> },
      { type: 'gemini', content: 'Response' },
    ]);
    const turns = geminiAdapter.parseTurns(content);
    expect(turns.length).toBe(1);
    // String content should be handled gracefully
    expect(turns[0].prompt).toBeTruthy();
  });

  it('parses the live Gemini transcript format', () => {
    // Minimal reproduction of the actual format found in
    // ~/.gemini/tmp/unifi-mcp-worker/chats/session-*.json
    const content = JSON.stringify({
      sessionId: '444fa6d9-f84b-46cb-997f-33e67ab42a22',
      projectHash: 'abc123',
      startTime: '2026-03-28T19:29:10.071Z',
      lastUpdated: '2026-03-28T19:30:18.778Z',
      messages: [
        {
          id: 'a3f6b853',
          timestamp: '2026-03-28T19:29:10.071Z',
          type: 'user',
          content: [{ text: 'A full code review of this project.' }],
        },
        {
          id: '035fb45c',
          timestamp: '2026-03-28T19:29:13.679Z',
          type: 'gemini',
          content: 'I will start by reading the README.md and package.json files.',
          thoughts: [{ subject: 'Assessment', description: 'Evaluating...', timestamp: '2026-03-28T19:29:11Z' }],
          tokens: { input: 7581, output: 72 },
          model: 'gemini-3-flash-preview',
          toolCalls: [
            { id: 'read_file_1', name: 'read_file', args: { file_path: 'README.md' }, status: 'success' },
            { id: 'read_file_2', name: 'read_file', args: { file_path: 'package.json' }, status: 'success' },
          ],
        },
        {
          id: 'final',
          timestamp: '2026-03-28T19:30:18.778Z',
          type: 'gemini',
          content: 'Overall, the code is well-structured and follows best practices.',
          toolCalls: [],
        },
      ],
    });

    const turns = geminiAdapter.parseTurns(content);
    expect(turns.length).toBe(1);
    expect(turns[0].prompt).toBe('A full code review of this project.');
    expect(turns[0].toolCount).toBe(2);
    expect(turns[0].aiResponse).toBe('Overall, the code is well-structured and follows best practices.');
    expect(turns[0].timestamp).toBe('2026-03-28T19:29:10.071Z');
  });
});
