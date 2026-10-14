import type { RelationalStore } from '../core/adapters.js';
import { LEGACY_IMPORT_ADAPTER } from '@goondocks/myco-shared/member-protocol';

/** Exact source event identities bound the read through the Project/event primary key. */
const legacyEventSQL = (lifecycle: boolean) => `SELECT e.event_id FROM events e
  WHERE e.project_id = ? AND e.event_id IN (SELECT value FROM json_each(?))
    AND e.kind ${lifecycle ? "= 'session.end'" : "IN ('session.end', 'prompt', 'response', 'plan')"} AND e.channel = 'import' AND e.producer_adapter = ?
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = e.project_id
      AND s.session_id = e.session_id AND s.machine_id = ?
      ${lifecycle ? `AND (json_type(e.payload, '$.endedAt') IS NOT NULL OR EXISTS
        (SELECT 1 FROM events f WHERE f.project_id = s.project_id AND f.event_id = s.facts_event_id AND f.channel <> 'import'))` : ''})
    AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = e.project_id)`;
export const LEGACY_HISTORY_SQL = legacyEventSQL(true);
export const LEGACY_RECORDS_SQL = legacyEventSQL(false);

export async function importedLegacyHistory(db: RelationalStore, projectId: string, machineId: string, eventIds: readonly string[], lifecycle = true): Promise<Set<string>> {
  const { results } = await db.prepare(lifecycle ? LEGACY_HISTORY_SQL : LEGACY_RECORDS_SQL).bind(projectId, JSON.stringify(eventIds), LEGACY_IMPORT_ADAPTER, machineId).all<{ event_id: string }>();
  return new Set(results.map(row => row.event_id));
}

/** Spore and lineage rows retain member authorship, and machine identity when attached to a session. */
export const LEGACY_SPORES_SQL = `SELECT r.id FROM spores r INDEXED BY sqlite_autoindex_spores_1
  WHERE r.project_id = ? AND r.id IN (SELECT value FROM json_each(?)) AND r.author = ?
    AND (r.session_id IS NULL OR EXISTS (SELECT 1 FROM sessions s
      WHERE s.project_id = r.project_id AND s.session_id = r.session_id AND s.machine_id = ?))`;
export const LEGACY_LINEAGE_SQL = LEGACY_SPORES_SQL.replaceAll('spores', 'resolution_events');

export async function importedLegacyRows(db: RelationalStore, projectId: string, memberId: string, machineId: string, sporeIds: readonly string[], lineageIds: readonly string[]) {
  const results = await Promise.all([
    db.prepare(LEGACY_SPORES_SQL).bind(projectId, JSON.stringify(sporeIds), memberId, machineId).all<{ id: string }>(),
    db.prepare(LEGACY_LINEAGE_SQL).bind(projectId, JSON.stringify(lineageIds), memberId, machineId).all<{ id: string }>(),
  ]);
  return { sporeIds: new Set(results[0].results.map(row => row.id)), lineageIds: new Set(results[1].results.map(row => row.id)) };
}
