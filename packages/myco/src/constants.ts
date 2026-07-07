/**
 * Shared constants for the Myco codebase.
 * Per CLAUDE.md: "No Magic Literals — Numeric and string constants
 * MUST NOT appear inline in logic."
 */

export { LOG_KINDS, type LogKind, kindToComponent } from './constants/log-kinds.js';

// --- Agent phase prompt composition ---
/**
 * Maximum chars per phase summary passed to subsequent phases.
 * Set to 4000 to ensure the digest-assess phase findings pass
 * untruncated to parallel tier phases.
 */
export const PHASE_SUMMARY_MAX_CHARS = 4000;

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

// --- Embedding ---
/** Max characters of text sent to the embedding model. */
export const EMBEDDING_INPUT_LIMIT = 8000;

/** Max rows per embedding worker cycle. */
export const EMBEDDING_BATCH_SIZE = 10;

/** Content hash algorithm for staleness detection. */
export const CONTENT_HASH_ALGORITHM = 'sha256';

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
/** Max chars for search result and hydrated context previews. */
export const SEARCH_PREVIEW_CHARS = 300;

// --- Log preview limits (short previews for structured log fields) ---
/** Max chars for a user prompt preview in log entries. */
export const LOG_PROMPT_PREVIEW_CHARS = 50;
/** Max chars for an assistant message preview in log entries. */
export const LOG_MESSAGE_PREVIEW_CHARS = 80;

// --- Context injection layer budgets (chars, not tokens — used with .slice()) ---
export const CONTEXT_SESSION_PREVIEW_CHARS = 80;
export const CONTEXT_SPORE_PREVIEW_CHARS = 80;

// --- Processor maxTokens budgets ---
/** Response token budget for observation extraction. */
export const EXTRACTION_MAX_TOKENS = 2048;
/** Response token budget for session summary. */
export const SUMMARY_MAX_TOKENS = 512;
/** Response token budget for session title generation. */
export const TITLE_MAX_TOKENS = 32;

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

// --- Job runner ---
/**
 * Default concurrency cap for the daemon JobRunner. The two-lane fair
 * scheduler reserves ≥1 slot per lane, so this must be ≥2.
 */
export const JOB_RUNNER_CONCURRENCY = 3;

// --- Provider detection ---
/** Provider detection timeout for detect-providers CLI command (ms). */
export const PROVIDER_DETECT_TIMEOUT_MS = 3000;

// --- Time ---
/** Milliseconds in one day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Current Unix epoch in seconds. */
export function epochSeconds(): number {
  return Math.floor(Date.now() / MS_PER_SECOND);
}

// --- Buffer cleanup ---
/** Max age for stale buffer files before cleanup (ms). */
export const STALE_BUFFER_MAX_AGE_MS = 1 * MS_PER_DAY;

/**
 * How long a session deletion tombstone survives before
 * `pruneSessionTombstones` reclaims it. Must stay strictly longer than
 * every buffer-retention window (STALE_BUFFER_MAX_AGE_MS and
 * BUFFER_HARD_RETENTION_MS) — a buffer file must never outlive the
 * tombstone that prevents its resurrection. Quarantined buffer files are
 * also pruned at this age, so quarantine never outlives the tombstone
 * window either.
 */
export const TOMBSTONE_RETENTION_MS = 14 * MS_PER_DAY;

/**
 * Hard retention cap for DIVERGING buffer files — buffers convergence has
 * not absorbed (stale-dir orphans, gate-undecidable content, persistent
 * replay failures). At this age the file moves to the buffer dir's
 * `quarantine/` subdirectory instead of being deleted: a diverging buffer
 * is the only durable copy of unreplayed events, so retention removes it
 * from enumeration without destroying it. Strictly shorter than
 * TOMBSTONE_RETENTION_MS (14d), which prunes the quarantined copy.
 */
export const BUFFER_HARD_RETENTION_MS = 7 * MS_PER_DAY;

