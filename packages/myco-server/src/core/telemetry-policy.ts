/** OTLP JSON admission and retention bounds, shared by both front doors. */
export const TELEMETRY_KEY_PREFIX = 'mycootel_';
export const TELEMETRY_KEY_BYTES = 32;
export const TELEMETRY_KEY_ID_BYTES = 12;
export const TELEMETRY_KEY_PATTERN = new RegExp(`^${TELEMETRY_KEY_PREFIX}[A-Za-z0-9_-]{${Math.ceil(TELEMETRY_KEY_BYTES * 4 / 3)}}$`);
export const TELEMETRY_BATCH_BYTES = 1_500_000;
export const TELEMETRY_RESOLUTION_PAGE = 64;
export const TELEMETRY_BODY_BYTES = 10 * 1024 * 1024;
export const TELEMETRY_SPANS_PER_REQUEST = 256;
export const TELEMETRY_SPANS_PER_TRACE = 512;
export const TELEMETRY_SPAN_LIMIT = 50_000;
export const TELEMETRY_ATTRIBUTE_LIMIT = 128;
export const TELEMETRY_TEXT_BYTES = 1024;
export const TELEMETRY_NAME_BYTES = 256;
export const TELEMETRY_KEY_LIMIT = 64;
export const TELEMETRY_DAY_MS = 86_400_000;
export const TELEMETRY_RETENTION_MS = 30 * TELEMETRY_DAY_MS;
export const TELEMETRY_MATCH_WAIT_MS = 7 * TELEMETRY_DAY_MS;
/** Two seconds admits ordinary clock skew without assigning a whole neighbouring turn. */
export const TELEMETRY_CLOCK_TOLERANCE_MS = 2_000;
export const TELEMETRY_RECHECK_MS = 60_000;
export const TELEMETRY_TRACE_PAGE = 8;
export const TELEMETRY_ANCESTOR_LIMIT = 32;

/** Deployment-local credentials and short-lived facts stay out of portable Project exports. */
export const TELEMETRY_TABLES = ['telemetry_keys', 'telemetry_totals', 'telemetry_traces', 'telemetry_spans', 'telemetry_resolutions', 'telemetry_counts'] as const;
