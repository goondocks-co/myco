import type { RelationalStore } from '../../core/adapters.js';
import { jsonPages } from '../json-pages.js';
import { read, readSet } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';

const NOT_TOMBSTONED = 'NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = ?1 AND t.session_id = ?2)';

type Session = [project: string, session: string];
type SessionNamed = [project: string, session: string, name: string];
type Held = { present: number };

const projectHeld = read<[project: string], Held>({ name: 'sessionReads.projectExists', sql: 'SELECT 1 AS present FROM projects WHERE project_id = ?1' });
const projectsNamed = read<[projects: string], { project_id: string }>({ name: 'sessionReads.existingProjects', sql:
  'SELECT project_id FROM projects WHERE project_id IN (SELECT value FROM json_each(?1))' });
const inScope = read<Session, Held>({ name: 'sessionReads.inScope', sql: `SELECT 1 AS present FROM sessions WHERE project_id = ?1 AND session_id = ?2 AND ${NOT_TOMBSTONED}` });
const heldByMachine = read<SessionNamed, Held>({ name: 'sessionReads.heldByMachine', sql:
  `SELECT 1 AS present FROM sessions WHERE project_id = ?1 AND session_id = ?2 AND machine_id = ?3 AND ${NOT_TOMBSTONED}` });
const titled = read<Session, Held>({ name: 'sessionReads.carriesTitle', sql: 'SELECT 1 AS present FROM sessions WHERE project_id = ?1 AND session_id = ?2 AND title IS NOT NULL' });
const heldIds = read<[project: string, sessions: string], { session_id: string }>({ name: 'sessionReads.heldIds', sql:
  'SELECT session_id FROM sessions WHERE project_id = ?1 AND session_id IN (SELECT value FROM json_each(?2))' });
const importerOwned = read<[project: string, sessions: string, producer: string], { session_id: string }>({ name: 'sessionReads.ownedByImporter', sql:
  `SELECT s.session_id FROM sessions s JOIN events e ON e.project_id = s.project_id AND e.event_id = s.facts_event_id
       WHERE s.project_id = ?1 AND s.session_id IN (SELECT value FROM json_each(?2)) AND e.channel = 'import' AND e.producer_adapter = ?3
         AND NOT EXISTS (SELECT 1 FROM events live WHERE live.project_id = s.project_id AND live.session_id = s.session_id
           AND live.channel <> 'import' AND live.kind IN ('session.start', 'session.end', 'transcript.segment'))` });
const importedPrompts = read<[sessions: string, project: string, producer: string], { session_id: string }>({ name: 'sessionReads.withImportedPrompts', sql:
  `SELECT offered.value AS session_id FROM json_each(?1) offered
  WHERE EXISTS (SELECT 1 FROM events e WHERE e.project_id = ?2 AND e.session_id = offered.value
    AND e.kind = 'prompt' AND e.channel = 'import' AND e.producer_adapter = ?3)` });

export interface DurationRow {
  agent: string | null; started_at: number | null; ended_at: number | null; ended_by: string | null;
  occurred_started_at: number | null; occurred_ended_at: number | null; first_received_at: number; last_received_at: number;
}
const duration = read<Session, DurationRow>({ name: 'sessionReads.duration', sql:
  `SELECT agent, started_at, ended_at, ended_by, occurred_started_at, occurred_ended_at,
    first_received_at, last_received_at FROM sessions WHERE project_id = ?1 AND session_id = ?2` });

export interface LifecycleRow { machine_id: string | null; created_by_token_id: string; started_at: number | null; ended_at: number | null; first_received_at: number }
const lifecycle = read<Session, LifecycleRow>({ name: 'sessionReads.lifecycle', sql:
  `SELECT s.machine_id, s.created_by_token_id, s.started_at, s.ended_at, s.first_received_at
                FROM sessions s WHERE s.project_id = ?1 AND s.session_id = ?2 AND ${notTombstonedSql('s')}` });

export interface DocumentCountsRow { session_id: string; prompts: number; tool_calls: number; replies: number; plans: number }
const documentCounts = read<[project: string, sessions: string], DocumentCountsRow>({ name: 'sessionReads.documentCounts', sql:
  `SELECT d.session_id, d.prompts, d.tool_calls, d.replies, d.plans
    FROM session_documents d WHERE d.project_id = ?1 AND d.session_id IN (SELECT value FROM json_each(?2)) AND d.state = 'live'` });

export interface SessionCountsRow { prompts: number; toolCalls: number; responses: number; plans: number; attachments: number }
const counts = read<Session, SessionCountsRow>({ name: 'sessionReads.counts', sql:
  `SELECT d.prompts, d.tool_calls toolCalls, d.replies responses, d.plans,
      (SELECT COUNT(*) FROM attachments a WHERE a.project_id=d.project_id AND a.session_id=d.session_id) attachments
    FROM session_documents d WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live'
      AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)` });