// --- Capture buffer drain (RC-7 Phase 3) ---
/** Cadence of the periodic quiescence-gated buffer drain job. */
export const CAPTURE_BUFFER_DRAIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long a session's buffer file must sit unmodified before the drain
 * job treats an open-row session as quiescent. Deliberately much wider
 * than the 10s live dedup window (EVENT_DEDUP_WINDOW_MS): the gate is
 * "no turn in flight", not "no duplicate in flight".
 */
export const BUFFER_QUIESCENCE_IDLE_MS = 5 * 60 * 1000;

/**
 * Maximum sessions one drain pass converges, mirroring the drain.slice
 * bound on EMBEDDING_RECONCILE — a backlog spread across many sessions
 * drains across passes instead of monopolizing one tick. Hitting the cap
 * is logged; the remainder is picked up next pass.
 */
export const CAPTURE_BUFFER_DRAIN_SESSION_CAP = 50;

/**
 * Cap on how many drain passes a failing session sits out under
 * exponential backoff (2^attempts passes, capped here) — a poisoned
 * buffer retries at most every ~2h on the 15-minute cadence instead of
 * hot-looping every pass.
 */
export const CAPTURE_BUFFER_DRAIN_BACKOFF_CAP_PASSES = 8;

// --- Stop replay ---
/**
 * How recently a session's latest OPEN batch must have shown activity for a
 * replayed stop event to treat it as a live turn and skip the summary write.
 * An open batch older than this is a missed-Stop turn (the Stop is what
 * closes batches — if it never arrived, the batch stays open forever) and
 * its buffered summary is recoverable. Conservative: the cost of skipping a
 * fresh batch is a delayed recovery on the next pass; the cost of writing
 * onto a live turn is a misattributed summary.
 */
export const STOP_REPLAY_OPEN_BATCH_FRESHNESS_MS = 30 * 60 * MS_PER_SECOND;

// --- Retry backoff ---
/** Retry delays for daemon health check (ms). */
export const DAEMON_HEALTH_RETRY_DELAYS = [100, 200, 400, 800, 1500];

/** Overall deadline for `myco restart` to observe a healthy daemon after
 *  triggering shutdown. Long enough to cover a fresh `npm install`-paced cold
 *  boot, short enough that genuine wedge states surface to the user. */
export const DAEMON_RESTART_HEALTH_DEADLINE_MS = 30_000;
/** Minimum interval between hook-triggered capture recovery restarts. */
export const DAEMON_CAPTURE_RECOVERY_COALESCE_MS = 30_000;

/** Liveness probe attempts before a capture failure may restart the
 *  service, and the pause between attempts. The retry window must ride
 *  out a daemon event-loop stall longer than the capture request
 *  timeout (observed: multi-second stalls during Grove auto-backups). */
export const DAEMON_RECOVERY_PROBE_ATTEMPTS = 3;
export const DAEMON_RECOVERY_PROBE_DELAY_MS = 750;

/** Per-poll interval during the restart health-watch loop (ms). */
export const DAEMON_RESTART_POLL_INTERVAL_MS = 500;

/** How long to give a normal restart before treating "TCP listener bound but
 *  /health silent" as a stuck shutdown and escalating to SIGKILL. Generous
 *  enough that a slow-but-healthy startup isn't force-killed. */
export const DAEMON_STUCK_DETECTION_MS = 6_000;

/** Grace period after daemon.json is written before stale checks can trigger a restart (ms).
 *  Prevents rapid restart loops from concurrent hooks or session reloads. */
export const DAEMON_STALE_GRACE_PERIOD_MS = 60_000;

/** Coalesce window: if daemon.json was written within this window AND its pid
 *  is still alive, a concurrent spawn call should defer to the in-flight
 *  spawner rather than fork another process. Paired with the daemon's own
 *  step-aside guard, this collapses a burst of hook/MCP spawn attempts into
 *  a single surviving daemon. */
export const DAEMON_SPAWN_COALESCE_MS = 3_000;

/** Grace period for SIGTERM before escalating to SIGKILL (ms).
 *  Gives the old daemon a chance to shut down cleanly, but force-kills
 *  to guarantee the configured port is reclaimed. */
