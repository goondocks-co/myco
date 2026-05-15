import { describe, expect, it } from 'bun:test';
import {
  eventDedupKey,
  eventTimestampMs,
  EVENT_DEDUP_WINDOW_MS,
} from '@myco/capture/dedup.js';

describe('eventDedupKey', () => {
  it('produces identical keys for two physically-identical events', () => {
    const e1 = {
      type: 'user_prompt',
      session_id: 'sess-1',
      prompt: 'Help me debug this',
    };
    const e2 = { ...e1 };
    expect(eventDedupKey(e1)).toBe(eventDedupKey(e2));
  });

  it('distinguishes events of the same type with different content', () => {
    const a = { type: 'user_prompt', session_id: 's', prompt: 'apple' };
    const b = { type: 'user_prompt', session_id: 's', prompt: 'banana' };
    expect(eventDedupKey(a)).not.toBe(eventDedupKey(b));
  });

  it('distinguishes the same prompt across different sessions', () => {
    const a = { type: 'user_prompt', session_id: 's-a', prompt: 'p' };
    const b = { type: 'user_prompt', session_id: 's-b', prompt: 'p' };
    expect(eventDedupKey(a)).not.toBe(eventDedupKey(b));
  });

  it('treats tool_use events with identical tool_input as the same key', () => {
    const a = {
      type: 'tool_use',
      session_id: 's',
      tool_name: 'Bash',
      tool_input: { command: 'ls', description: 'list' },
    };
    const b = {
      type: 'tool_use',
      session_id: 's',
      tool_name: 'Bash',
      tool_input: { command: 'ls', description: 'list' },
    };
    expect(eventDedupKey(a)).toBe(eventDedupKey(b));
  });

  it('truncates long prompts at 256 chars — guards against unbounded key growth', () => {
    const a = { type: 'user_prompt', session_id: 's', prompt: 'x'.repeat(500) };
    const b = { type: 'user_prompt', session_id: 's', prompt: 'x'.repeat(800) };
    // Both truncated to 256 'x's → same fingerprint.
    expect(eventDedupKey(a)).toBe(eventDedupKey(b));
  });
});

describe('eventTimestampMs', () => {
  it('parses ISO timestamps to milliseconds', () => {
    expect(eventTimestampMs({ timestamp: '2026-05-15T15:55:07.594Z' })).toBe(
      Date.parse('2026-05-15T15:55:07.594Z'),
    );
  });

  it('returns null when the timestamp field is missing', () => {
    expect(eventTimestampMs({})).toBeNull();
  });

  it('returns null for an unparseable timestamp', () => {
    expect(eventTimestampMs({ timestamp: 'not-a-date' })).toBeNull();
  });
});

describe('EVENT_DEDUP_WINDOW_MS', () => {
  it('is the shared 10-second window', () => {
    // Pinning the value so live dispatch + buffer reconcile stay in lockstep.
    // Changing the window is a deliberate architectural decision, not a
    // local tweak.
    expect(EVENT_DEDUP_WINDOW_MS).toBe(10_000);
  });
});
