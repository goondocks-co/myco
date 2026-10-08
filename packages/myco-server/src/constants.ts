export const SERVER_SCHEMA_VERSION = 78;

/** The member identity every dispatched runtime authenticates as; durable so attribution survives across runs. */
export const HARNESS_MEMBER_ID = 'mem_harness';

/**
 * The `revoked_by` of every authority row a restore from another Deployment inserted. On a member it is a hold the
 * owner can lift by assigning the member a role; on a bearer credential, key or grant it is final.
 */
export const FOREIGN_LINEAGE_REVOKER = 'foreign-lineage-restore';

/** Titling: how many of a session's earliest user prompts (with their first response) reach the model. */
export const MAX_MATERIAL_PROMPTS = 12;
/** Titling: the material's total character budget. */
export const MAX_MATERIAL_CHARS = 8_000;
/** Titling: each prompt or response excerpt is cut to this many characters. */
export const MATERIAL_EXCERPT_CHARS = 600;
/** Titling: how many automatic attempts a worker may take on one session before the clock stops asking. */
export const TITLING_MAX_ATTEMPTS = 3;
/**
 * Titling: how long a session that asked for a title at its end must have sent
 * nothing before its title is dispatched. A member's end hook ships the end and
 * then the transcript bytes it closes, inside the hook's own timeout, so a
 * session quiet for longer than any hook may run holds every byte that hook
 * sends. It exceeds the longest hook timeout a symbiont template declares.
 */
export const SESSION_END_SETTLE_MS = 35_000;
/** Titling: how long a session still open must have sent nothing before it counts as ended for titling, when `agent.titling_idle_close_minutes` holds no value. */
export const TITLING_IDLE_CLOSE_MINUTES_DEFAULT = 120;
/** Titling: how many user prompts a titled, still-open session takes after its last titling before it is titled again. */
export const TITLING_REFRESH_MIN_PROMPTS = 10;
/** Titling: the least time between two titlings of one session that is still open. */
export const TITLING_REFRESH_MIN_INTERVAL_MS = 4 * 3_600_000;
/** Titling: a session whose latest activity or end falls inside this window is fresh work, ahead of older backlog. */
export const TITLING_FRESH_WINDOW_MS = 86_400_000;
/** Titling: the fraction of the daily ceiling kept for fresh sessions is one over this number, rounded down; older backlog may use the rest. */
export const TITLING_FRESH_RESERVE_DIVISOR = 3;
export const SERVER_PROTOCOL = 1;
export const MIN_COMPAT_MEMBER_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-myco-protocol';
/**
 * Supported member event features, execution profiles, worker accounting, model catalogs, worker step logs and harness health are advertised to authenticated callers
 * on every answer in `FEATURES_HEADER`.
 */
export { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { MEMBER_FEATURES, MACHINE_SETTINGS_FEATURE } from '@goondocks/myco-shared/member-protocol';
import { WORKER_ACCOUNTING_FEATURE } from '@goondocks/myco-shared/worker-usage';
import { EXECUTION_PROFILE_FEATURE, MODEL_CATALOG_FEATURE, PROFILE_OUTCOME_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { WORKER_STEPS_FEATURE } from '@goondocks/myco-shared/worker-steps';
import { HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';
export const SERVER_FEATURES = [...MEMBER_FEATURES, MACHINE_SETTINGS_FEATURE, WORKER_ACCOUNTING_FEATURE, EXECUTION_PROFILE_FEATURE, PROFILE_OUTCOME_FEATURE, MODEL_CATALOG_FEATURE, WORKER_STEPS_FEATURE, HARNESS_HEALTH_FEATURE] as const;
/** The Project a member request acts on. A credential is Deployment-wide, so the Project travels per request. It rides a header rather than the envelope: an envelope field is a protocol bump, and a member whose spool holds records of the older protocol stops draining them entirely. */
export const PROJECT_HEADER = 'x-myco-project';
/**
 * The most Projects one Deployment holds.
 *
 * A member resolves Projects by naming them, so this is the only bound on the
 * Projects that accept capture: without it, a credential cycling the Project header
 * through fresh names fills the table. An archived Project, which only an admin
 * makes, no longer counts toward it. Set well above what any real Deployment
 * reaches, so it is a backstop against a runaway or hostile runtime rather than a
 * working limit.
 */
export const MAX_PROJECTS = 1_000;

/** The most bytes one blob upload may carry (25 MiB): an abuse guard sized above every real segment — the member ships a transcript in slices of 8 MiB. */
export const MAX_BLOB_BYTES = 26_214_400;
/** How long an in-flight blob reservation holds its upload's authority. A request that dies between reserving and recording its row leaves a row behind; it expires, so an abandoned reservation heals itself. */
export const BLOB_RESERVATION_TTL_MS = 900_000;
export const MAX_CLOCK_SKEW_MS = 300_000;
export const RETRY_AFTER_SECONDS = 60;
export const MINUTE_MS = 60_000;
export const HSTS_MAX_AGE_SECONDS = 31_536_000;
export const TOKEN_ID_PREFIX = 'mt_';

/**
 * The bounds a bounded import may be asked for (#1148).
 *
 * Here rather than beside the policy that reads them: `core/settings.ts`
 * declares the leaf ranges and `core/import-policy.ts` reads the leaves
 * through it, so a bound declared in the policy module would close a cycle
 * between the two.
 *
 * These are the CEILINGS, not the defaults. The default bound is the
 * Deployment's leaf, or the anchor's 30 days and 50 sessions per harness where
 * it has set none; the repeatable command exists to ask for more, so what
 * limits it is the leaf's own range.
 */
export const IMPORT_WINDOW_DAYS_MAX = 3650;
export const IMPORT_MAX_SESSIONS_MAX = 1000;
/** Candidates one plan request may carry; the member trims to its newest this many before asking. */
export const IMPORT_PLAN_MAX_CANDIDATES = 1000;

/** The path an invite link carries, shared with the dashboard and the member. */
export { JOIN_PATH } from '@goondocks/myco-shared/member-protocol';

/** The prefix of a server-named member id, minted when a join enrolls a new person. */
export const MEMBER_ID_PREFIX = 'mem_';
/** The one grammar of a member id: the prefix and up to 64 identity characters — long enough for the ids the v5 backfill named after machines. */
export const MEMBER_ID_SEGMENT = `${MEMBER_ID_PREFIX}[A-Za-z0-9._-]{1,64}`;
export const MEMBER_ID = new RegExp(`^${MEMBER_ID_SEGMENT}$`);


/**
 * How long after a successor's first use a request on its predecessor is still
 * attributable to a rotation race rather than to a second holder.
 *
 * Two hooks on one machine can both be mid-request when one of them rotates: the
 * loser keeps using the predecessor, which the winner's first use has just
 * revoked. A hook cannot outlive its own declared timeout — the harness kills it
 * there — so any request arriving on a superseded credential within that window
 * is one this member started before the rotation landed. Past it, the same
 * request has no such explanation.
 *
 * This must stay above the longest timeout any symbiont template declares, or
 * ordinary rotation races start being recorded as unexplained; the member-side
 * pin in `tests/member/protocol-pins.test.ts` is what fails when it stops being.
 */
export const LINEAGE_REPLAY_GRACE_MS = 120_000;
export const TOKEN_ID_BYTES = 12;

/** The most a Deployment's session-start instructions may carry. A person edits this text; it is not generated. */
export const INSTRUCTIONS_TEMPLATE_MAX_BYTES = 4096;

/**
 * The lease a worker holds on a run it claimed, the cadence that renews it, and
 * how long a worker waits before asking for work again.
 *
 * The relation is what the gate holds, not the values: a lease survives two
 * missed renewals and lapses on the third, and expires strictly before the
 * shortest task budget plus its overrun margin, so a run's own budget and its
 * worker's liveness never answer the same question.
 *
 * The Deployment decides all three and tells a worker on every claim. A worker
 * carries no cadence of its own, so changing one here changes what every
 * attached worker does without shipping a binary.
 */
export const WORKER_LEASE_MS = 90_000;
export const WORKER_HEARTBEAT_MS = 30_000;
export const WORKER_POLL_IDLE_MS = 2_000;

/** Maximum error detail stored on a run. */
export const MAX_RUN_ERROR_CHARS = 2000;

/** The producer a transcript parse writes its derived events under; what tells a derived turn from one a member shipped. */
export const TRANSCRIPT_PARSE_ADAPTER = 'transcript-parse';

/** The agent every member-recorded spore carries; seeded by the schema. */
export const USER_AGENT_ID = 'user';
