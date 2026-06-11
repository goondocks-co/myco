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
 *   2. **Buffer replay path** (`reconciliation.ts`) — duplicate copies of an
 *      already-processed event can land in the buffer file: the hook CLI
 *      buffers on any transport failure (the daemon may have completed the
 *      work before the response was lost), and every summary-bearing stop
 *      is buffered by design (/events/stop is queued and never reports a
 *      persist outcome). A daemon `ignored` is never buffered. Without this
 *      helper, the replay re-inserts such a copy as a fresh prompt_batch —
 *      the original dedup decision evaporates.
 *
 * Both paths must use the SAME fingerprint, or the buffer replay will
 * resurrect events the live path correctly rejected. This module is the
 * single source of truth for that fingerprint.
 */

/** How long after the first occurrence we still treat a repeat as a duplicate. */
export const EVENT_DEDUP_WINDOW_MS = 10_000;

const PROMPT_FINGERPRINT_CHARS = 256;
const TOOL_INPUT_FINGERPRINT_CHARS = 256;

/** Assemble the canonical key string from its six fingerprint components. */
function composeKey(
  sessionId: string,
  type: string,
  prompt: string,
  toolName: string,
  toolInput: string,
  taskId: string,
  agentId: string,
): string {
  return `${sessionId}\0${[type, prompt, toolName, toolInput, taskId, agentId].join('\0')}`;
}

/** Event-side tool_input component — the exact branch semantics of {@link eventDedupKey}. */
function toolInputComponent(toolInput: unknown): string {
  return typeof toolInput === 'object'
    ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_FINGERPRINT_CHARS)
    : String(toolInput ?? '').slice(0, TOOL_INPUT_FINGERPRINT_CHARS);
}

/**
 * Event-side tool_input components whose source values the storage layer
 * collapses to a NULL column (`toolInput ? JSON.stringify(...) : null` in
 * `event-handlers.ts` treats every falsy input as NULL). One stored NULL row
 * must therefore match a buffer event carrying any of these — undefined→'',
 * ''→'', null→'null', 0→'0', false→'false', NaN→'NaN'. Convergence keys
 * canonicalize all of them to '' on BOTH sides. Deliberate small widening:
 * a tool_use with input `0` converges with one whose input was `false`;
 * indistinguishable after storage anyway.
 */
const FALSY_INPUT_COMPONENTS: ReadonlySet<string> = new Set(['', 'null', '0', 'false', 'NaN']);

function canonicalInputComponent(component: string): string {
  return FALSY_INPUT_COMPONENTS.has(component) ? '' : component;
}

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
  return composeKey(
    event.session_id,
    event.type,
    typeof event.prompt === 'string' ? event.prompt.slice(0, PROMPT_FINGERPRINT_CHARS) : '',
    typeof event.tool_name === 'string' ? event.tool_name : '',
    toolInputComponent(event.tool_input),
    typeof event.task_id === 'string' ? event.task_id : '',
    typeof event.agent_id === 'string' ? event.agent_id : '',
  );
}

// ---------------------------------------------------------------------------
// Convergence projections — DB rows and buffer events into ONE key space
// ---------------------------------------------------------------------------
//
// Buffer reconciliation matches stored rows (prompt_batches / activities)
// against buffer events by content. The projections below produce keys in a
// shared "convergence" space: identical to eventDedupKey except that the
// tool_input component is canonicalized via FALSY_INPUT_COMPONENTS so a
// stored NULL matches every falsy event-side input.

/**
 * Convergence key for a buffer event — {@link eventDedupKey} with the
 * tool_input component canonicalized. Used ONLY for matching events against
 * stored rows; the live dispatcher's duplicate cache keeps the exact key.
 */
export function convergenceEventKey(
  event: { type: string; session_id: string } & Record<string, unknown>,
): string {
  return composeKey(
    event.session_id,
    event.type,
    typeof event.prompt === 'string' ? event.prompt.slice(0, PROMPT_FINGERPRINT_CHARS) : '',
    typeof event.tool_name === 'string' ? event.tool_name : '',
    canonicalInputComponent(toolInputComponent(event.tool_input)),
    typeof event.task_id === 'string' ? event.task_id : '',
    typeof event.agent_id === 'string' ? event.agent_id : '',
  );
}

/**
 * Project a stored prompt_batches row into the convergence key space — the
 * key {@link convergenceEventKey} yields for a user_prompt event whose
 * prompt text is the row's stored prompt. A NULL `user_prompt` mirrors the
 * event side's missing-prompt component ('').
 */
export function dedupKeyFromPromptBatch(
  row: { session_id: string; user_prompt: string | null },
): string {
  return composeKey(
    row.session_id,
    'user_prompt',
    typeof row.user_prompt === 'string' ? row.user_prompt.slice(0, PROMPT_FINGERPRINT_CHARS) : '',
    '',
    '',
    '',
    '',
  );
}

/**
 * Activity rows written by bookkeeping handlers (`handleSubagentStart` /
 * `handleSubagentStop`, `handleTaskCompleted`, `handleCompact`,
 * `handleStopFailure` in `event-handlers.ts`). Their source events are not
 * replayable and their tool_input is daemon-synthesized, so they must never
 * consume a tool_use / tool_failure match during buffer convergence.
 */
export const BOOKKEEPING_ACTIVITY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'subagent_start',
  'subagent_stop',
  'stop_failure',
  'task_completed',
  'pre_compact',
  'post_compact',
]);

/** Predicate form of {@link BOOKKEEPING_ACTIVITY_TOOL_NAMES}. */
export function isBookkeepingActivity(toolName: string): boolean {
  return BOOKKEEPING_ACTIVITY_TOOL_NAMES.has(toolName);
}

/**
 * Project a stored activities row into the convergence key space.
 *
 * Type discrimination mirrors the insert paths: `handleToolFailure` writes
 * `success = 0` (and possibly an error_message); everything else from
 * `handleToolUse` is a tool_use. Storage serializes tool_input as
 * `JSON.stringify(input).slice(0, 4000)` while the event side fingerprints
 * the live value — so the stored text is parsed and re-projected through
 * the event-side branch semantics (objects re-stringify byte-identically;
 * a stored `"\"pwd\""` becomes the unquoted `pwd` the event side produces).
 * When the 4000-char truncation tore the JSON, the raw stored text sliced
 * to the fingerprint window is exact (256 < 4000), so the key still matches.
 *
 * Callers must exclude bookkeeping rows first ({@link isBookkeepingActivity});
 * this projection assumes a row that originated from a tool event.
 */
export function dedupKeyFromActivity(
  row: {
    session_id: string;
    tool_name: string;
    tool_input: string | null;
    success: number;
    error_message: string | null;
  },
): string {
  const type = row.success === 0 || row.error_message !== null ? 'tool_failure' : 'tool_use';
  let inputComponent = '';
  if (row.tool_input !== null) {
    try {
      inputComponent = toolInputComponent(JSON.parse(row.tool_input));
    } catch {
      inputComponent = row.tool_input.slice(0, TOOL_INPUT_FINGERPRINT_CHARS);
    }
    inputComponent = canonicalInputComponent(inputComponent);
  }
  return composeKey(row.session_id, type, '', row.tool_name, inputComponent, '', '');
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
