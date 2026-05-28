/**
 * Throttled live transcript reconcile.
 *
 * Capture historically materialized a session's prompts + responses only at
 * Stop. During a long continuous turn (heavy mid-turn / queued steering) that
 * leaves the most recent prompt and the in-flight response invisible in the
 * dashboard until the next Stop fires. The daemon, however, receives
 * PostToolUse events live and knows the transcript path — and the agent writes
 * each turn's prompts/responses to the transcript as it works. So every tool
 * event is a chance to re-mine the transcript-so-far and surface new content.
 *
 * Re-mining the full transcript on every tool call would be wasteful (the file
 * grows on each tool_use, so the miner's size-cache can't short-circuit). This
 * factory wraps the reconcile in a per-session leading+trailing throttle:
 *   - leading edge: the first tool event after an idle gap reconciles
 *     immediately, so a freshly-queued prompt appears within one tool call;
 *   - trailing edge: bursts coalesce into a single follow-up run at the end of
 *     the interval, so the final state of a busy stretch is always captured.
 *
 * `now` / `setTimer` / `clearTimer` are injectable for deterministic tests;
 * they default to the real clock + timers in the daemon.
 */

import type { DaemonLogger } from './logger.js';

export interface LiveReconcileInput {
  agent: string;
  transcriptPath: string;
}

export interface LiveReconcileDeps {
  /** The unit of work — typically transcriptMiner.reconcileAndAttributeResponses. */
  reconcile: (sessionId: string, input: LiveReconcileInput) => void;
  logger?: Pick<DaemonLogger, 'warn'>;
  /** Minimum gap between reconciles for one session. Default 3000ms. */
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface SessionThrottleState {
  lastRun: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Latest input seen while throttled — the trailing run uses this. */
  pending: LiveReconcileInput | null;
}

const DEFAULT_INTERVAL_MS = 3000;

export function createLiveReconcile(
  deps: LiveReconcileDeps,
): (sessionId: string, agent: string, transcriptPath: string) => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const state = new Map<string, SessionThrottleState>();

  const run = (sessionId: string, input: LiveReconcileInput, st: SessionThrottleState): void => {
    st.lastRun = now();
    st.pending = null;
    try {
      deps.reconcile(sessionId, input);
    } catch (err) {
      deps.logger?.warn('capture.live-reconcile', 'Live reconcile failed', {
        session_id: sessionId,
        error: (err as Error).message,
      });
    }
  };

  return (sessionId: string, agent: string, transcriptPath: string): void => {
    const input: LiveReconcileInput = { agent, transcriptPath };
    let st = state.get(sessionId);
    if (!st) {
      st = { lastRun: 0, timer: null, pending: null };
      state.set(sessionId, st);
    }

    const elapsed = now() - st.lastRun;
    if (elapsed >= intervalMs && st.timer === null) {
      // Leading edge: enough idle time has passed, run now.
      run(sessionId, input, st);
      return;
    }

    // Within the throttle window: remember the latest input and ensure a
    // trailing run is scheduled for when the window closes.
    st.pending = input;
    if (st.timer === null) {
      const delay = Math.max(0, intervalMs - elapsed);
      st.timer = setTimer(() => {
        st!.timer = null;
        if (st!.pending) run(sessionId, st!.pending, st!);
      }, delay);
    }
  };
}
