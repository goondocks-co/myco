/**
 * Shared constants for the Myco codebase.
 * Per CLAUDE.md: "No Magic Literals — Numeric and string constants
 * MUST NOT appear inline in logic."
 */

// --- Token estimation ---
/** Approximate characters per token for the chars/4 heuristic. */
export const CHARS_PER_TOKEN = 4;

/** Estimate token count from character length using the CHARS_PER_TOKEN heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

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
export const CONTEXT_SPORE_PREVIEW_CHARS = 80;

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
/** LLM request timeout (ms). All LLM calls are background daemon work — no need to be aggressive. */
export const LLM_REQUEST_TIMEOUT_MS = 180_000;
/** Embedding request timeout (ms). Embeddings run in background batch processing — generous timeout. */
export const EMBEDDING_REQUEST_TIMEOUT_MS = 60_000;
/** Digest LLM request timeout (ms). Digest cycles use large context windows and may need model loading time. */
export const DIGEST_LLM_REQUEST_TIMEOUT_MS = 600_000;
/** Stdin read timeout for hooks (ms). */
export const STDIN_TIMEOUT_MS = 100;
/** Chokidar write stability threshold (ms). */
export const FILE_WATCH_STABILITY_MS = 1000;
/** Provider detection timeout for detect-providers CLI command (ms). */
export const PROVIDER_DETECT_TIMEOUT_MS = 3000;

// --- Time ---
/** Milliseconds in one day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- Buffer cleanup ---
/** Max age for stale buffer files before cleanup (ms). */
export const STALE_BUFFER_MAX_AGE_MS = 1 * MS_PER_DAY;

// --- Retry backoff ---
/** Retry delays for daemon health check (ms). */
export const DAEMON_HEALTH_RETRY_DELAYS = [100, 200, 400, 800, 1500];

/** Grace period after daemon.json is written before stale checks can trigger a restart (ms).
 *  Prevents rapid restart loops from concurrent hooks or session reloads. */
export const DAEMON_STALE_GRACE_PERIOD_MS = 60_000;

/** Grace period for SIGTERM before escalating to SIGKILL (ms).
 *  Gives the old daemon a chance to shut down cleanly, but force-kills
 *  to guarantee the configured port is reclaimed. */
export const DAEMON_EVICT_TIMEOUT_MS = 3000;
/** Poll interval when waiting for an evicted daemon to die (ms). */
export const DAEMON_EVICT_POLL_MS = 100;

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
/** Max related spores to query for session notes. */
export const RELATED_SPORES_LIMIT = 50;

// --- Context injection ---
/** Max active plans to inject at session start. */
export const SESSION_CONTEXT_MAX_PLANS = 3;
/** Max spores to inject per prompt. */
export const PROMPT_CONTEXT_MAX_SPORES = 3;
/** Minimum similarity score for prompt context injection (0-1). */
export const PROMPT_CONTEXT_MIN_SIMILARITY = 0.3;
/** Max token budget for session-start context injection. */
export const SESSION_CONTEXT_MAX_TOKENS = 500;
/** Max token budget for per-prompt context injection. */
export const PROMPT_CONTEXT_MAX_TOKENS = 300;
/** Minimum prompt length to trigger context search. */
export const PROMPT_CONTEXT_MIN_LENGTH = 10;

// --- MCP tool defaults ---
/** Default result limit for myco_search. */
export const MCP_SEARCH_DEFAULT_LIMIT = 10;
/** Default result limit for myco_sessions. */
export const MCP_SESSIONS_DEFAULT_LIMIT = 20;
/** Default result limit for myco_logs. */
export const MCP_LOGS_DEFAULT_LIMIT = 50;

// --- Digest — Tiers ---
/** Available token-budget tiers for digest synthesis. */
export const DIGEST_TIERS = [1500, 3000, 5000, 7500, 10000] as const;
export type DigestTier = (typeof DIGEST_TIERS)[number];

// --- Digest — Context window minimums per tier ---
/** Minimum context window (tokens) required to run a digest at a given tier. */
export const DIGEST_TIER_MIN_CONTEXT: Record<number, number> = {
  1500: 6500,
  3000: 11500,
  5000: 18500,
  7500: 24500,
  10000: 30500,
};

// --- Digest — Substrate ---
/** Scoring weights by note type when selecting substrate for synthesis. */
export const DIGEST_SUBSTRATE_TYPE_WEIGHTS: Record<string, number> = {
  session: 3,
  spore: 3,
  plan: 2,
  artifact: 1,
  team: 1,
};

