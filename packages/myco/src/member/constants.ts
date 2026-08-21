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
 * Every stable `code` a server answer can carry: the worker's refusal
 * classifiers plus the 503 `unavailable` code. The member classifies on these
 * and never on `reason` text.
 */
export const MEMBER_CODES = [
  'refused', 'parse', 'quota', 'body_cap', 'blob_cap', 'content_length', 'media_type', 'digest_mismatch', 'empty_body',
  'blob_absent', 'offset_gap', 'offset_overlap', 'identity_mismatch', 'no_machine_identity', 'blob_length_mismatch',
  'unknown_kind', 'unknown_field', 'id_grammar', 'clock_skew', 'event_id_conflict', 'projection_conflict',
  'refresh_too_early', 'lineage_expired',
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

/** Milliseconds a hook keeps back from its declared harness timeout. */
export const HOOK_BUDGET_MARGIN_MS = 1_000;
/** Ceiling on the per-request connect timeout. */
export const CONNECT_TIMEOUT_CAP_MS = 2_000;
/** The most transcript work SessionEnd does inside its budget. */
export const SESSION_END_TRANSCRIPT_BUDGET_MS = 4_000;
/** Harness events the member registers; PreToolUse is never among them. */
export const NEVER_DRAINS_HOOK = 'pre-tool-use';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** An un-acked spool file older than this is quarantined, never deleted. */
export const MEMBER_SPOOL_QUARANTINE_MS = 30 * MS_PER_DAY;
/** A quarantined spool file older than this is pruned. */
export const MEMBER_SPOOL_QUARANTINE_PRUNE_MS = 60 * MS_PER_DAY;
/** Ceiling on the per-project refusal diagnostic log. */
export const REFUSED_LOG_MAX_BYTES = 1024 * 1024;

/** Offline latch backoff: first probe delay, doubling up to the ceiling. */
export const OFFLINE_BACKOFF_INITIAL_MS = 30_000;
export const OFFLINE_BACKOFF_MAX_MS = 10 * 60 * 1000;

/** Modes for everything the member writes under `<MYCO_HOME>/member/`. */
export const MEMBER_DIR_MODE = 0o700;
export const MEMBER_FILE_MODE = 0o600;
