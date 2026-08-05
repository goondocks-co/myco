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

// --- Content claim system (Team Host WS2) ---
/** Default TTL for a content claim — the backstop that frees an abandoned lock. */
export const CONTENT_CLAIM_TTL_MS = 1 * MS_PER_DAY;
/** Terminal claim rows (released/published/expired) are pruned past this age. */
export const CONTENT_CLAIM_RETENTION_MS = 30 * MS_PER_DAY;

// --- Routed capture idempotency + cache GC (Team Host, consolidation Task C-1) ---
/**
 * Retention for `routed_event_dedup` rows. The ledger is idempotency state,
 * not history: a row's only job is to collapse a live-forward + buffer-replay
 * double-delivery of the SAME source event_id into one host-side write
 * (`db/queries/routed-event-dedup.ts`). It carries no `session_id`, so pruning
 * is necessarily age-based rather than tied to a session-terminal signal
 * (contrast the routed-transcripts cache GC below, which IS
 * session-terminal-gated).
 *
 * The bound must outlive every realistic replay window. The uncapped replay
 * source is the EVENT-REPLAY drain queue over the attached-project collector
 * buffer (`capture/event-replay-drain.ts`). Consolidation Task C-2 (item 6)
 * shipped that queue's member-side acked-entry prune
 * (`EventReplayDrainQueue.noteSessionEnded`, called after the member observes
 * `/sessions/unregister`) — but the bound it produces is CONDITIONAL, not
 * universal: it closes the window to near-zero for a session that ends
 * cleanly (SessionEnd observed, every buffered record acked), but a session
 * that never reaches SessionEnd (member crash, force-quit, killed daemon) has
 * no other prune path — its buffer + high-water entry sit exactly as
 * unbounded as before (the queue's own docstring: "NO TTL / NO cap on
 * pending"), and a reconnecting member can still replay it whenever it next
 * comes online, with no upper bound on the gap. So 30 days remains the right
 * conservative choice for THIS ledger, which must cover that worst case, not
 * just the common clean-completion path:
 * it matches CONTENT_CLAIM_RETENTION_MS (the sibling host-local
 * terminal/idempotency-row retention already in production) and comfortably
 * exceeds every OTHER buffer-survivability window this codebase already
 * enforces (BUFFER_HARD_RETENTION_MS = 7d, TOMBSTONE_RETENTION_MS = 14d) —
 * both of which describe a materially LESS durable queue (a local daemon's
 * own buffers) than an attached member's crash-abandoned replay queue.
 * Shrinking this window without a hard cap on the CRASH case (not just the
 * clean-completion case) risks pruning a dedup row before a legitimately
 * long-delayed replay arrives, producing the exact double-delivery this
 * ledger exists to prevent — don't lower it on the strength of item 6 alone.
 */
export const ROUTED_EVENT_DEDUP_RETENTION_MS = 30 * MS_PER_DAY;

/**
 * How long a session's buffer file must sit unmodified before the drain
 * job treats an open-row session as quiescent. Deliberately much wider
 * than the 10s live dedup window (EVENT_DEDUP_WINDOW_MS): the gate is
 * "no turn in flight", not "no duplicate in flight".
 */
export const BUFFER_QUIESCENCE_IDLE_MS = 5 * 60 * 1000;

/**
 * How long a routed session's materialized cache tree must sit unmodified
 * (newest mtime under `<machine>/<session>/`) before the routed-transcript
 * cache GC will prune it. Closes the late-append TOCTOU: the transcript
 * ingest route (`host/routed-transcript.ts` POST /routed-capture/transcript)
 * appends purely by offset and never touches the sessions row, so a
 * reconnecting member's drain backstop can land tail bytes AFTER the stale
 * sweep completed (and mined) the session — with no event, no reactivation,
 * and no new mining trigger. The GC therefore refuses to prune any tree
 * whose newest write is at/after the session's completion time OR within
 * this window of now (prune-only-when-quiet discipline).
 *
 * A named sibling of BUFFER_QUIESCENCE_IDLE_MS rather than a reuse: the
 * gates share the "no write in flight" meaning and the same 5-minute
 * width today, but they guard different queues (member collector buffer
 * vs host transcript cache) and must stay independently tunable — widening
 * one gate should never silently widen the other.
 */
