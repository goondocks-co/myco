import type { RelationalStore } from '../../core/adapters.js';
import { first, read, rows, write } from '../index.js';
import { TELEMETRY_KEY_LIMIT, TELEMETRY_SPAN_LIMIT } from '../../core/telemetry-policy.js';

export interface TelemetryKeyRow {
  id: string;
  label: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  spans: number;
  quota: number;
  clock_skew_ms: number | null;
  cleanup_done: number;
}
const list = read<[], TelemetryKeyRow>({
  name: 'telemetryKeys.list',
  sql: `SELECT id,label,created_by,created_at,last_used_at,revoked_at,spans,cleanup_done,clock_skew_ms,CAST(${TELEMETRY_SPAN_LIMIT}/MAX(1,(SELECT COUNT(*) FROM telemetry_keys WHERE revoked_at IS NULL)) AS INTEGER) AS quota FROM telemetry_keys ORDER BY created_at DESC,id`,
});
const issue = write<
  [id: string, hash: string, label: string, actor: string, now: number, limit: number],
  { id: string }
>({
  name: 'telemetryKeys.issue',
  sql: `INSERT INTO telemetry_keys(id,key_hash,label,created_by,created_at)
    SELECT ?1,?2,?3,?4,?5 WHERE (SELECT COUNT(*) FROM telemetry_keys WHERE revoked_at IS NULL)<?6 RETURNING id`,
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
  return (
    (await first(db, issue.bind(key.id, key.hash, key.label, key.actor, key.now, TELEMETRY_KEY_LIMIT))) !==
    null
  );
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
