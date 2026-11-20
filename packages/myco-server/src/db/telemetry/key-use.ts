import { TELEMETRY_RATE_WINDOW_MS } from '../../core/telemetry-policy.js';

/** All last-used writes pass the same minute admission guard. */
export const telemetryKeyUseSql = (key: string, now: string): string =>
  `UPDATE telemetry_keys SET last_used_at=${now} WHERE id=${key} AND revoked_at IS NULL
 AND (last_used_at IS NULL OR last_used_at/${TELEMETRY_RATE_WINDOW_MS}<${now}/${TELEMETRY_RATE_WINDOW_MS})`;