export const ROUTED_TRANSCRIPT_GC_QUIESCENCE_MS = 5 * 60 * 1000;

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
 * error rather than letting them quietly mis-write rows. Live: verified
 * against `packages/myco-team/worker/wrangler.toml`'s lockstep value by
 * `tests/worker/manifest.test.ts` and `tests/worker/team-worker-schedule.test.ts`.
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
/**
 * Secrets key for the team API key in secrets.env. Live: used by the
 * standalone `myco-team` provisioning CLI (`packages/myco-team/src/cli.ts`)
 * to read/write the team worker's API key via `teamRegistry`/`wrangler secret`.
 */
export const TEAM_API_KEY_SECRET = 'MYCO_TEAM_API_KEY';
/**
 * Secrets key for the team MCP token in secrets.env. Live: used by the
 * standalone `myco-team` provisioning CLI alongside {@link TEAM_API_KEY_SECRET}.
 */
export const TEAM_MCP_TOKEN_SECRET = 'MYCO_TEAM_MCP_TOKEN';
/** Secrets key for the Collective admin token in secrets.env. */
export const COLLECTIVE_ADMIN_TOKEN_SECRET = 'MYCO_COLLECTIVE_ADMIN_TOKEN';
/** Secrets key for the Collective MCP token in secrets.env. */
export const COLLECTIVE_MCP_TOKEN_SECRET = 'MYCO_COLLECTIVE_MCP_TOKEN';
/**
 * Timeout for wrangler CLI commands (ms). Live: used by the standalone
 * `myco-team` provisioning CLI (`packages/myco-team/src/cli.ts`) to bound
 * `runWrangler` invocations during team worker provisioning/deploy.
 */
export const WRANGLER_COMMAND_TIMEOUT_MS = 60_000;

// --- Team Host ---
/** Secrets key for the host bearer token in secrets.env. Never stored in the registry record itself.
 *  MEMBER-side name: the bearer a member received at enrollment and presents to the host, stored in
 *  the host record's `secrets.env` under the machine-global hosts registry. */
export const HOST_BEARER_SECRET = 'MYCO_HOST_BEARER';
/**
 * HOST-side name for the same bearer, stored machine-scoped in `~/.myco/secrets.env`.
 * The host mints it when host-serve is enabled; every request arriving on the overlay
 * listener must present it as `Authorization: Bearer <value>`. Task 2.4's enrollment
 * hands this value to a joining member, who then stores it under {@link HOST_BEARER_SECRET}.
 * Distinct key + storage location, one shared value — the single flat-trust host bearer (spec §8/§9).
 */
export const HOST_SERVE_BEARER_SECRET = 'MYCO_HOST_SERVE_BEARER';
/**
 * TRANSPORT name only — the `--serve`/`host enable --emit-join` CLI flag
 * (`--team-key`) and its env-var fallback (`process.env[TEAM_AGENT_KEY_SECRET]`)
 * for the team's LLM provider API key at enable time. This is NOT the name the
 * key is stored under: `hostEnableAndEmitJoin` writes it into the served
 * Grove's `secrets.env` under the PROVIDER-STANDARD env name
 * (`KEYED_CLOUD_PROVIDER_ENV`, `agent/harness/provider-health.ts` — anthropic by
 * default) so `probeProviderAvailable`/`missingKeyReason` actually read it. A
 * key stored under this transport name instead would never be found by a real
 * dispatch (Task 8's cross-task invariant, fixing exactly that hazard).
 * Distinct from the legacy Team-Sync {@link TEAM_API_KEY_SECRET}, which
 * lives in the team-sync registry's own store, not a Grove.
 */
