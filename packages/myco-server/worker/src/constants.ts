export const SERVER_SCHEMA_VERSION = 5;
export const SERVER_PROTOCOL = 1;
export const MIN_COMPAT_MEMBER_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-myco-protocol';
/** The Project a member request acts on. A credential is Deployment-wide, so the Project travels per request. It rides a header rather than the envelope: an envelope field is a protocol bump, and a member whose spool holds records of the older protocol stops draining them entirely. */
export const PROJECT_HEADER = 'x-myco-project';
export const MEMBER_TOKEN_BYTE_QUOTA = 1_073_741_824;
export const MAX_BLOB_BYTES = 26_214_400;
/** How long an in-flight blob reservation counts against a token's quota. A request that dies between reserving and recording its row leaves a row behind; it stops counting when it expires, so an abandoned reservation heals itself. */
export const BLOB_RESERVATION_TTL_MS = 900_000;
export const MAX_CLOCK_SKEW_MS = 300_000;
export const RETRY_AFTER_SECONDS = 60;
export const HSTS_MAX_AGE_SECONDS = 31_536_000;
export const TOKEN_ID_PREFIX = 'mt_';

/** The prefix of a server-named member id, minted when a join enrolls a new person. */
export const MEMBER_ID_PREFIX = 'mem_';

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
