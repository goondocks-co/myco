/**
 * Capture event policy table — the single source of truth for whether buffer
 * reconciliation replays each hook-emitted event type after daemon downtime,
 * and in what mode.
 *
 * The daemon's reconciler derives its replayable set from this table. The
 * hook-side buffer-fallback decision (`shouldBufferFallback` in
 * `src/hooks/send-event.ts`) is response-shape-driven and does not consult
 * the table — encoding replay semantics per event type in one place is what
 * keeps the reconciler and the hooks from drifting on what survives downtime.
 */

/** How reconciliation replays a buffered event of this type. */
export type CaptureReplayMode =
  /** Re-applies the manifest capture/origin rules before inserting
   *  (`classifyNextPromptDecision`) — a buffered drop-rule event is
   *  re-filtered on replay rather than blindly re-inserted. */
  | 'regate'
  /** Inserted directly through the live handler with no re-filtering. */
  | 'direct'
  /** NULL-only write against existing rows (stop: sets response_summary
   *  only while unset); replaying twice is a no-op. */
  | 'idempotent';

export interface CaptureEventPolicy {
  /** Buffer reconciliation replays this type after daemon downtime. */
  replayable: boolean;
  /** Replay semantics; null for types reconciliation never replays. */
  replayMode: CaptureReplayMode | null;
}

/** One row per event type a capture hook can emit. */
export const CAPTURE_EVENT_POLICY: Readonly<Record<string, CaptureEventPolicy>> = {
  user_prompt: { replayable: true, replayMode: 'regate' },
  // Replay inserts the activity directly without re-evaluating capture
  // rules — which is why the buffer-fallback decision never buffers a
  // daemon-ignored event: it would resurrect a deliberately-dropped
  // activity on the next start.
  tool_use: { replayable: true, replayMode: 'direct' },
  tool_failure: { replayable: true, replayMode: 'direct' },
  // POSTs to /events/stop, whose pipeline is queued — the response never
  // reports a persist outcome, so the stop hook always buffers its
  // summary-bearing event (idempotent NULL-only replay makes the extra
  // copy a no-op).
  stop: { replayable: true, replayMode: 'idempotent' },
  subagent_start: { replayable: false, replayMode: null },
  subagent_stop: { replayable: false, replayMode: null },
  stop_failure: { replayable: false, replayMode: null },
  task_completed: { replayable: false, replayMode: null },
  pre_compact: { replayable: false, replayMode: null },
  post_compact: { replayable: false, replayMode: null },
  notification: { replayable: false, replayMode: null },
  error_occurred: { replayable: false, replayMode: null },
};

/**
 * Policy lookup with a fail-safe default for unknown types: not replayable.
 * A type missing from the table is a drift bug the policy-table test should
 * catch — the default just keeps the lookup total in the field.
 */
export function captureEventPolicy(eventType: string | undefined): CaptureEventPolicy {
  if (eventType !== undefined) {
    const policy = CAPTURE_EVENT_POLICY[eventType];
    if (policy) return policy;
  }
  return { replayable: false, replayMode: null };
}

/**
 * Event types replayed during buffer reconciliation — derived from the
 * policy table so the reconciler and the hooks can never disagree about
 * what survives daemon downtime.
 */
export const REPLAYABLE_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.entries(CAPTURE_EVENT_POLICY)
    .filter(([, policy]) => policy.replayable)
    .map(([type]) => type),
);