export const TEAM_AGENT_KEY_SECRET = 'MYCO_TEAM_AGENT_KEY';
/**
 * Machine-scoped secret key retained for external MCP containment and status.
 * The raw value lives in `~/.myco/secrets.env`; status surfaces expose only
 * its non-secret change-detection hash.
 */
export const HOST_EXTERNAL_MCP_TOKEN_SECRET = 'MYCO_HOST_EXTERNAL_MCP_TOKEN';
/**
 * Default port recorded in external MCP containment state. It remains
 * distinct from the daemon and overlay ports so exact-port Funnel-off can
 * reconcile persisted state without touching unrelated Funnel targets.
 */
export const EXTERNAL_MCP_DEFAULT_PORT = 8743;
/** Health posture value for a daemon with NO external MCP activation — the
 *  fleet default, and the only value pre-activation binaries know. */
export const EXTERNAL_MCP_ACTIVATION_POSTURE = 'retired' as const;
/** Health posture value for a daemon whose explicit config has external MCP
 *  ENABLED (activation-era binaries only). */
export const EXTERNAL_MCP_ACTIVE_POSTURE = 'active' as const;
/**
 * Every posture a well-formed Myco daemon can report. The eviction predicate
 * derives its accepted set from THIS constant (never literals): a successor
 * may step aside / terminate any daemon reporting a known posture, because
 * an activation-era successor's boot reconcile re-establishes exposure and
 * a `shutdown` containment only quiesces (config survives). A pre-activation
 * binary still requires `retired` — so a DOWNGRADE meeting an `active`
 *  daemon terminates it and its own boot then disavows the config: downgrade
 * quietly deactivates external MCP (recorded in the PR 8 rollback docs).
 */
export const KNOWN_EXTERNAL_MCP_POSTURES = [
  EXTERNAL_MCP_ACTIVATION_POSTURE,
  EXTERNAL_MCP_ACTIVE_POSTURE,
] as const;

/**
 * Directory segment under a served Grove's dir (`<grove>/hosted/<projectId>`)
 * that namespaces the SYNTHETIC project roots minted by host registration-on-
 * ingest (E-4 W2 T1). A member-attached project has no working tree on the host,
 * so its registry row gets a synthetic root that (a) passes `assertSafeProjectRoot`
 * and (b) never exists on disk — the same tree-absence signal `projectTreeAvailable`
 * already keys the behave-like-local degrade on. The segment is the marker the
 * status count and the prune job filter registered rows by.
 */
export const HOSTED_PROJECT_ROOT_SEGMENT = 'hosted';

/**
 * Length of the id suffix used as the placeholder display name for a hosted
 * project registered on ingest (`registerProjectInGrove` requires a name, but the
 * host never sees the member's chosen project name). The last N hex characters of
 * the grove-era project id — enough to disambiguate in the operator dashboard
 * without inventing a fake human name.
 */
export const HOSTED_PROJECT_NAME_ID_SUFFIX_LEN = 8;

/**
 * TTL after which a hosted (synthetic-root) registry row with ZERO Grove-DB
 * references (no sessions/spores/plans for its project id) becomes eligible for
 * the housekeeping prune (E-4 W2 T1e / decision D-W2-5). A row with any data is
 * structurally never pruned regardless of age — this window only bounds how long
 * an EMPTY stray row (an ingest that registered but never landed a DB write)
 * lingers. Matches the 14-day tombstone/retention family already in this file.
 */
export const HOSTED_PROJECT_PRUNE_TTL_MS = 14 * MS_PER_DAY;

