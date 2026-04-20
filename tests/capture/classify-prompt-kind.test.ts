import { describe, it, expect, afterAll } from 'vitest';
import { classifyPromptKind } from '@myco/capture/classify-prompt-kind.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpJsonl(name: string, events: Record<string, unknown>[]): string {
  const filePath = path.join(tmpDir, `${name}.jsonl`);
  fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return filePath;
}

describe('classifyPromptKind (Claude Code)', () => {
  it('missing transcript file → returns initial', () => {
    const result = classifyPromptKind({
      agent: 'claude-code',
      transcriptPath: path.join(tmpDir, 'nonexistent.jsonl'),
      prompt: 'Hello',
    });
    expect(result).toBe('initial');
  });

  it('empty transcript → returns initial', () => {
    const filePath = path.join(tmpDir, 'empty-cc.jsonl');
    fs.writeFileSync(filePath, '');
    const result = classifyPromptKind({
      agent: 'claude-code',
      transcriptPath: filePath,
      prompt: 'Hello',
    });
    expect(result).toBe('initial');
  });

  it('last assistant message has stop_reason=end_turn → returns initial', () => {
    const filePath = writeTmpJsonl('cc-end-turn', [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'Fix it' }] } },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    const result = classifyPromptKind({
      agent: 'claude-code',
      transcriptPath: filePath,
      prompt: 'Now do more',
    });
    expect(result).toBe('initial');
  });

  it('last assistant message has stop_reason=tool_use → returns steering', () => {
    const filePath = writeTmpJsonl('cc-tool-use', [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'Fix it' }] } },
      { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
    ]);
    const result = classifyPromptKind({
      agent: 'claude-code',
      transcriptPath: filePath,
      prompt: 'Now do more',
    });
    expect(result).toBe('steering');
  });

  it('prompt starts with interrupt marker → returns interrupt', () => {
    const result = classifyPromptKind({
      agent: 'claude-code',
      transcriptPath: undefined,
      prompt: '[Request interrupted by user for tool use] some context',
    });
    expect(result).toBe('interrupt');
  });

  it('user prompt with no assistant response yet → next is steering', () => {
    // Agent is mid-turn on a pending user message — a new prompt steers it.
    const filePath = writeTmpJsonl('cc-midturn', [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    ]);
    const result = classifyPromptKind({
      agent: 'claude-code',
      transcriptPath: filePath,
      prompt: 'next',
    });
    expect(result).toBe('steering');
  });

  it('user prompts followed by assistant end_turn → next is initial', () => {
    const filePath = writeTmpJsonl('cc-end-turn-reset', [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const result = classifyPromptKind({
      agent: 'claude-code',
      transcriptPath: filePath,
      prompt: 'next',
    });
    expect(result).toBe('initial');
  });
});

describe('classifyPromptKind (Codex)', () => {
  it('fresh turn_context after prior user message → returns initial', () => {
    // turn_context is the last seen event, meaning 0 user_messages counted since it
    const filePath = writeTmpJsonl('codex-initial', [
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      // New turn starts — a fresh turn_context resets the turn
      { type: 'turn_context', payload: { turn_id: 'turn-2' } },
    ]);
    const result = classifyPromptKind({
      agent: 'codex',
      transcriptPath: filePath,
      prompt: 'What should I do?',
    });
    expect(result).toBe('initial');
  });

  it('turn_context + user message but no new turn_context → returns steering', () => {
    const filePath = writeTmpJsonl('codex-steering', [
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      // Tool activity but no new turn_context
      { type: 'function_call', payload: { name: 'read_file', args: {} } },
    ]);
    const result = classifyPromptKind({
      agent: 'codex',
      transcriptPath: filePath,
      prompt: 'Keep going',
    });
    expect(result).toBe('steering');
  });

  it('prompt starts with turn_aborted marker → returns interrupt', () => {
    const result = classifyPromptKind({
      agent: 'codex',
      transcriptPath: undefined,
      prompt: '<turn_aborted>some context here',
    });
    expect(result).toBe('interrupt');
  });

  it('transcript with no turn_context → returns initial', () => {
    const filePath = writeTmpJsonl('codex-no-turn-context', [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    ]);
    const result = classifyPromptKind({
      agent: 'codex',
      transcriptPath: filePath,
      prompt: 'next',
    });
    expect(result).toBe('initial');
  });
});

describe('classifyPromptKind (unknown agent)', () => {
  it('returns initial for undefined agent', () => {
    expect(classifyPromptKind({ agent: undefined, transcriptPath: undefined, prompt: 'x' })).toBe('initial');
  });

  it('returns initial for unrecognized agent', () => {
    expect(classifyPromptKind({ agent: 'cursor', transcriptPath: undefined, prompt: 'x' })).toBe('initial');
  });
});
