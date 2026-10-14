import type { RelationalStore } from '../core/adapters.js';
import { LEGACY_IMPORT_ADAPTER } from '@goondocks/myco-shared/member-protocol';

/** Exact source event identities bound the read through the Project/event primary key. */
export const LEGACY_HISTORY_SQL = `SELECT e.event_id FROM events e
  WHERE e.project_id = ? AND e.event_id IN (SELECT value FROM json_each(?))
    AND e.kind = 'session.end' AND e.channel = 'import' AND e.producer_adapter = ?
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = e.project_id
      AND s.session_id = e.session_id AND s.machine_id = ?)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = e.project_id)`;

export async function importedLegacyHistory(db: RelationalStore, projectId: string, machineId: string, eventIds: readonly string[]): Promise<Set<string>> {
  const { results } = await db.prepare(LEGACY_HISTORY_SQL).bind(projectId, JSON.stringify(eventIds), LEGACY_IMPORT_ADAPTER, machineId).all<{ event_id: string }>();
  return new Set(results.map(row => row.event_id));
}
