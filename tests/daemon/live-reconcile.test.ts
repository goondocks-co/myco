import { describe, it, expect } from 'bun:test';
import { createLiveReconcile, type LiveReconcileInput } from '@myco/daemon/live-reconcile.js';

/**
 * Deterministic throttle harness: a controllable clock + a manual timer queue
 * so leading/trailing-edge behavior is asserted without real time.
 */
function harness(intervalMs = 3000) {
  let nowMs = 1_000_000;
  const calls: Array<{ sessionId: string; input: LiveReconcileInput }> = [];
  const timers: Array<{ fn: () => void; due: number }> = [];

  const reconcile = createLiveReconcile({
    intervalMs,
    reconcile: (sessionId, input) => calls.push({ sessionId, input }),
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const handle = { fn, due: nowMs + ms } as unknown as ReturnType<typeof setTimeout>;
      timers.push(handle as unknown as { fn: () => void; due: number });
      return handle;
    },
    clearTimer: () => {},
  });

  return {
    reconcile,
    calls,
    advance(ms: number) {
      nowMs += ms;
      // Fire any timers now due (single pass is enough for these tests).
      const due = timers.filter((t) => t.due <= nowMs);
      for (const t of due) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

describe('createLiveReconcile throttle', () => {
  it('runs immediately on the leading edge (first call after idle)', () => {
    const h = harness();
    h.reconcile('s1', 'claude-code', '/t.jsonl');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({ sessionId: 's1', input: { agent: 'claude-code', transcriptPath: '/t.jsonl' } });
  });

  it('coalesces a burst into one trailing run with the latest input', () => {
    const h = harness(3000);
    h.reconcile('s1', 'claude-code', '/t.jsonl'); // leading → runs now (1 call)
    h.reconcile('s1', 'claude-code', '/t.jsonl'); // within window → scheduled
    h.reconcile('s1', 'claude-code', '/t2.jsonl'); // within window → updates pending
    expect(h.calls).toHaveLength(1);

    h.advance(3000); // window closes → trailing run fires once
    expect(h.calls).toHaveLength(2);
    // Trailing run uses the LATEST input seen during the window.
    expect(h.calls[1].input.transcriptPath).toBe('/t2.jsonl');
  });

  it('does not double-run when only one call happens in a window', () => {
    const h = harness(3000);
    h.reconcile('s1', 'claude-code', '/t.jsonl'); // leading run
    h.advance(3000); // no pending → no trailing run
    expect(h.calls).toHaveLength(1);
  });

  it('runs again on the leading edge after the interval elapses', () => {
    const h = harness(3000);
    h.reconcile('s1', 'claude-code', '/t.jsonl'); // run 1 (leading)
    h.advance(3001); // idle past the interval
    h.reconcile('s1', 'claude-code', '/t.jsonl'); // run 2 (leading again)
    expect(h.calls).toHaveLength(2);
  });

  it('throttles each session independently', () => {
    const h = harness(3000);
    h.reconcile('s1', 'claude-code', '/a.jsonl'); // s1 leading
    h.reconcile('s2', 'claude-code', '/b.jsonl'); // s2 leading
    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((c) => c.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('swallows reconcile errors (best-effort, never throws to the caller)', () => {
    const reconcile = createLiveReconcile({
      reconcile: () => { throw new Error('boom'); },
      now: () => 1000,
    });
    expect(() => reconcile('s1', 'claude-code', '/t.jsonl')).not.toThrow();
  });
});