// --- LLM reasoning control ---
/** Reasoning mode for all Myco LLM calls. Suppresses chain-of-thought tokens from reasoning models. */
export const LLM_REASONING_MODE = 'off' as const;

// --- Digest — System prompt overhead estimate ---

// --- Vault curation ---
/** Max candidate spores after post-filtering for supersession check. */
export const SUPERSESSION_CANDIDATE_LIMIT = 5;

/** Over-fetch from vector index before post-filtering by status/type. */
export const SUPERSESSION_VECTOR_FETCH_LIMIT = 20;

/** Max output tokens for supersession LLM evaluation. */
export const SUPERSESSION_MAX_TOKENS = 256;

/** Similarity threshold for clustering related spores in batch curation. */
export const CURATION_CLUSTER_SIMILARITY = 0.75;

// --- Pipeline processing ---
/** Daemon tick interval for pipeline processing (ms). */
export const PIPELINE_TICK_INTERVAL_MS = 30_000;
/** Default number of work items processed per stage per pipeline tick. */
export const PIPELINE_BATCH_SIZE = 20;
/** Max days to retain completed/failed pipeline work items before pruning. */
export const PIPELINE_RETENTION_DAYS = 30;
/** Default page size for pipeline items API listing. */
export const PIPELINE_ITEMS_DEFAULT_LIMIT = 50;

// --- Pipeline retry ---
/** Max retries for transient (recoverable) pipeline failures. */
export const PIPELINE_TRANSIENT_MAX_RETRIES = 3;
/** Max retries for parse (structural) pipeline failures — fail fast. */
export const PIPELINE_PARSE_MAX_RETRIES = 1;
/** Base backoff duration between pipeline retry attempts (ms). */
export const PIPELINE_BACKOFF_BASE_MS = 30_000;
/** Exponential backoff multiplier for successive pipeline retries. */
export const PIPELINE_BACKOFF_MULTIPLIER = 4;

// --- Pipeline circuit breaker ---
/** Number of consecutive failures before opening a circuit breaker. */
export const PIPELINE_CIRCUIT_FAILURE_THRESHOLD = 3;
/** Initial cooldown duration when a circuit breaker opens (ms). */
export const PIPELINE_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
/** Maximum cooldown duration for a circuit breaker (ms). */
export const PIPELINE_CIRCUIT_MAX_COOLDOWN_MS = 60 * 60 * 1000;

// --- Pipeline stages (ordered) ---
export const PIPELINE_STAGES = ['capture', 'extraction', 'embedding', 'consolidation', 'digest'] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];

// --- Pipeline statuses ---
export const PIPELINE_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'blocked', 'skipped', 'poisoned'] as const;
export type PipelineStatus = typeof PIPELINE_STATUSES[number];

// --- Provider roles for circuit breakers ---
export const PIPELINE_PROVIDER_ROLES = ['llm', 'embedding', 'digest-llm'] as const;
export type PipelineProviderRole = typeof PIPELINE_PROVIDER_ROLES[number];

// --- Stage to provider role mapping ---
export const STAGE_PROVIDER_MAP: Record<PipelineStage, PipelineProviderRole | null> = {
  capture: null,
  extraction: 'llm',
  embedding: 'embedding',
  consolidation: 'digest-llm',
  digest: 'digest-llm',
};

/**
 * Stages processed by the pipeline tick timer.
 * Capture is handled at registration time, digest is gated by the metabolism timer.
 */
export const PIPELINE_TICK_STAGES: PipelineStage[] = ['extraction', 'embedding', 'consolidation'];

// --- Item type to applicable stages ---
// Sessions skip consolidation — consolidation applies to the spores
// extracted FROM sessions, not the session work item itself.
// Lineage detection stays outside the pipeline (fire-and-forget, non-critical).
export const ITEM_STAGE_MAP: Record<string, PipelineStage[]> = {
  session: ['capture', 'extraction', 'embedding', 'digest'],
  spore: ['capture', 'embedding', 'consolidation', 'digest'],
  artifact: ['capture', 'embedding', 'digest'],
};

// --- Automatic consolidation ---
/** Minimum cluster size required before asking LLM to consolidate. */
export const CONSOLIDATION_MIN_CLUSTER_SIZE = 3;

/** Over-fetch from vector index before post-filtering by status/type. */
export const CONSOLIDATION_VECTOR_FETCH_LIMIT = 20;

/** Max output tokens for consolidation LLM synthesis.
 *  Must be large enough for the full JSON response including content field. */
export const CONSOLIDATION_MAX_TOKENS = 2048;
