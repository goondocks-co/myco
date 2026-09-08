import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPTURE_EVENT_POLICY,
  REPLAYABLE_EVENT_TYPES,
  captureEventPolicy,
} from '@myco/capture/event-policy.js';

/**
 * Return the innermost brace-balanced `{ ... }` object literal enclosing
 * `fromIdx`, or null when no balanced literal surrounds it. Walks backward
 * to the unmatched opening brace, then forward to its balanced close.
 */
function enclosingObjectLiteral(source: string, fromIdx: number): string | null {
  let depth = 0;
  let open = -1;
  for (let i = fromIdx; i >= 0; i--) {
    const ch = source[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open === -1) return null;
  depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Drift guards for the capture event policy table — the single source of
 * truth the daemon reconciler derives its replayable set from.
 */
describe('capture event policy table', () => {
  it('derives REPLAYABLE_EVENT_TYPES exactly from the replayable column', () => {
    const fromTable = Object.entries(CAPTURE_EVENT_POLICY)
      .filter(([, policy]) => policy.replayable)
      .map(([type]) => type)
      .sort();
    expect([...REPLAYABLE_EVENT_TYPES].sort()).toEqual(fromTable);
  });

  it('pins the replayable set the reconciler replays after downtime', () => {
    expect([...REPLAYABLE_EVENT_TYPES].sort()).toEqual([
      'stop',
      'tool_failure',
      'tool_use',
      'user_prompt',
    ]);
  });

  it('gives every replayable type a replay mode and no mode to the rest', () => {
    for (const policy of Object.values(CAPTURE_EVENT_POLICY)) {
      if (policy.replayable) {
        expect(policy.replayMode).not.toBeNull();
      } else {
        expect(policy.replayMode).toBeNull();
      }
    }
  });

  it('pins the replay mode of every replayable type', () => {
    expect(CAPTURE_EVENT_POLICY.user_prompt.replayMode).toBe('regate');
    expect(CAPTURE_EVENT_POLICY.tool_use.replayMode).toBe('direct');
    expect(CAPTURE_EVENT_POLICY.tool_failure.replayMode).toBe('direct');
    expect(CAPTURE_EVENT_POLICY.stop.replayMode).toBe('idempotent');
  });

  it('falls back to not-replayable for unknown types', () => {
    expect(captureEventPolicy('some_future_type')).toEqual({
      replayable: false,
      replayMode: null,
    });
    expect(captureEventPolicy(undefined).replayable).toBe(false);
  });

  it('covers every event type a 1.4 buffer can carry', () => {
    // The daemon's policy table serves buffers written by 1.4 binaries. The
    // native plugins write transcript lines and run the binary's hook verbs,
    // so they emit no daemon event type of their own and contribute nothing
    // to this set; the member hooks emit server envelopes, not daemon events.
    const emitted = new Set<string>(Object.keys(CAPTURE_EVENT_POLICY));

    const tableTypes = new Set(Object.keys(CAPTURE_EVENT_POLICY));
    const missingFromTable = [...emitted].filter((type) => !tableTypes.has(type));
    expect(missingFromTable).toEqual([]);
  });
});
