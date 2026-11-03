/**
 * Shared constants for the Myco codebase.
 * Per CLAUDE.md: "No Magic Literals — Numeric and string constants
 * MUST NOT appear inline in logic."
 */

export { LOG_KINDS, type LogKind, kindToComponent } from './constants/log-kinds.js';

// --- Token estimation ---
/** Approximate characters per token for the chars/4 heuristic. */
export const CHARS_PER_TOKEN = 4;

/** Estimate token count from character length using the CHARS_PER_TOKEN heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// --- Time (primitives — must precede derived constants) ---
/** Milliseconds per second. */
export const MS_PER_SECOND = 1000;

// --- Truncation limits (display/preview) ---
/** Max chars for a user prompt preview in event summaries. */
export const PROMPT_PREVIEW_CHARS = 300;
/** Max chars for a content snippet in search results. */
export const CONTENT_SNIPPET_CHARS = 120;
/** Max chars for a tool output preview in hooks. */
export const TOOL_OUTPUT_PREVIEW_CHARS = 200;
/** Max chars of a tool's output a member sends in a tool event — what the server's `output` field admits. */
export const TOOL_OUTPUT_CAPTURE_CHARS = 4096;
/** Max chars for search result and hydrated context previews. */
export const SEARCH_PREVIEW_CHARS = 300;

/** Health check timeout (ms) — fail fast if daemon isn't responding. */
export const DAEMON_HEALTH_CHECK_TIMEOUT_MS = 500;

// --- Time ---
/** Milliseconds in one day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** reconcileExistingDaemon: how long to let a predecessor that ACCEPTED a
 *  cooperative `/api/shutdown` finish its graceful drain before escalating to
 *  signals (ms). Aligned to the in-flight agent-run drain ceiling (inflight-runs
 *  `DEFAULT_DRAIN_TIMEOUT_MS`) so we never hard-kill a legitimate drain — on
 *  Windows that kill is an uncatchable TerminateProcess that would abort the
 *  very drain we asked for. The wait returns the instant the pid exits, so the
 *  common case (no in-flight work) costs milliseconds, not the full budget. */
export const RECONCILE_COOPERATIVE_GRACE_MS = 30_000;

// --- Self-update ---
export {
  MYCO_GLOBAL_DIR,
  UPDATE_CHECK_CACHE_PATH,
  UPDATE_CONFIG_PATH,
  UPDATE_ERROR_PATH,
  UPDATE_CHECK_INTERVAL_HOURS,
  MS_PER_HOUR,
  NPM_PACKAGE_NAME,
  UPDATE_SCRIPT_DELAY_SECONDS,
  RELEASE_CHANNELS,
  DEFAULT_RELEASE_CHANNEL,
  type ReleaseChannel,
} from './constants/update.js';
