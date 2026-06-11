/**
 * Capture event policy table — the single source of truth for how each
 * hook-emitted event type behaves across the capture pipeline:
 *
 *   - whether buffer reconciliation replays it after daemon downtime, and
 *     in what mode;
 *   - what the hook CLI's buffer-fallback did under the legacy (pre-honest)
 *     daemon response contract, preserved for mixed-version rollout where a
 *     new hook binary talks to an older daemon.
 *
 * Both sides import from here: the daemon's reconciler derives its
 * replayable set from the table, and the hooks' shared capture-critical
 * helper consults the legacy columns when a daemon response carries no
 * `persisted` field. Per-hook flags are deliberately gone — encoding the
 * behavior per event type in one table is what keeps the two processes
 * from drifting.
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
  /**
   * LEGACY-daemon column: whether the hook buffers when the daemon answers
   * 200 with `{ ignored: <reason> }`. Only consulted when the response has
   * no `persisted` field (an older daemon during mixed-version rollout) —
   * a new daemon's `ignored` is never buffered (ignored ≠ lost).
   */
  legacyBufferOnIgnored: boolean;
  /**
   * LEGACY-daemon column: which events the hook offers a buffer-fallback
   * copy for at all.
   *
   *   - 'always'       — every event of this type carries a bufferEvent.
   *   - 'summary-only' — only events with a non-empty assistant response
   *                      (`stop`: an empty stop never writes a no-op row).
   *   - 'never'        — the hook POSTs without a buffer fallback.
   */
  legacyBufferEvent: 'always' | 'never' | 'summary-only';
}

/**
 * One row per event type a capture hook can emit. The legacy columns
 * encode the exact per-hook behavior that shipped before the honest
 * `/events` response contract (see each hook in `src/hooks/`).
 */
export const CAPTURE_EVENT_POLICY: Readonly<Record<string, CaptureEventPolicy>> = {
  user_prompt: {
    replayable: true,
    replayMode: 'regate',
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  tool_use: {
    // Replay inserts the activity directly without re-evaluating capture
    // rules, so a legacy-daemon `ignored` tool must NOT buffer — it would
    // resurrect a deliberately-dropped activity on the next start.
    replayable: true,
    replayMode: 'direct',
    legacyBufferOnIgnored: false,
    legacyBufferEvent: 'always',
  },
  tool_failure: {
    replayable: true,
    replayMode: 'direct',
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  stop: {
    // POSTs to /events/stop, whose pipeline is queued — the response never
    // reports a persist outcome, so the stop hook ALWAYS runs under these
    // legacy columns regardless of daemon version.
    replayable: true,
    replayMode: 'idempotent',
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'summary-only',
  },
  subagent_start: {
    replayable: false,
    replayMode: null,
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  subagent_stop: {
    replayable: false,
    replayMode: null,
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  stop_failure: {
    replayable: false,
    replayMode: null,
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  task_completed: {
    replayable: false,
    replayMode: null,
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  pre_compact: {
    replayable: false,
    replayMode: null,
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  post_compact: {
    replayable: false,
    replayMode: null,
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  notification: {
    replayable: false,
    replayMode: null,
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
  error_occurred: {
    replayable: false,
    replayMode: null,
    legacyBufferOnIgnored: true,
    legacyBufferEvent: 'always',
  },
};

/**
 * Policy lookup with a fail-safe default for unknown types: not replayable,
 * legacy behavior matching `sendEvent`'s historical defaults (buffer on
 * ignored, always offer a buffer copy). A type missing from the table is a
 * drift bug the policy-table test should catch — the default just keeps the
 * hook fail-open in the field.
 */
export function captureEventPolicy(eventType: string | undefined): CaptureEventPolicy {
  if (eventType !== undefined) {
    const policy = CAPTURE_EVENT_POLICY[eventType];
    if (policy) return policy;
  }
  return { replayable: false, replayMode: null, legacyBufferOnIgnored: true, legacyBufferEvent: 'always' };
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
