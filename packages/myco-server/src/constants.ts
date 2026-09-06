export const SERVER_SCHEMA_VERSION = 21;

/** Titling: how many of a session's earliest user prompts (with their first response) reach the model. */
export const MAX_MATERIAL_PROMPTS = 12;
/** Titling: the material's total character budget. */
export const MAX_MATERIAL_CHARS = 8_000;
/** Titling: each prompt or response excerpt is cut to this many characters. */
export const MATERIAL_EXCERPT_CHARS = 600;
export const SERVER_PROTOCOL = 1;
export const MIN_COMPAT_MEMBER_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-myco-protocol';
/** The Project a member request acts on. A credential is Deployment-wide, so the Project travels per request. It rides a header rather than the envelope: an envelope field is a protocol bump, and a member whose spool holds records of the older protocol stops draining them entirely. */
export const PROJECT_HEADER = 'x-myco-project';
/**
 * The most Projects one Deployment holds.
 *
 * A member resolves Projects by naming them, so this is the only bound on rows in
 * `projects`: the byte quota is per credential and counts bytes, not rows, and a
 * credential cycling the Project header through fresh names stays inside it while
 * filling the table. Set well above what any real Deployment reaches, so it is a
 * backstop against a runaway or hostile runtime rather than a working limit.
 */
export const MAX_PROJECTS = 1_000;

/**
 * The bytes one credential may write, across the whole Deployment: 1 GiB.
 *
 * The ceiling is per CREDENTIAL, and a credential spans the Deployment: a machine
 * active in three Projects holds one credential and 1 GiB in total, not one per
 * Project. The reservation half of the count is scoped the same way (`heldBytes`
 * keys on the credential alone) — a reservation summed per Project against a
 * charge counted Deployment-wide would understate what a credential holds, and
 * `withinQuota` adds the two together.
 */
export const MEMBER_TOKEN_BYTE_QUOTA = 1_073_741_824;
export const MAX_BLOB_BYTES = 26_214_400;
/** How long an in-flight blob reservation counts against a token's quota. A request that dies between reserving and recording its row leaves a row behind; it stops counting when it expires, so an abandoned reservation heals itself. */
export const BLOB_RESERVATION_TTL_MS = 900_000;
export const MAX_CLOCK_SKEW_MS = 300_000;
export const RETRY_AFTER_SECONDS = 60;
export const MINUTE_MS = 60_000;
export const HSTS_MAX_AGE_SECONDS = 31_536_000;
export const TOKEN_ID_PREFIX = 'mt_';

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
