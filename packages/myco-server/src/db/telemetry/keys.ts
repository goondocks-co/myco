import type { RelationalStore } from '../../core/adapters.js';
import { first, read, rows, write } from '../index.js';
import {
  TELEMETRY_KEY_LIMIT,
  TELEMETRY_REQUESTS_PER_KEY,
  TELEMETRY_RATE_WINDOW_MS,
} from '../../core/telemetry-policy.js';

export interface TelemetryKeyRow {
  id: string;
  label: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  spans: number;
  cleanup_done: number;
}
const list = read<[], TelemetryKeyRow>({
  name: 'telemetryKeys.list',
  sql: 'SELECT id,label,created_by,created_at,last_used_at,revoked_at,spans,cleanup_done FROM telemetry_keys ORDER BY created_at DESC,id',
});
const issue = write<
  [id: string, hash: string, label: string, actor: string, now: number, limit: number],
  { id: string }
>({
  name: 'telemetryKeys.issue',
  sql: `INSERT INTO telemetry_keys(id,key_hash,label,created_by,created_at)
    SELECT ?1,?2,?3,?4,?5 WHERE (SELECT COUNT(*) FROM telemetry_keys)<?6 RETURNING id`,
});
const authenticate = read<[hash: string], { id: string }>({
  name: 'telemetryKeys.authenticate',
  sql: 'SELECT id FROM telemetry_keys WHERE key_hash=?1 AND revoked_at IS NULL',
});
const revoke = write<[id: string, actor: string, now: number], { id: string }>({
  name: 'telemetryKeys.revoke',
  sql: 'UPDATE telemetry_keys SET revoked_at=?3,revoked_by=?2 WHERE id=?1 AND revoked_at IS NULL RETURNING id',
});
const forget = write<[id: string], { id: string }>({
  name: 'telemetryKeys.forget',
  sql: 'DELETE FROM telemetry_keys WHERE id=?1 AND revoked_at IS NOT NULL AND cleanup_done=1 RETURNING id',
});

export const telemetryKeys = (db: RelationalStore) => rows(db, list.bind());
export const telemetryKeyForHash = (db: RelationalStore, hash: string) => first(db, authenticate.bind(hash));
export async function insertTelemetryKey(
  db: RelationalStore,
  key: { id: string; hash: string; label: string; actor: string; now: number },
): Promise<boolean> {
  return (await first(db, issue.bind(key.id, key.hash, key.label, key.actor, key.now, TELEMETRY_KEY_LIMIT))) !== null;
}
/** Ending authority changes only its key row; housekeeping owns bounded cleanup. */
export async function revokeTelemetryKey(
  db: RelationalStore,
  key: { id: string; actor: string; now: number },
): Promise<boolean> {
  return (await first(db, revoke.bind(key.id, key.actor, key.now))) !== null;
}
export async function forgetTelemetryKey(db: RelationalStore, id: string): Promise<boolean> {
  return (await first(db, forget.bind(id))) !== null;
}
const admit = write<[id: string, window: number, limit: number], { id: string }>({
  name: 'telemetryKeys.admit',
  sql: `UPDATE telemetry_keys SET requests=CASE WHEN rate_window=?2 THEN requests+1 ELSE 1 END,rate_window=?2
    WHERE id=?1 AND revoked_at IS NULL AND (rate_window<>?2 OR requests<?3) RETURNING id`,
});
export const admitTelemetryRequest = async (db: RelationalStore, id: string, now: number): Promise<boolean> =>
  (await first(db, admit.bind(id, Math.floor(now / TELEMETRY_RATE_WINDOW_MS), TELEMETRY_REQUESTS_PER_KEY))) !== null;
