/**
 * Member-side constants: the protocol the member speaks, the classification
 * codes it acts on, its time budgets, and its spool retention. A leaf — the
 * values the server side shares (`MEMBER_PROTOCOL`, `MEMBER_CODES`, the
 * payload ceilings) are pinned against the worker by cross-package tests.
 */

/** The wire protocol this member produces; sent as `x-myco-protocol` on every request. */
export const MEMBER_PROTOCOL = 1;

/** The header carrying the member protocol; the server answers it on every authenticated response. */
export const PROTOCOL_HEADER = 'x-myco-protocol';

/**
 * The header naming the Project a request acts on. A credential is
 * Deployment-wide, so the Project is per-request rather than a property of the
 * token; a request without it is refused `no_project`.
 */
export const PROJECT_HEADER = 'x-myco-project';

/**
 * The credential and the protocol, which every member request carries.
 *
 * Every member call composes its headers through this file and
 * `tests/meta/member-bearer-composition.test.ts` holds that. A Deployment
 * answers a request that declares no protocol with 409
 * `protocol_version_unsupported` — on every route, for the life of the process
 * — so a call site writing its own bearer header reaches no Deployment at all
 * while passing every test that stubs one.
 */
function credentialHeaders(token: string, protocol: number): Record<string, string> {
  return { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(protocol) };
}

/**
 * The headers a request that acts on one Project carries. The Project is
 * required: a credential is Deployment-wide, so a request that names none is
 * refused `no_project`, and an optional argument would turn forgetting it into a
 * silently omitted header rather than a type error.
 */
export function memberHeaders(credential: { token: string; projectId: string }, protocol: number = MEMBER_PROTOCOL): Record<string, string> {
  return { ...credentialHeaders(credential.token, protocol), [PROJECT_HEADER]: credential.projectId };
}

/**
 * The headers a Deployment-scoped request carries: no Project header, because
 * the route names no Project. Stated as its own function so the absence is a
 * choice at the call site rather than an argument someone left out.
 */
export function deploymentScopedHeaders(credential: { token: string }, protocol: number = MEMBER_PROTOCOL): Record<string, string> {
  return credentialHeaders(credential.token, protocol);
}

/**
 * Every stable `code` a server answer can carry: the worker's refusal
 * classifiers plus the 503 `unavailable` code. The member classifies on these
 * and never on `reason` text.
 */
export const MEMBER_CODES = [
  'refused', 'parse', 'quota', 'body_cap', 'blob_cap', 'content_length', 'media_type', 'digest_mismatch', 'empty_body',
  'blob_absent', 'no_project', 'offset_gap', 'offset_overlap', 'identity_mismatch', 'no_machine_identity', 'blob_length_mismatch',
  'unknown_kind', 'unknown_field', 'id_grammar', 'clock_skew', 'event_id_conflict', 'projection_conflict',
  'refresh_too_early', 'lineage_expired',
  'enrollment_unknown', 'enrollment_used', 'enrollment_expired', 'enrollment_revoked', 'identity_claimed',
  'enrollment_no_project',
  'project_archived',
  'run_scope', 'no_run', 'project_mismatch',
  // #1147 — transcript-first ingest
  'session_tombstoned', 'transcript_replaced',
  // #1151 — worker mode
  'not_admin',
  // #1148 — bounded import
  'import_disabled',
  'unavailable',
] as const;
export type MemberCode = (typeof MEMBER_CODES)[number];

/** Codes that re-slice a transcript from the server's held size instead of refusing. */
export const RESLICE_CODES: readonly MemberCode[] = ['offset_gap', 'offset_overlap'];
/** The code that parks the spool: the token is at its write quota. */
export const PARKED_CODE: MemberCode = 'quota';

/** Fixed namespace for every UUIDv5 the member derives (subagent ids, plan keys, queued-prompt ids). */
export const MEMBER_ID_NAMESPACE = '6f0b1f8e-2c3a-4d5e-9a7b-8c1d2e3f4a5b';

/** Text at or under this many UTF-8 bytes travels inline; above it travels as a blob. Under the server payload cap. */
export const MEMBER_INLINE_TEXT_MAX_BYTES = 196_608;
/** A transcript is shipped in segments of at most this many bytes. Under the server blob cap. */
export const TRANSCRIPT_SLICE_BYTES = 8 * 1024 * 1024;
/**
 * Bytes of a transcript the head digest covers (#1148).
 *
 * A FIXED prefix, never the whole file: a digest over "what is there so far"
 * changes every time the file grows, and the Deployment would read ordinary
 * appending as the file having been replaced. A transcript shorter than this
 * therefore has no head digest yet, and the integrity gate stays inert for it
 * until it reaches this length — the same inertness the gate already has for a
 * transcript whose member never sent the field.
 */
export const TRANSCRIPT_HEAD_HASH_BYTES = 4096;

