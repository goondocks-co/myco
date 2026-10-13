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

// --- Timeouts ---
/** Daemon client HTTP request timeout (ms). */
export const DAEMON_CLIENT_TIMEOUT_MS = 2000;
/** Health check timeout (ms) — fail fast if daemon isn't responding. */
export const DAEMON_HEALTH_CHECK_TIMEOUT_MS = 500;

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
/** Terminal claim rows (released/published/expired) are pruned past this age. */
export const CONTENT_CLAIM_RETENTION_MS = 30 * MS_PER_DAY;

/**
 * How long a session's buffer file must sit unmodified before the drain
 * job treats an open-row session as quiescent. Deliberately much wider
 * than the 10s live dedup window (EVENT_DEDUP_WINDOW_MS): the gate is
 * "no turn in flight", not "no duplicate in flight".
 */
export const BUFFER_QUIESCENCE_IDLE_MS = 5 * 60 * 1000;
/** reconcileExistingDaemon: how long to let a predecessor that ACCEPTED a
 *  cooperative `/api/shutdown` finish its graceful drain before escalating to
 *  signals (ms). Aligned to the in-flight agent-run drain ceiling (inflight-runs
 *  `DEFAULT_DRAIN_TIMEOUT_MS`) so we never hard-kill a legitimate drain — on
 *  Windows that kill is an uncatchable TerminateProcess that would abort the
 *  very drain we asked for. The wait returns the instant the pid exits, so the
 *  common case (no in-flight work) costs milliseconds, not the full budget. */
export const RECONCILE_COOPERATIVE_GRACE_MS = 30_000;

// --- Agent identity ---
/** Default agent ID for the built-in intelligence agent. */
export const DEFAULT_AGENT_ID = 'myco-agent';
/** Agent ID for user-initiated MCP operations. */
export const USER_AGENT_ID = 'user';

// --- Digest — Tiers ---
/** Available token-budget tiers for digest synthesis. */
export const DIGEST_TIERS = [1500, 5000, 10000] as const;
export type DigestTier = (typeof DIGEST_TIERS)[number];

// --- Pipeline stages (ordered) ---
export const PIPELINE_STAGES = ['capture', 'extraction', 'embedding', 'consolidation', 'digest'] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];

// --- Pipeline statuses ---
export const PIPELINE_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'blocked', 'skipped', 'poisoned'] as const;
export type PipelineStatus = typeof PIPELINE_STATUSES[number];

// --- Provider roles for circuit breakers ---
export const PIPELINE_PROVIDER_ROLES = ['llm', 'embedding', 'digest-llm'] as const;
export type PipelineProviderRole = typeof PIPELINE_PROVIDER_ROLES[number];

// --- Power management ---
/** PowerManager states valid for task scheduling (excludes deep_sleep which halts all ticks). */
export const SCHEDULABLE_POWER_STATES = ['active', 'idle', 'sleep'] as const;
export type SchedulablePowerState = typeof SCHEDULABLE_POWER_STATES[number];

// --- Team Host ---
/** Secrets key for the host bearer token in secrets.env. Never stored in the registry record itself.
 *  MEMBER-side name: the bearer a member received at enrollment and presents to the host, stored in
 *  the host record's `secrets.env` under the machine-global hosts registry. */
export const HOST_BEARER_SECRET = 'MYCO_HOST_BEARER';
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
 */
export const TEAM_AGENT_KEY_SECRET = 'MYCO_TEAM_AGENT_KEY';
/**
 * Machine-scoped secret key retained for external MCP containment and status.
 * The raw value lives in `~/.myco/secrets.env`; status surfaces expose only
 * its non-secret change-detection hash.
 */
export const HOST_EXTERNAL_MCP_TOKEN_SECRET = 'MYCO_HOST_EXTERNAL_MCP_TOKEN';
/** Health posture value for a daemon with NO external MCP activation — the
 *  fleet default, and the only value pre-activation binaries know. */
export const EXTERNAL_MCP_ACTIVATION_POSTURE = 'retired' as const;
/** Health posture value for a daemon whose explicit config has external MCP
 *  ENABLED (activation-era binaries only). */
export const EXTERNAL_MCP_ACTIVE_POSTURE = 'active' as const;

/**
 * Wire protocol for member-daemon ↔ host-daemon overlay traffic. Bump on any
 * breaking change to the proxied request/response contract or tenancy headers.
 *
 * The pair `[HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION]` is the inclusive
 * window a member accepts from a host.
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
 *   - v5: residency ingest allow-lists every project-scoped table, not the
 *         nineteen inherited from team sync. A protocol-4 host answers 400
 *         `unknown table` for the seventeen added, so a member gates a
 *         with-history attach on ≥ 5 (RESIDENCY_MIN_HOST_PROTOCOL) — the same
 *         lockstep as v3: update the host before members. Additive in every
 *         other direction, so HOST_MIN_COMPAT_VERSION stays at 4.
 */
export const HOST_PROTOCOL_VERSION = 5;
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

/** The team Funnel's mount. ROOT, and load-bearing: the member→host contract
 *  keys on exact pathnames (`ROUTE_RULES`, `SERVE_DEFAULT_ROUTES`), and any
 *  non-root mount makes Funnel strip its prefix before the request reaches the
 *  listener — every pathname rewritten, the whole stamp table missing. */
export const TEAM_FUNNEL_MOUNT = '/';

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
