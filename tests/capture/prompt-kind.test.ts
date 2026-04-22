import { describe, expect, it } from 'vitest';
import { classifyNextPromptKind, extractUserPromptKinds } from '@myco/capture/prompt-kind.js';

// Regression: Claude Code writes real user prompts with `message.content` as a
// plain string, and tool_result entries with content as an array. The walker
// must handle both without crashing — earlier revisions called `.find` on the
// string and threw "content?.find is not a function", which silently killed
// every Stop-time reconcile pass.

describe('walkClaudeCode content shape handling', () => {
  const userPromptStringContent = (promptId: string, text: string) => ({
    type: 'user',
    promptId,
    message: { role: 'user', content: text },
  });

  const userPromptArrayContent = (promptId: string, text: string) => ({
    type: 'user',
    promptId,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

  const toolResultArrayContent = (promptId: string) => ({
    type: 'user',
    promptId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
    },
  });

  const assistantEndTurn = () => ({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
  });

  it('classifies a string-content user prompt as initial', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', 'Hello'),
    ]);
    expect(kinds).toEqual(['initial']);
  });

  it('classifies an array-content user prompt as initial', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptArrayContent('p1', 'Hello'),
    ]);
    expect(kinds).toEqual(['initial']);
  });

  it('handles mixed string + array content user prompts across a session', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', 'First'),
      assistantEndTurn(),
      userPromptArrayContent('p2', 'Second'),
    ]);
    expect(kinds).toEqual(['initial', 'initial']);
  });

  it('skips tool_result entries without throwing', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', 'Real prompt'),
      toolResultArrayContent('p1'), // duplicate promptId — already-seen
      toolResultArrayContent('p2'), // array content, no text block → skipped
    ]);
    expect(kinds).toEqual(['initial']);
  });

  it('classifies a mid-turn steering prompt when prior turn has not ended', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', 'First'),
      // No assistant end_turn — user sends a second prompt mid-turn.
      userPromptStringContent('p2', 'Steering'),
    ]);
    expect(kinds).toEqual(['initial', 'steering']);
  });

  it('detects the interrupt marker on string-content prompts', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', '[Request interrupted by user for tool use]'),
    ]);
    expect(kinds).toEqual(['interrupt']);
  });

  it('does not throw on malformed events', () => {
    // A whole bag of misshapen events the walker should tolerate without
    // crashing. Any crash here cascades into a silently-killed reconcile.
    const events = [
      { type: 'user' /* no promptId */, message: { content: 'x' } },
      { type: 'user', promptId: 'p1' /* no message */ },
      { type: 'user', promptId: 'p2', message: {} /* no content */ },
      { type: 'user', promptId: 'p3', message: { content: 42 } as never },
      { type: 'assistant' /* no message */ },
    ];
    expect(() => extractUserPromptKinds('claude-code', events)).not.toThrow();
  });
});

describe('walkClaudeCode queued_command shape (Phase 4)', () => {
  // Claude Code's Esc→queue UI writes mid-turn prompts as
  //   type:"attachment", attachment:{type:"queued_command", prompt:"..."}
  // and never emits a matching `type:"user"` event. Before the declarative
  // manifest extension, the walker never saw these and steering prompts
  // submitted via the queue UI were lost. The manifest now names the
  // queued_command shape so the walker classifies them by position like
  // any other user prompt.
  it('captures a queued_command attachment as a steering prompt mid-turn', () => {
    const events = [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: 'first regular prompt' } },
      // No assistant end_turn → turn still open when queued command arrives.
      {
        type: 'attachment',
        uuid: 'att-1',
        attachment: { type: 'queued_command', prompt: 'steering via queue UI' },
      },
    ];
    const kinds = extractUserPromptKinds('claude-code', events);
    expect(kinds).toEqual(['initial', 'steering']);
  });

  it('dedupes queued_command attachments by uuid', () => {
    const events = [
      {
        type: 'attachment',
        uuid: 'att-dup',
        attachment: { type: 'queued_command', prompt: 'only once' },
      },
      {
        type: 'attachment',
        uuid: 'att-dup',
        attachment: { type: 'queued_command', prompt: 'only once' },
      },
    ];
    const kinds = extractUserPromptKinds('claude-code', events);
    expect(kinds).toEqual(['initial']);
  });

  it('ignores unrelated attachments (images, files)', () => {
    const events = [
      {
        type: 'attachment',
        uuid: 'img-1',
        attachment: { type: 'image', path: '/tmp/x.png' },
      },
    ];
    const kinds = extractUserPromptKinds('claude-code', events);
    expect(kinds).toEqual([]);
  });
});

describe('walker applies manifest capture.rules (Codex system-injection case)', () => {
  // Codex sends AGENTS.md + Myco cortex injection as the first
  // response_item/message/user in every rollout. It's structurally
  // identical to a real user prompt, so the codex manifest has a
  // `capture.rules` drop rule keyed on the injection prefix — that rule
  // must fire at transcript-mining time, not just at live hook time,
  // otherwise reconcile inserts the injection as a "missing" initial
  // batch and displaces the real user prompt.
  it('drops Codex response_item events matching the AGENTS.md drop rule', () => {
    const events = [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/foo\n\n<INSTRUCTIONS>\n...' }],
        },
      },
      {
        type: 'turn_context',
        payload: { turn_id: 't1' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'what has changed in this branch?' }],
        },
      },
    ];
    const records = extractUserPromptKinds('codex', events);
    expect(records).toEqual(['initial']);
  });
});

describe('classifyNextPromptKind — tail predictions', () => {
  it('returns initial on an empty tail', () => {
    expect(classifyNextPromptKind('claude-code', [], 'hello')).toBe('initial');
  });

  it('returns steering when the last walker state has an open turn', () => {
    const events = [
      {
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: 'open turn' },
      },
    ];
    expect(classifyNextPromptKind('claude-code', events, 'follow-up')).toBe('steering');
  });

  it('returns initial when the last assistant event ended the turn', () => {
    const events = [
      {
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: 'done' },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
      },
    ];
    expect(classifyNextPromptKind('claude-code', events, 'next')).toBe('initial');
  });

  it('tags interrupt marker regardless of walker state', () => {
    expect(
      classifyNextPromptKind(
        'claude-code',
        [],
        '[Request interrupted by user for tool use] continue later',
      ),
    ).toBe('interrupt');
  });
});
