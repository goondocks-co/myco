import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

/** Exact source event identities bound the read through the Project/event primary key. */
const eventProof = (lifecycle: boolean) => `SELECT e.event_id FROM events e
  WHERE e.project_id = ?1 AND e.event_id IN (SELECT value FROM json_each(?2))
    AND e.kind ${lifecycle ? "= 'session.end'" : "IN ('session.end', 'prompt', 'response', 'plan')"} AND e.channel = 'import' AND e.producer_adapter = ?3
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = e.project_id
      AND s.session_id = e.session_id AND s.machine_id = ?4
      ${lifecycle ? `AND (json_type(e.payload, '$.endedAt') IS NOT NULL OR EXISTS
        (SELECT 1 FROM events f WHERE f.project_id = s.project_id AND f.event_id = s.facts_event_id AND f.channel <> 'import'))` : ''})
    AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = e.project_id)`;

/** Spore and lineage rows retain member authorship, and machine identity when attached to a session. */
const authoredProof = (table: string) => `SELECT r.id FROM ${table} r INDEXED BY sqlite_autoindex_${table}_1
  WHERE r.project_id = ?1 AND r.id IN (SELECT value FROM json_each(?2)) AND r.author = ?3
    AND (r.session_id IS NULL OR EXISTS (SELECT 1 FROM sessions s
      WHERE s.project_id = r.project_id AND s.session_id = r.session_id AND s.machine_id = ?4))`;

type EventProof = [project: string, events: string, adapter: string, machine: string];
type AuthoredProof = [project: string, ids: string, member: string, machine: string];
const lifecycleEvents = read<EventProof, { event_id: string }>({ name: 'legacyImport.lifecycleEvents', sql: eventProof(true) });
const recordEvents = read<EventProof, { event_id: string }>({ name: 'legacyImport.recordEvents', sql: eventProof(false) });
const spores = read<AuthoredProof, { id: string }>({ name: 'legacyImport.spores', sql: authoredProof('spores') });
const lineage = read<AuthoredProof, { id: string }>({ name: 'legacyImport.lineage', sql: authoredProof('resolution_events') });
const destination = read<[project: string], { archived_at: number | null }>({ name: 'legacyImport.destination', sql: 'SELECT archived_at FROM projects WHERE project_id = ?1' });

/** The source events, of lifecycle completions or of every record kind, that the Project holds as imported on `machine`. */
export async function importedEvents(db: RelationalStore, request: { project: string; machine: string; adapter: string; eventIds: readonly string[]; lifecycle: boolean }): Promise<string[]> {
  const { project, machine, adapter, eventIds, lifecycle } = request;
  const [rows] = await readSet(db, (lifecycle ? lifecycleEvents : recordEvents).bind(project, JSON.stringify(eventIds), adapter, machine));
  return rows.map(row => row.event_id);
}

/** The spore and lineage ids the member authored in the Project, on `machine` when attached to a session. */
export async function importedAuthoredRows(db: RelationalStore, request: { project: string; member: string; machine: string; sporeIds: readonly string[]; lineageIds: readonly string[] }):
  Promise<{ sporeIds: string[]; lineageIds: string[] }> {
  const { project, member, machine } = request;
  const [heldSpores, heldLineage] = await readSet(db,
    spores.bind(project, JSON.stringify(request.sporeIds), member, machine), lineage.bind(project, JSON.stringify(request.lineageIds), member, machine));
  return { sporeIds: heldSpores.map(row => row.id), lineageIds: heldLineage.map(row => row.id) };
}

/** The Project's `archived_at`, or `undefined` when it does not exist. */
export async function destinationArchivedAt(db: RelationalStore, project: string): Promise<number | null | undefined> {
  const [rows] = await readSet(db, destination.bind(project));
  return rows[0]?.archived_at;
}
