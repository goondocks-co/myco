/**
 * Shared event-deduplication helper.
 *
 * Two distinct paths can deliver "the same physical hook event" more than
 * once:
 *
 *   1. **Live dispatch path** (`event-dispatch.ts`) — hook fires multiple
 *      times (Codex's user_prompt hook is observed firing twice within 30ms;
 *      retry storms after a wedged-then-recovered daemon; two symbionts
 *      watching the same project). The dispatcher's in-memory dedup cache
 *      catches these and returns `ignored: 'duplicate'`.
 *
 *   2. **Buffer replay path** (`reconciliation.ts`) — the hook CLI writes
 *      the event to the buffer file whenever the daemon returns
 *      `ignored: 'duplicate'` (so reconcile can replay if the dedup was
 *      wrong). Without this helper, the replay re-inserts the duplicate as
 *      a fresh prompt_batch — the original dedup decision evaporates.
 *
 * Both paths must use the SAME fingerprint, or the buffer replay will
 * resurrect events the live path correctly rejected. This module is the
 * single source of truth for that fingerprint.
 */

/** How long after the first occurrence we still treat a repeat as a duplicate. */
export const EVENT_DEDUP_WINDOW_MS = 10_000;

const PROMPT_FINGERPRINT_CHARS = 256;
const TOOL_INPUT_FINGERPRINT_CHARS = 256;

/**
 * Compute a content fingerprint key for an inbound capture event.
 *
 * The key combines `session_id` + `type` with payload fields that vary by
 * event shape (prompt text, tool name, tool input, task / agent ids). For
 * any given physical hook event, the key is stable across the live dispatch
 * path and the buffer replay path — that's what lets reconcile suppress
 * replays of events the live dispatcher already rejected.
 *
 * Slicing to 256 chars on free-text fields keeps the key bounded for long
 * prompts and large tool inputs while still being collision-resistant in
 * practice (two genuinely-different prompts that share their first 256 chars
 * are extraordinarily rare in capture traffic).
 */
export function eventDedupKey(
  event: { type: string; session_id: string } & Record<string, unknown>,
): string {
  const parts: string[] = [
    event.type,
    typeof event.prompt === 'string' ? event.prompt.slice(0, PROMPT_FINGERPRINT_CHARS) : '',
    typeof event.tool_name === 'string' ? event.tool_name : '',
    typeof event.tool_input === 'object'
      ? JSON.stringify(event.tool_input).slice(0, TOOL_INPUT_FINGERPRINT_CHARS)
      : String(event.tool_input ?? '').slice(0, TOOL_INPUT_FINGERPRINT_CHARS),
    typeof event.task_id === 'string' ? event.task_id : '',
    typeof event.agent_id === 'string' ? event.agent_id : '',
  ];
  return `${event.session_id}\0${parts.join('\0')}`;
}

/**
 * Parse an event timestamp string to milliseconds. Returns `null` when the
 * field is missing or unparseable, letting callers decide how to treat
 * timestamp-less events (typically: skip dedup, treat as unique).
 */
export function eventTimestampMs(event: Record<string, unknown>): number | null {
  const ts = event.timestamp;
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}
