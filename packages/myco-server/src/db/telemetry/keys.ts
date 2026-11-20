import type { RelationalStore } from '../../core/adapters.js';
import { commit, first, read, rows, write } from '../index.js';
import { TELEMETRY_KEY_LIMIT } from '../../core/telemetry-policy.js';

export interface TelemetryKeyRow {
  id: string; label: string; created_by: string; created_at: number; last_used_at: number | null; revoked_at: number | null;
}
const list = read<[], TelemetryKeyRow>({ name: 'telemetryKeys.list', sql:
  'SELECT id,label,created_by,created_at,last_used_at,revoked_at FROM telemetry_keys ORDER BY created_at DESC,id' });
const issue = write<[id: string, hash: string, label: string, actor: string, now: number, limit: number], { id: string }>({ name: 'telemetryKeys.issue', sql:
  `INSERT INTO telemetry_keys(id,key_hash,label,created_by,created_at)
    SELECT ?1,?2,?3,?4,?5 WHERE (SELECT COUNT(*) FROM telemetry_keys)<?6 RETURNING id` });
const authenticate = read<[hash: string], { id: string }>({ name: 'telemetryKeys.authenticate', sql:
  'SELECT id FROM telemetry_keys WHERE key_hash=?1 AND revoked_at IS NULL' });
const revoke = write<[id: string, actor: string, now: number], { id: string }>({ name: 'telemetryKeys.revoke', sql:
  'UPDATE telemetry_keys SET revoked_at=?3,revoked_by=?2 WHERE id=?1 AND revoked_at IS NULL RETURNING id' });
const purgeSpans = write<[id: string]>({ name: 'telemetryKeys.purgeSpans', sql:
  'DELETE FROM telemetry_spans WHERE key_id=?1 AND EXISTS(SELECT 1 FROM telemetry_keys WHERE id=?1 AND revoked_at IS NOT NULL)' });
const purgeLiveSpans = write<[id: string]>({ name: 'telemetryKeys.purgeLiveSpans', sql:
  'DELETE FROM telemetry_spans WHERE key_id=?1 AND EXISTS(SELECT 1 FROM telemetry_keys WHERE id=?1 AND revoked_at IS NULL)' });
const purgeCounts = write<[id: string]>({ name: 'telemetryKeys.purgeCounts', sql:
  'DELETE FROM telemetry_counts WHERE key_id=?1 AND EXISTS(SELECT 1 FROM telemetry_keys WHERE id=?1 AND revoked_at IS NOT NULL)' });
const forget = write<[id: string], { id: string }>({ name: 'telemetryKeys.forget', sql:
  'DELETE FROM telemetry_keys WHERE id=?1 AND revoked_at IS NOT NULL RETURNING id' });

export const telemetryKeys = (db: RelationalStore) => rows(db, list.bind());
export const telemetryKeyForHash = (db: RelationalStore, hash: string) => first(db, authenticate.bind(hash));
export async function insertTelemetryKey(db: RelationalStore, key: { id: string; hash: string; label: string; actor: string; now: number }): Promise<boolean> {
  return await first(db, issue.bind(key.id, key.hash, key.label, key.actor, key.now, TELEMETRY_KEY_LIMIT)) !== null;
}
/** Revocation and removal of every assertion it supplied share one transaction. */
export async function revokeTelemetryKey(db: RelationalStore, key: { id: string; actor: string; now: number }): Promise<boolean> {
  const [, ended] = await commit(db, purgeLiveSpans.bind(key.id), revoke.bind(key.id, key.actor, key.now));
  return ended.results.length > 0;
}
/** Only a revoked key's record can be removed; its state transition is the final statement. */
export async function forgetTelemetryKey(db: RelationalStore, id: string): Promise<boolean> {
  const [, , removed] = await commit(db, purgeSpans.bind(id), purgeCounts.bind(id), forget.bind(id));
  return removed.results.length > 0;
}
