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

// --- Log preview limits (short previews for structured log fields) ---
/** Max chars for a user prompt preview in log entries. */
export const LOG_PROMPT_PREVIEW_CHARS = 50;
/** Max chars for an assistant message preview in log entries. */
export const LOG_MESSAGE_PREVIEW_CHARS = 80;

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

/** Milliseconds-to-seconds divisor for Unix epoch conversion. */
const MS_PER_SECOND = 1000;

/** Current Unix epoch in seconds. */
export function epochSeconds(): number {
  return Math.floor(Date.now() / MS_PER_SECOND);
}

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

// --- Turn rendering ---
/** Max file paths displayed per turn in session notes. */
export const TURN_MAX_FILES_DISPLAYED = 10;

// --- Transcript mining ---
/** Minimum content length to consider a transcript entry meaningful. */
export const MIN_TRANSCRIPT_CONTENT_LENGTH = 10;

// --- Graph edge types (lineage — auto-created by daemon) ---
/** Spore was extracted during this session. */
export const EDGE_TYPE_FROM_SESSION = 'FROM_SESSION';
/** Spore was extracted from this prompt batch. */
export const EDGE_TYPE_EXTRACTED_FROM = 'EXTRACTED_FROM';
/** Wisdom spore was derived from (consolidated) this source spore. */
export const EDGE_TYPE_DERIVED_FROM = 'DERIVED_FROM';
/** Session contains this prompt batch. */
export const EDGE_TYPE_HAS_BATCH = 'HAS_BATCH';
/** Spore references an entity (auto-created by name matching). */
export const EDGE_TYPE_REFERENCES = 'REFERENCES';

// --- Query defaults ---
/** Default row limit for query module list operations. */
export const QUERY_DEFAULT_LIST_LIMIT = 100;
/** Default confidence score for graph edges. */
export const GRAPH_EDGE_DEFAULT_CONFIDENCE = 1.0;

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

// --- Spore status filtering ---
/** Spore statuses excluded from search results and context injection. */
export const EXCLUDED_SPORE_STATUSES = new Set(['superseded', 'archived']);

// --- Agent identity ---
/** Default agent ID for the built-in intelligence agent. */
export const DEFAULT_AGENT_ID = 'myco-agent';
/** Agent ID for user-initiated MCP operations. */
export const USER_AGENT_ID = 'user';
/** Agent name for user-initiated MCP operations. */
export const USER_AGENT_NAME = 'User (MCP)';

// --- MCP tool defaults ---
/** Default result limit for myco_search. */
export const MCP_SEARCH_DEFAULT_LIMIT = 10;
/** Default result limit for myco_sessions. */
export const MCP_SESSIONS_DEFAULT_LIMIT = 20;
/** Default result limit for myco_logs. */
export const MCP_LOGS_DEFAULT_LIMIT = 50;

// --- Feed ---
/** Default number of entries returned by the activity feed. */
export const FEED_DEFAULT_LIMIT = 50;

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
/** Default minimum substrate notes required before a digest cycle runs. */
export const DIGEST_MIN_NOTES_FOR_CYCLE = 10;

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

// --- Vault intelligence ---
/** Max candidate spores after post-filtering for supersession check. */
export const SUPERSESSION_CANDIDATE_LIMIT = 5;

/** Over-fetch from vector index before post-filtering by status/type. */
export const SUPERSESSION_VECTOR_FETCH_LIMIT = 20;

/** Max output tokens for supersession LLM evaluation. */
export const SUPERSESSION_MAX_TOKENS = 256;

/** Similarity threshold for clustering related spores in batch agent processing. */
export const AGENT_CLUSTER_SIMILARITY = 0.75;

// --- Search ---
/** Default number of results returned by semanticSearch and fullTextSearch. */
export const SEARCH_RESULTS_DEFAULT_LIMIT = 20;
/** Minimum cosine similarity score for semantic search results (0-1). */
export const SEARCH_SIMILARITY_THRESHOLD = 0.3;

// --- Pipeline processing ---
/** Default page size for pipeline items API listing. */
export const PIPELINE_ITEMS_DEFAULT_LIMIT = 50;

// --- Pipeline retry ---
/** Max retries for parse (structural) pipeline failures — fail fast. */
export const PIPELINE_PARSE_MAX_RETRIES = 1;
/** Exponential backoff multiplier for successive pipeline retries. */
export const PIPELINE_BACKOFF_MULTIPLIER = 4;

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

// --- User task registry ---
/** Subdirectory within the vault for user-created task YAML files. */
export const USER_TASKS_DIR = 'tasks';

/** Source label for user-created tasks. */
export const USER_TASK_SOURCE = 'user';

/** Source label for built-in tasks shipped with the package. */
export const BUILT_IN_SOURCE = 'built-in';

/** Task name validation pattern (lowercase, hyphens, digits). */
export const TASK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Maximum length for task names. */
export const MAX_TASK_NAME_LENGTH = 50;

// --- Automatic consolidation ---
/** Minimum cluster size required before asking LLM to consolidate. */
export const CONSOLIDATION_MIN_CLUSTER_SIZE = 3;

/** Over-fetch from vector index before post-filtering by status/type. */
export const CONSOLIDATION_VECTOR_FETCH_LIMIT = 20;

/** Max output tokens for consolidation LLM synthesis.
 *  Must be large enough for the full JSON response including content field. */
export const CONSOLIDATION_MAX_TOKENS = 2048;
