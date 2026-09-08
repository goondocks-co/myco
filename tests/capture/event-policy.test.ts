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

});
