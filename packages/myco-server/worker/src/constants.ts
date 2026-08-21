export const SERVER_SCHEMA_VERSION = 3;
export const SERVER_PROTOCOL = 1;
export const MIN_COMPAT_MEMBER_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-myco-protocol';
export const MEMBER_TOKEN_BYTE_QUOTA = 1_073_741_824;
export const MAX_BLOB_BYTES = 26_214_400;
/** How long an in-flight blob reservation counts against a token's quota. A request that dies between reserving and recording its row leaves a row behind; it stops counting when it expires, so an abandoned reservation heals itself. */
export const BLOB_RESERVATION_TTL_MS = 900_000;
export const MAX_CLOCK_SKEW_MS = 300_000;
export const RETRY_AFTER_SECONDS = 60;
export const HSTS_MAX_AGE_SECONDS = 31_536_000;
export const TOKEN_ID_PREFIX = 'mt_';
export const TOKEN_ID_BYTES = 12;
