/**
 * Shared constants for the Myco codebase.
 * Per CLAUDE.md: "No Magic Literals — Numeric and string constants
 * MUST NOT appear inline in logic."
 */

// --- Token estimation ---
/** Approximate characters per token for the chars/4 heuristic. */
export const CHARS_PER_TOKEN = 4;

// --- Embedding ---
/** Max characters of text sent to the embedding model. */
export const EMBEDDING_INPUT_LIMIT = 8000;

// --- Truncation limits (display/preview) ---
/** Max chars for a user prompt preview in event summaries. */
export const PROMPT_PREVIEW_CHARS = 300;
/** Max chars for an AI response preview in event summaries. */
export const AI_RESPONSE_PREVIEW_CHARS = 500;
/** Max chars for a command string preview. */
export const COMMAND_PREVIEW_CHARS = 80;
/** Max chars for a content snippet in search results. */
export const CONTENT_SNIPPET_CHARS = 120;
/** Max chars for a tool output preview in hooks. */
export const TOOL_OUTPUT_PREVIEW_CHARS = 200;
/** Max chars for a session summary preview in MCP tools. */
export const SESSION_SUMMARY_PREVIEW_CHARS = 300;
/** Max chars for a recall summary preview. */
export const RECALL_SUMMARY_PREVIEW_CHARS = 200;

// --- Context injection layer budgets (chars, not tokens — used with .slice()) ---
export const CONTEXT_PLAN_PREVIEW_CHARS = 100;
export const CONTEXT_SESSION_PREVIEW_CHARS = 80;
export const CONTEXT_MEMORY_PREVIEW_CHARS = 80;

// --- Processor maxTokens budgets ---
/** Response token budget for observation extraction. */
export const EXTRACTION_MAX_TOKENS = 2048;
/** Response token budget for session summary. */
export const SUMMARY_MAX_TOKENS = 512;
/** Response token budget for session title generation. */
export const TITLE_MAX_TOKENS = 32;
/** Response token budget for artifact classification. */
export const CLASSIFICATION_MAX_TOKENS = 1024;

// --- Timeouts ---
/** Daemon client HTTP request timeout (ms). */
export const DAEMON_CLIENT_TIMEOUT_MS = 2000;
/** Health check timeout (ms) — fail fast if daemon isn't responding. */
export const DAEMON_HEALTH_CHECK_TIMEOUT_MS = 500;
/** LLM request timeout (ms) — prevents hung requests from blocking stop processing. */
export const LLM_REQUEST_TIMEOUT_MS = 30_000;
/** Embedding request timeout (ms). */
export const EMBEDDING_REQUEST_TIMEOUT_MS = 10_000;
/** Stdin read timeout for hooks (ms). */
export const STDIN_TIMEOUT_MS = 100;
/** Chokidar write stability threshold (ms). */
export const FILE_WATCH_STABILITY_MS = 1000;
/** Provider detection timeout for detect-providers CLI command (ms). */
export const PROVIDER_DETECT_TIMEOUT_MS = 3000;

// --- Buffer cleanup ---
/** Max age for stale buffer files before cleanup (ms). */
export const STALE_BUFFER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// --- Retry backoff ---
/** Retry delays for daemon health check (ms). */
export const DAEMON_HEALTH_RETRY_DELAYS = [100, 200, 400, 800, 1500];

// --- Slug limits ---
/** Max length for slugified artifact IDs. */
export const MAX_SLUG_LENGTH = 100;

// --- Content preview for classification prompt ---
/** Max chars of file content per candidate in classification prompt. */
export const CANDIDATE_CONTENT_PREVIEW = 2000;

// --- Transcript mining ---
/** Minimum content length to consider a transcript entry meaningful. */
export const MIN_TRANSCRIPT_CONTENT_LENGTH = 10;

// --- Query limits ---
/** Max recent sessions to check for lineage heuristics. */
export const LINEAGE_RECENT_SESSIONS_LIMIT = 5;
/** Max related memories to query for session notes. */
export const RELATED_MEMORIES_LIMIT = 50;

// --- Context injection ---
/** Max active plans to inject at session start. */
export const SESSION_CONTEXT_MAX_PLANS = 3;
/** Max memories to inject per prompt. */
export const PROMPT_CONTEXT_MAX_MEMORIES = 3;
/** Minimum similarity score for prompt context injection (0-1). */
export const PROMPT_CONTEXT_MIN_SIMILARITY = 0.3;
/** Max token budget for session-start context injection. */
export const SESSION_CONTEXT_MAX_TOKENS = 500;
/** Max token budget for per-prompt context injection. */
export const PROMPT_CONTEXT_MAX_TOKENS = 300;
/** Minimum prompt length to trigger context search. */
export const PROMPT_CONTEXT_MIN_LENGTH = 10;
