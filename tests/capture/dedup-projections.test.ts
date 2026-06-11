import { describe, expect, it } from 'bun:test';
import {
  eventDedupKey,
  convergenceEventKey,
  dedupKeyFromPromptBatch,
  dedupKeyFromActivity,
  isBookkeepingActivity,
  BOOKKEEPING_ACTIVITY_TOOL_NAMES,
} from '@myco/capture/dedup.js';
import { TOOL_INPUT_STORE_LIMIT } from '@myco/daemon/event-handlers.js';

// The convergence projections must place a stored DB row and the buffer
// event that produced it on the SAME key — across the asymmetric
// serializations the two sides use (event: live value fingerprinted at 256
// chars; row: JSON.stringify(...).slice(0, 4000) or NULL for falsy inputs).

const SESSION = 's-proj';

/** Row shape as the live handleToolUse insert path stores it. */
function storedToolUseRow(toolName: string, toolInput: unknown) {
  return {
    session_id: SESSION,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    success: 1,
    error_message: null as string | null,
  };
}

describe('dedupKeyFromPromptBatch', () => {
  it('matches the convergence key of the user_prompt event that stored the row', () => {
    const event = { type: 'user_prompt', session_id: SESSION, prompt: 'Help me debug this' };
    const row = { session_id: SESSION, user_prompt: 'Help me debug this' };
    expect(dedupKeyFromPromptBatch(row)).toBe(convergenceEventKey(event));
  });

  it('equals the live dispatcher key for an ordinary prompt — the two key spaces align', () => {
    const event = { type: 'user_prompt', session_id: SESSION, prompt: 'plain prompt' };
    expect(convergenceEventKey(event)).toBe(eventDedupKey(event));
  });

  it('a NULL stored prompt matches a prompt-less user_prompt event', () => {
    const event = { type: 'user_prompt', session_id: SESSION };
    const row = { session_id: SESSION, user_prompt: null };
    expect(dedupKeyFromPromptBatch(row)).toBe(convergenceEventKey(event));
  });

  it('truncates at the 256-char fingerprint window like the event side', () => {
    const text = 'y'.repeat(300);
    const row = { session_id: SESSION, user_prompt: text + 'stored-tail' };
    const event = { type: 'user_prompt', session_id: SESSION, prompt: text + 'event-tail' };
    expect(dedupKeyFromPromptBatch(row)).toBe(convergenceEventKey(event));
  });

  it('a rewrite-rule row matches the event keyed on its candidate (rewritten) text, not the raw preamble', () => {
    // The live hook applies rewrite rules BEFORE buffering/storing, so the
    // stored row holds the rewritten text. The reconciler therefore keys
    // user_prompt events on the candidate replay text for the exact match —
    // the raw preamble form keys differently by construction.
    const raw = '# Files mentioned by the user:\n## My request for Codex:\nresize it';
    const rewritten = 'resize it';
    const row = { session_id: SESSION, user_prompt: rewritten };
    expect(dedupKeyFromPromptBatch(row))
      .not.toBe(convergenceEventKey({ type: 'user_prompt', session_id: SESSION, prompt: raw }));
    expect(dedupKeyFromPromptBatch(row))
      .toBe(convergenceEventKey({ type: 'user_prompt', session_id: SESSION, prompt: rewritten }));
  });
});

describe('dedupKeyFromActivity — input reconstruction', () => {
  it('round-trips an object tool_input through the stored JSON text', () => {
    const input = { command: 'ls -la', description: 'list files' };
    const event = { type: 'tool_use', session_id: SESSION, tool_name: 'Bash', tool_input: input };
    expect(dedupKeyFromActivity(storedToolUseRow('Bash', input))).toBe(convergenceEventKey(event));
  });

  it('unquotes a scalar string input (stored as JSON `"pwd"`, fingerprinted as `pwd`)', () => {
    const event = { type: 'tool_use', session_id: SESSION, tool_name: 'Bash', tool_input: 'pwd' };
    expect(dedupKeyFromActivity(storedToolUseRow('Bash', 'pwd'))).toBe(convergenceEventKey(event));
  });

  it('a stored NULL matches every falsy event-side input (undefined, null, "", 0, false)', () => {
    const nullRowKey = dedupKeyFromActivity(storedToolUseRow('Read', undefined));
    for (const falsy of [undefined, null, '', 0, false]) {
      const event = { type: 'tool_use', session_id: SESSION, tool_name: 'Read', tool_input: falsy };
      expect(convergenceEventKey(event)).toBe(nullRowKey);
    }
  });

  it('falsy widening does not swallow truthy scalars', () => {
    const nullRowKey = dedupKeyFromActivity(storedToolUseRow('Read', undefined));
    const event = { type: 'tool_use', session_id: SESSION, tool_name: 'Read', tool_input: 'echo 1' };
    expect(convergenceEventKey(event)).not.toBe(nullRowKey);
  });

  it('keys a >4000-char torn stored JSON on the raw slice — exact within the fingerprint window', () => {
    const input = { script: 'z'.repeat(TOOL_INPUT_STORE_LIMIT + 500) };
    const row = storedToolUseRow('Bash', input);
    // Sanity: the stored text really is torn (truncated, unparseable).
    expect(row.tool_input!.length).toBe(TOOL_INPUT_STORE_LIMIT);
    expect(() => JSON.parse(row.tool_input!)).toThrow();
    const event = { type: 'tool_use', session_id: SESSION, tool_name: 'Bash', tool_input: input };
    expect(dedupKeyFromActivity(row)).toBe(convergenceEventKey(event));
  });
});

describe('dedupKeyFromActivity — type discrimination', () => {
  it('success=0 keys as tool_failure', () => {
    const row = { ...storedToolUseRow('Bash', { command: 'x' }), success: 0 };
    const failureEvent = { type: 'tool_failure', session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'x' } };
    expect(dedupKeyFromActivity(row)).toBe(convergenceEventKey(failureEvent));
  });

  it('error_message present keys as tool_failure even with success=1', () => {
    const row = { ...storedToolUseRow('Bash', { command: 'x' }), error_message: 'boom' };
    const failureEvent = { type: 'tool_failure', session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'x' } };
    expect(dedupKeyFromActivity(row)).toBe(convergenceEventKey(failureEvent));
  });

  it('a tool_failure row never matches the equivalent tool_use event', () => {
    const row = { ...storedToolUseRow('Bash', { command: 'x' }), success: 0 };
    const useEvent = { type: 'tool_use', session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'x' } };
    expect(dedupKeyFromActivity(row)).not.toBe(convergenceEventKey(useEvent));
  });
});

describe('bookkeeping exclusion', () => {
  it('enumerates exactly the rows written by the bookkeeping handlers', () => {
    expect([...BOOKKEEPING_ACTIVITY_TOOL_NAMES].sort()).toEqual([
      'post_compact',
      'pre_compact',
      'stop_failure',
      'subagent_start',
      'subagent_stop',
      'task_completed',
    ]);
  });

  it('classifies bookkeeping vs tool activities', () => {
    expect(isBookkeepingActivity('subagent_stop')).toBe(true);
    expect(isBookkeepingActivity('task_completed')).toBe(true);
    expect(isBookkeepingActivity('Bash')).toBe(false);
    expect(isBookkeepingActivity('mcp__myco__myco_search')).toBe(false);
  });
});