export const DAEMON_EVICT_TIMEOUT_MS = 3000;
/** Poll interval when waiting for an evicted daemon to die (ms). */
export const DAEMON_EVICT_POLL_MS = 100;

/** reconcileExistingDaemon: grace period between SIGTERM and SIGKILL when
 *  taking over from a stale/unhealthy/version-mismatched predecessor (ms).
 *  Closes the orphan-zombie window — daemon.json must not be unlinked until
 *  the recorded pid is confirmed dead. Self-mutation-discipline tenet. */
export const RECONCILE_SIGTERM_GRACE_MS = 2000;
/** reconcileExistingDaemon: grace period after SIGKILL before giving up and
 *  stepping aside (ms). A pid that survives this window is unkillable from
 *  user space; we refuse to remove daemon.json and return 'step-aside'. */
export const RECONCILE_SIGKILL_GRACE_MS = 500;
/** reconcileExistingDaemon: poll interval while waiting for the predecessor
 *  pid to exit (ms). */
export const RECONCILE_POLL_MS = 50;
/** reconcileExistingDaemon: how long to let a predecessor that ACCEPTED a
 *  cooperative `/api/shutdown` finish its graceful drain before escalating to
 *  signals (ms). Aligned to the in-flight agent-run drain ceiling (inflight-runs
 *  `DEFAULT_DRAIN_TIMEOUT_MS`) so we never hard-kill a legitimate drain — on
 *  Windows that kill is an uncatchable TerminateProcess that would abort the
 *  very drain we asked for. The wait returns the instant the pid exits, so the
 *  common case (no in-flight work) costs milliseconds, not the full budget. */
export const RECONCILE_COOPERATIVE_GRACE_MS = 30_000;

// --- Slug limits ---
/** Max length for slugified artifact IDs. */

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
/** A non-creating session deliberately retrieved this plan (op:get by id). */
export const EDGE_TYPE_PLAN_REFERENCED = 'PLAN_REFERENCED';
/** A non-creating session deliberately updated this plan (op:save by id). */
export const EDGE_TYPE_PLAN_ADVANCED = 'PLAN_ADVANCED';
// --- Query defaults ---
/** Default row limit for query module list operations. */
export const QUERY_DEFAULT_LIST_LIMIT = 100;
/** Default LIMIT for paginated list queries. */
export const DEFAULT_LIST_LIMIT = 50;
/** Default confidence score for graph edges. */
export const GRAPH_EDGE_DEFAULT_CONFIDENCE = 1.0;

// --- Query limits ---
/** Max recent sessions to check for lineage heuristics. */
export const LINEAGE_RECENT_SESSIONS_LIMIT = 5;
/** Max related spores to query for session notes. */
export const RELATED_SPORES_LIMIT = 50;

// --- Context injection ---
/** Max spores to inject per prompt. */
export const PROMPT_CONTEXT_MAX_SPORES = 3;
/** Max token budget for session-start context injection. */
export const SESSION_CONTEXT_MAX_TOKENS = 500;
/** Max token budget for per-prompt context injection. */
export const PROMPT_CONTEXT_MAX_TOKENS = 300;
/** Minimum prompt length to trigger context search. */
export const PROMPT_CONTEXT_MIN_LENGTH = 10;

/**
 * Candidate pool size for per-prompt spore search. Relevance is decided by
 * hubness-aware Mutual Proximity over this pool (see daemon/embedding/relevance),
 * not an absolute similarity threshold — a fixed cosine cutoff is arbitrary and
 * embedding-model-dependent. A larger pool gives a better query-side distance
 * distribution estimate; the selector then injects only genuinely-separated spores.
 */
export const PROMPT_VECTOR_POOL_SIZE = 50;

// --- Agent identity ---
/** Default agent ID for the built-in intelligence agent. */
export const DEFAULT_AGENT_ID = 'myco-agent';
/** Fallback symbiont name when hook events arrive without agent attribution. */
export const DEFAULT_SYMBIONT_NAME = 'claude-code';
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
/** Default result limit for myco_skills. */
export const MCP_SKILLS_DEFAULT_LIMIT = 50;