export interface ProjectListRow { project_id: string; name: string; created_at: number; archived_at: number | null; archived_by: string | null; session_count: number; last_activity_at: number | null }
const PROJECT_LIST = (where: string) => `SELECT p.project_id, p.name, p.created_at, p.archived_at, p.archived_by,
    COALESCE(c.session_count, 0) AS session_count,
    (SELECT f.last_received_at FROM session_read_facts f
      WHERE f.project_id = p.project_id AND f.has_session = 1 AND f.tombstoned = 0
      ORDER BY f.last_received_at DESC LIMIT 1) AS last_activity_at
    FROM projects p LEFT JOIN project_session_counts c ON c.project_id = p.project_id
    ${where}
    ORDER BY last_activity_at DESC NULLS LAST, p.created_at DESC`;
const projectsAccepting = read<[], ProjectListRow>({ name: 'sessionReads.projectsAccepting', sql: PROJECT_LIST('WHERE p.archived_at IS NULL') });
const projectsEvery = read<[], ProjectListRow>({ name: 'sessionReads.projectsEvery', sql: PROJECT_LIST('') });

/** Every project with its live session count and latest live receipt, most recently active first; archived ones only when asked. */
export async function projectListRows(db: RelationalStore, includeArchived: boolean): Promise<ProjectListRow[]> {
  const [rows] = await readSet(db, (includeArchived ? projectsEvery : projectsAccepting).bind());
  return rows;
}

/** True when the project exists. */
export async function projectExists(db: RelationalStore, project: string): Promise<boolean> {
  const [rows] = await readSet(db, projectHeld.bind(project));
  return rows.length > 0;
}

/** Which of these project ids name a project. */
export async function existingProjectIds(db: RelationalStore, projectIds: readonly string[]): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const [rows] = await readSet(db, projectsNamed.bind(JSON.stringify(projectIds)));
  return rows.map(row => row.project_id);
}

/** True when the Project holds a live session of this id. */
export async function sessionInProject(db: RelationalStore, project: string, session: string): Promise<boolean> {
  const [rows] = await readSet(db, inScope.bind(project, session));
  return rows.length > 0;
}

/** True when the Project holds a live session of this id that the machine captured. */
export async function sessionOnMachine(db: RelationalStore, project: string, session: string, machine: string): Promise<boolean> {
  const [rows] = await readSet(db, heldByMachine.bind(project, session, machine));
  return rows.length > 0;
}

/** True when the Project's session carries a title. */
export async function sessionHasTitle(db: RelationalStore, project: string, session: string): Promise<boolean> {
  const [rows] = await readSet(db, titled.bind(project, session));
  return rows.length > 0;
}

/** The ids among `sessionIds` the Project holds a row for, whatever their state. */
export async function heldSessionRows(db: RelationalStore, project: string, sessionIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const page of jsonPages(sessionIds)) {
    const [rows] = await readSet(db, heldIds.bind(project, JSON.stringify(page)));
    out.push(...rows.map(row => row.session_id));
  }
  return out;
}

/** The ids among `sessionIds` whose original facts a named importer recorded and no live capture has touched. */
export async function importerOwnedSessions(db: RelationalStore, project: string, sessionIds: readonly string[], producer: string): Promise<string[]> {
  const out: string[] = [];
  for (const page of jsonPages(sessionIds)) {
    const [rows] = await readSet(db, importerOwned.bind(project, JSON.stringify(page), producer));
    out.push(...rows.map(row => row.session_id));
  }
  return out;
}

/** The ids among `sessionIds` that hold a prompt `producer` sent on the import channel. */
export async function sessionsHoldingImportedPrompts(db: RelationalStore, project: string, sessionIds: readonly string[], producer: string): Promise<string[]> {
  const out: string[] = [];
  for (const page of jsonPages(sessionIds)) {
    const [rows] = await readSet(db, importedPrompts.bind(JSON.stringify(page), project, producer));
    out.push(...rows.map(row => row.session_id));
  }
  return out;
}

/** The lifecycle facts a duration is judged from, or null when the Project holds no such session. */
export async function sessionDurationRow(db: RelationalStore, project: string, session: string): Promise<DurationRow | null> {
  const [[row]] = await readSet(db, duration.bind(project, session));
  return row ?? null;
}

/** A live session's lifecycle columns, or null. */
export async function sessionLifecycleRow(db: RelationalStore, project: string, session: string): Promise<LifecycleRow | null> {
  const [[row]] = await readSet(db, lifecycle.bind(project, session));
  return row ?? null;
}

/** The catalog counters of the named sessions' live documents, one read per page of ids; a session with no live document has no row. */
export async function documentCountRows(db: RelationalStore, requests: readonly { project: string; sessions: readonly string[] }[]): Promise<DocumentCountsRow[][]> {
  const reads = requests.flatMap(({ project, sessions }) => jsonPages(sessions).map(page => documentCounts.bind(project, JSON.stringify(page))));
  const results = await readSet(db, ...reads);
  let at = 0;
  return requests.map(({ sessions }) => results.slice(at, at += jsonPages(sessions).length).flat());
}

/** A session's counters and attachment count, or null while it has no live, undeleted document. */
export async function sessionCountsRow(db: RelationalStore, project: string, session: string): Promise<SessionCountsRow | null> {
  const [[row]] = await readSet(db, counts.bind(project, session));
  return row ?? null;
}