/**
 * Wire protocol for member-daemon ↔ host-daemon overlay traffic. Bump on any
 * breaking change to the proxied request/response contract or tenancy headers.
 *
 * Distinct from {@link SYNC_PROTOCOL_VERSION}: team-sync (D1 replica) and
 * team-host (live daemon overlay) are independent wire contracts. The pair
 * `[HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION]` is the inclusive window a
 * member accepts from a host, mirroring the sync
 * `[MIN_COMPAT_CLIENT_VERSION, SYNC_PROTOCOL_VERSION]` discipline.
 *
 * History:
 *   - v1: base overlay contract (proxied capture/serve + tenancy headers).
 *   - v2: enrollment self-reports `served_grove_id` (additive; see
 *         HOST_MIN_COMPAT_VERSION).
 *   - v3: residency ingest — the host serves `POST /routed-capture/residency-rows`
 *         (a with-history attach pushes a project's rows here) and accepts the
 *         request's `adoption` field to upgrade a hosted project's placeholder
 *         name to the member's real name. A member gates a with-history attach on
 *         a recorded host protocol ≥ 3 (RESIDENCY_MIN_HOST_PROTOCOL) — the
 *         lockstep bump: update the host before members.
 *   - v4: the transport itself changed. A host is reached at its public
 *         `host_url` over HTTPS instead of an overlay address on a private
 *         tailnet, so a v3 member holds a dial address that resolves nowhere.
 *         This is the one version step that is not additive, which is why
 *         HOST_MIN_COMPAT_VERSION rises to meet it.
 */
export const HOST_PROTOCOL_VERSION = 4;
/**
 * Oldest host protocol a member still talks to (inclusive window with
 * HOST_PROTOCOL_VERSION).
 *
 * Raised 1 → 4 with the transport change, and raising it is the whole point:
 * both gates test the INCLUSIVE window (host `host-serve.ts`, member
 * `host-proxy.ts` `hostProtocolCompatible`), so bumping only the current
 * version would WIDEN the accepted range to [1,4] and let a pre-transport
 * member pass a gate designed to stop it — then time out against an overlay
 * address nothing answers. A refusal at the version gate is loud and
 * non-retryable; a dial into a dead tailnet is neither.
 */
export const HOST_MIN_COMPAT_VERSION = 4;

/**
 * Request header carrying the member's Team-Host protocol version on every
 * proxied request. Rides alongside the tenancy headers so the version travels
 * without the proxy ever parsing the (opaque) request body. The host's
 * transport gate validates it and, on mismatch, replies 409
 * `protocol_version_unsupported` echoing this header with its own version.
 */
export const HOST_PROTOCOL_HEADER = 'x-myco-host-protocol';

/**
 * The host-side enrollment endpoint (Task 2.4). A joining member POSTs here at
 * the host's public URL to receive `{protocol_version, bearer, …}`. It is the
 * one team route EXEMPT from the blanket bearer gate (the chicken-and-egg:
 * enrollment is how the member obtains the bearer), which is exactly why it is
 * NOT in `TEAM_ADMITTED_RAW_ROUTES` on this build: its old gate was overlay
 * membership, and with the overlay gone, publishing it would hand the bearer to
 * anyone. It is re-admitted only alongside the daemon-validated single-use key.
 * The `/api/host/*` namespace is distinct from team-sync's `POST /api/team/join`
 * (scope-map ⚑4) — different capabilities on different transports.
 */
export const HOST_ENROLL_ROUTE = '/api/host/enroll';

/**
 * Step-5 enrollment retry-with-backoff (server-mode design spec §4): a
 * transient overlay/DERP-settling failure shouldn't burn a whole `myco join`
 * run — enrollment is a one-shot POST that can lose the race against the
 * overlay finishing settling. Delays between attempts only (none before the
 * first, none after the last exhausts) — 3 attempts total, 2s then 4s apart.
 * The final attempt's failure surfaces to the caller unchanged.
 */
export const ENROLLMENT_RETRY_BACKOFFS_MS = [2000, 4000] as const;

/**
 * The public port a Team Host's Funnel serves on.
 *
 * Tailscale Funnel permits exactly three public ports — 443, 8443, 10000 — so
 * this is a choice among three, not a free parameter. Team takes 8443 and the
 * external read-only MCP surface keeps 443 ({@link EXTERNAL_MCP_FUNNEL_PORT}):
 * a host is someone's real machine, and 443 is the port its OTHER services are
 * most likely to want. Two Myco funnels also cannot share a public port at
 * different mounts — Funnel routes by longest path prefix, so a member's `/mcp`
 * would land on the external-MCP socket, whose token and allowlist are
 * different — which makes the split structural rather than a preference.
 *
 * Accepted cost: a member behind 443-only egress cannot reach a host. The
 * health probe names that case specifically rather than reporting a generic
 * unreachable — see `describeHostReachability` (`host/host-url.ts`).
 */