// --- Feed ---
/** Default number of entries returned by the activity feed. */
export const FEED_DEFAULT_LIMIT = 50;

// --- Digest — Tiers ---
/** Available token-budget tiers for digest synthesis. */
export const DIGEST_TIERS = [1500, 5000, 10000] as const;
export type DigestTier = (typeof DIGEST_TIERS)[number];
/** Smallest tier — used as the fallback when the preferred tier has no extract yet. */
export const DIGEST_FALLBACK_TIER: DigestTier = DIGEST_TIERS[0];

// --- Digest — Context window minimums per tier ---
/** Minimum context window (tokens) required to run a digest at a given tier. */
export const DIGEST_TIER_MIN_CONTEXT: Record<number, number> = {
  1500: 6500,
  5000: 18500,
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
/** Default number of results returned by vector search and fullTextSearch. */
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

// --- Power management ---
/** PowerManager states valid for task scheduling (excludes deep_sleep which halts all ticks). */
export const SCHEDULABLE_POWER_STATES = ['active', 'idle', 'sleep'] as const;
export type SchedulablePowerState = typeof SCHEDULABLE_POWER_STATES[number];

/** Time without activity before transitioning to idle (ms). */
export const POWER_IDLE_THRESHOLD_MS = 5 * 60 * MS_PER_SECOND;
/** Time without activity before transitioning to sleep (ms). */
export const POWER_SLEEP_THRESHOLD_MS = 30 * 60 * MS_PER_SECOND;
/** Time without activity before transitioning to deep sleep (ms). */
export const POWER_DEEP_SLEEP_THRESHOLD_MS = 90 * 60 * MS_PER_SECOND;
/** Job cycle interval during active/idle states (ms). */
export const POWER_ACTIVE_INTERVAL_MS = 60 * MS_PER_SECOND;
/** Job cycle interval during sleep state (ms). */
export const POWER_SLEEP_INTERVAL_MS = 5 * 60 * MS_PER_SECOND;

// --- Session maintenance ---
/** Time without new prompts before an active session is auto-completed (ms). */
export const STALE_SESSION_THRESHOLD_MS = 60 * 60 * MS_PER_SECOND;
/**
 * Max prompt count for a session to be considered dead and auto-deleted.
 *
 * Set to 0: only sessions that were registered but never received a prompt
 * are eligible for dead-session cleanup. A session with even ONE real user
 * prompt has produced captured state worth preserving — the user did work,
 * the agent likely responded, tool calls may have happened, code may have
 * changed. Deleting such a session was a real data-loss failure mode seen
 * during opencode testing where a 1-prompt session that made an actual
 * committed code change was auto-deleted within a minute of TUI exit.
 */
export const DEAD_SESSION_MAX_PROMPTS = 0;

// --- Init wizard ---
/** Minimum Node.js major version required by Myco. */
export const MIN_NODE_MAJOR_VERSION = 22;

/** Recommended context window for local intelligence models. */
export const RECOMMENDED_LOCAL_CONTEXT_WINDOW = 8192;

/** Default Ollama embedding model recommended during init. */
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'bge-m3';

/** Default OpenAI embedding model recommended during init. */
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

// --- Sync protocol ---
/**
 * Protocol version for backup and team sync wire format.
 *
 * Bumped when the wire format gains capabilities or fields that older
 * clients/workers can't safely interpret. The matching value in
 * `packages/myco-team/worker/wrangler.toml` MUST stay in lockstep —
 * the worker reads it as `env.SYNC_PROTOCOL_VERSION` and parseInt's
 * it at request time.
 *
 * Version history:
 *   1 — initial sync protocol (upsert, delete operations).
 *   2 — adds the SyncRecord `embed` operation for queue-driven
 *       vector reindex, plus the additive `enqueued`/`by_table`
 *       fields on `/vectors/reindex`. Older v1 clients still parse
 *       the legacy fields the worker continues to emit.
 *   3 — adds four synced record types: skill_lineage (content
 *       history) and the DB-resident OKF wiki tables
 *       (okf_generations, okf_pages, okf_page_revisions). Older
 *       workers reject the new table names at the enqueue gate, so
 *       clients must not push them below this version.
 */
export const SYNC_PROTOCOL_VERSION = 3;

/**
 * Oldest sync protocol the current daemon/worker still accepts. Used
 * to gate destructive worker startup chores (D1 one-shot prunes) and
 * to refuse incompatible enqueue payloads with an explicit typed
 * error rather than letting them quietly mis-write rows.
 *
 * The pair forms an inclusive window
 * `[MIN_COMPAT_CLIENT_VERSION, SYNC_PROTOCOL_VERSION]`. Bump this
 * only when a true breaking change lands and there is no
 * additive-shape compat path available.
 */
export const MIN_COMPAT_CLIENT_VERSION = 1;

// --- Team sync ---
/** Default machine ID for rows created before multi-machine support. */
export const DEFAULT_MACHINE_ID = 'local';
/** Prefix for team search result source attribution. */
export const TEAM_SOURCE_PREFIX = 'team:';
/** Timeout for team search requests (ms). */
export const TEAM_SEARCH_TIMEOUT_MS = 3000;
/** Timeout for team health check requests (ms). */
export const TEAM_HEALTH_TIMEOUT_MS = 5000;
/**
 * Default timeout for generic team sync JSON requests (ms).
 *
 * Covers connect, getConfig, collective status/settings/query, rotate, and
 * any other request() path that isn't already bounded by TEAM_SEARCH_TIMEOUT_MS
 * or TEAM_HEALTH_TIMEOUT_MS. Callers making heavier requests (e.g. pushBatch
 * during sync) can override per call.
 */
export const TEAM_REQUEST_TIMEOUT_MS = 15_000;
/** Timeout for team sync pushBatch requests (ms). Larger than generic because payloads may be large. */
export const TEAM_SYNC_TIMEOUT_MS = 30_000;
/** Secrets key for the team API key in secrets.env. */
export const TEAM_API_KEY_SECRET = 'MYCO_TEAM_API_KEY';
/** Secrets key for the team MCP token in secrets.env. */
export const TEAM_MCP_TOKEN_SECRET = 'MYCO_TEAM_MCP_TOKEN';
/** Secrets key for the Collective admin token in secrets.env. */
export const COLLECTIVE_ADMIN_TOKEN_SECRET = 'MYCO_COLLECTIVE_ADMIN_TOKEN';
/** Secrets key for the Collective MCP token in secrets.env. */
export const COLLECTIVE_MCP_TOKEN_SECRET = 'MYCO_COLLECTIVE_MCP_TOKEN';
/** Timeout for wrangler CLI commands (ms). */
export const WRANGLER_COMMAND_TIMEOUT_MS = 60_000;

// --- Team Host ---
/** Secrets key for the host bearer token in secrets.env. Never stored in the registry record itself. */
export const HOST_BEARER_SECRET = 'MYCO_HOST_BEARER';

/**
 * Wire protocol for member-daemon ↔ host-daemon overlay traffic. Bump on any
 * breaking change to the proxied request/response contract or tenancy headers.
 *
 * Distinct from {@link SYNC_PROTOCOL_VERSION}: team-sync (D1 replica) and
 * team-host (live daemon overlay) are independent wire contracts. The pair
 * `[HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION]` is the inclusive window a
 * member accepts from a host, mirroring the sync
 * `[MIN_COMPAT_CLIENT_VERSION, SYNC_PROTOCOL_VERSION]` discipline.
 */
export const HOST_PROTOCOL_VERSION = 1;
/** Oldest host protocol a member still talks to (inclusive window with HOST_PROTOCOL_VERSION). */
export const HOST_MIN_COMPAT_VERSION = 1;

// --- HTTP response flush ---
/** Delay before initiating shutdown — allows the HTTP response to flush. */
export const RESTART_RESPONSE_FLUSH_MS = 500;

// --- Self-update ---
export {
  NPM_REGISTRY_BASE_URL,
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