/**
 * What may be presented as a project id.
 *
 * This must be EXACTLY what the server admits, not a superset. The Project now
 * travels in a header on every request, and `myco member join` records it without
 * the server ever seeing it — its only server contact is a body-less health check.
 * A member that admits an id the server refuses therefore prints "joined" and is
 * then refused every request afterwards, which the spool reads as terminal: the
 * events are dropped and the credential's rotation is marked terminal too.
 *
 * `tests/member/protocol-pins.test.ts` holds this against the server's own export.
 */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Project ids the grammar admits but the server refuses; `.` and `..` are path, not names. */
export const RESERVED_PROJECT_IDS: readonly string[] = ['.', '..'];

/** Whether `value` may be a project id: in grammar and not reserved. */
export const isProjectId = (value: string): boolean => PROJECT_ID_PATTERN.test(value) && !RESERVED_PROJECT_IDS.includes(value);

/** Shape of every member token the server mints (32 random bytes as unpadded base64url). */
export const MEMBER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The path a join link carries, and the shape of the invitation key in its
 * fragment. Both must match what the Deployment mints — a member that admitted a
 * shape the server refuses would spend a person's invitation on a request no
 * Deployment can answer — so `tests/member/protocol-pins.test.ts` holds each
 * against the worker's own export.
 */
export const JOIN_PATH = '/join';
export const ENROLLMENT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The one variable a sandbox needs: a join link, carrying the Deployment and its invitation together. */
export const ENV_JOIN_CODE = 'MYCO_JOIN_CODE';
/** The tail of a token's life in which the server admits a refresh (the last quarter of the 7-day TTL); the member reads it only until the server announces a `refreshAfter`. */
export const MEMBER_TOKEN_REFRESH_WINDOW_MS = (7 * 24 * 60 * 60 * 1000) / 4;
/** How often the `route_missing` refresh diagnostic repeats on stderr. */
export const ROUTE_MISSING_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Milliseconds a hook keeps back from its declared harness timeout. */
export const HOOK_BUDGET_MARGIN_MS = 1_000;
/** Ceiling on the per-request connect timeout. */
export const CONNECT_TIMEOUT_CAP_MS = 2_000;
/** The timeout assumed for a harness event whose template declares none. */
export const MEMBER_DEFAULT_HOOK_TIMEOUT_MS = 5_000;
/** Per-request timeout when no harness budget applies (`myco member drain`). */
export const UNBOUNDED_REQUEST_TIMEOUT_MS = 60_000;
/** The most transcript work SessionEnd does inside its budget. */
export const SESSION_END_TRANSCRIPT_BUDGET_MS = 4_000;
/** Harness events the member registers; PreToolUse is never among them. */
export const NEVER_DRAINS_HOOK = 'pre-tool-use';

/** Where a hook's credential comes from. Declared by the emitted hook command, never inferred from the environment. */
export type CredentialSource = 'registry' | 'env';
export const CREDENTIAL_SOURCES: readonly CredentialSource[] = ['registry', 'env'];
/** The flag every emitted member hook command carries. */
export const CREDENTIAL_FLAG = '--credential';
/** The hook name in a rendered hook command (`… hook session-start --symbiont x`). */
export const HOOK_COMMAND_PATTERN = /\bhook\s+([a-z][a-z-]*)/;
/** The myco hook a rendered command runs, or null when it runs none. */
export function hookNameInCommand(command: string): string | null {
  return HOOK_COMMAND_PATTERN.exec(command)?.[1] ?? null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** An un-acked spool file older than this is quarantined, never deleted. */
export const MEMBER_SPOOL_QUARANTINE_MS = 30 * MS_PER_DAY;
/** A quarantined spool file older than this is pruned. */
export const MEMBER_SPOOL_QUARANTINE_PRUNE_MS = 60 * MS_PER_DAY;
/**
 * A fully delivered session's state file untouched for this long is pruned
 * after a drain that delivered everything. The state holds the transcript
 * pointer and the served-block receipts of a session nothing has written to
 * in weeks; a session that does resume past it re-ships from the offset the
 * Deployment reports and is served its block once more.
 */
export const MEMBER_SESSION_STATE_RETENTION_MS = 14 * MS_PER_DAY;
/**
 * A plugin-written transcript older than this is deleted.
 *
 * These are the only transcripts the member owns: a harness writes and ages
 * its own, and a store a manifest declares `retention: harness` is never
 * touched here. The window bounds how far back an import can reach for the
 * agents whose store Myco writes.
 */
export const MEMBER_TRANSCRIPT_RETENTION_MS = 30 * MS_PER_DAY;
/** Ceiling on the per-project refusal diagnostic log. */
export const REFUSED_LOG_MAX_BYTES = 1024 * 1024;

/** Offline latch backoff: first probe delay, doubling up to the ceiling. */
export const OFFLINE_BACKOFF_INITIAL_MS = 30_000;
export const OFFLINE_BACKOFF_MAX_MS = 10 * 60 * 1000;

/** Modes for everything the member writes under `<MYCO_HOME>/member/`. */
export const MEMBER_DIR_MODE = 0o700;
export const MEMBER_FILE_MODE = 0o600;