export const TEAM_FUNNEL_PORT = 8443;

/** The public port the external read-only MCP Funnel serves on. Shipped at 443
 *  before team hosting needed a public port; kept there so no advertised URL
 *  moves. See {@link TEAM_FUNNEL_PORT} for why the two cannot share one. */
export const EXTERNAL_MCP_FUNNEL_PORT = 443;

/** The external read-only MCP Funnel's mount. A PATH mount, unlike the team
 *  surface's root: Funnel strips it before proxying and the external listener
 *  re-adds it, which is why the two surfaces cannot share a public port. */
export const EXTERNAL_MCP_MOUNT = '/mcp';

/** The team Funnel's mount. ROOT, and load-bearing: the member→host contract
 *  keys on exact pathnames (`ROUTE_RULES`, `SERVE_DEFAULT_ROUTES`), and any
 *  non-root mount makes Funnel strip its prefix before the request reaches the
 *  listener — every pathname rewritten, the whole stamp table missing. */
export const TEAM_FUNNEL_MOUNT = '/';

/**
 * Member→host proxy timeouts (the host-proxy forwarder, `daemon/host-proxy.ts`).
 * These bound the INNER overlay hop and must stay shorter than the local
 * caller's own end-to-end timeout (`DAEMON_CLIENT_TIMEOUT_MS`) for the buffered
 * class, so the caller sees a clean proxy error rather than its own abort.
 */
/** Overlay dial (connect) timeout (ms) — fast dead-peer detection. */
export const HOST_PROXY_CONNECT_TIMEOUT_MS = 3000;
/** Response-headers timeout (ms) — bounds connect+headers so a dial never hangs. */
export const HOST_PROXY_HEADERS_TIMEOUT_MS = 10_000;
/** Response-body timeout (ms) for the buffered (non-`/mcp`) response class. */
export const HOST_PROXY_BODY_TIMEOUT_MS = 30_000;
/**
 * Idle-read timeout (ms) for a held `/mcp` stream. A streamed tool result may
 * legitimately run long, so there is NO fixed body timeout — this fires only on
 * a truly stalled stream (no bytes for this long); it resets on every chunk.
 */
export const HOST_PROXY_MCP_IDLE_TIMEOUT_MS = 120_000;
/**
 * Max bytes the proxy will buffer when it MUST read a request body: the collect
 * routes (append to the local collector buffer before forwarding) and the one
 * `/mcp` tool-name peek. Mirrors the daemon's own 8 MB inbound cap.
 */
export const HOST_PROXY_MAX_BUFFERED_BODY_BYTES = 8 * 1024 * 1024;

// --- Refusal-log throttle (Task 2, E-4 W2) ---
/**
 * Throttle interval for structured Team Host refusal log lines — host-side
 * unknown-tenancy and served-grove refusals (`daemon/server.ts`, `mcp/http.ts`)
 * and the member-side relayed-upstream-failure warn (`daemon/host-proxy.ts`).
 * Long enough that a member's capture-drain retry loop — which reissues the
 * identical refused request every daemon tick — doesn't turn one still-refused
 * condition into a log storm; short enough that a genuinely anomalous refusal
 * resurfaces within a few minutes rather than going silent for the life of
 * the daemon (`daemon/log-throttle.ts`'s `shouldLogOncePerInterval`).
 */
export const REFUSAL_LOG_THROTTLE_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Cap on distinct keys `daemon/log-throttle.ts` tracks at once. Bounds memory
 * against an effectively unbounded key space (arbitrary paths/Grove ids/host
 * ids); the single oldest entry is evicted once the cap is reached.
 */
export const REFUSAL_LOG_THROTTLE_MAX_KEYS = 1000;

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
