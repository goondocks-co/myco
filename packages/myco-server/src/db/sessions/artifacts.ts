/** Session artifact rows: the one report writer's insert, the stored row it answers, and restore's insert per carried column set. */
import type { RelationalStore } from '../../core/adapters.js';
import type { SessionArtifactRow } from '../../core/session-artifacts.js';
import { first, read, rows, write, type BindValue, type Bound } from '../index.js';
import { restoredColumnStatements, restoredValues } from '../recovery/restored-columns.js';

export const ARTIFACT_COLUMNS = `id, session_id AS sessionId, kind, artifact_id AS artifactId, url, author, reported_at AS reportedAt`;

/** The session is held and not deleted: slots `project` and `session` name it. */
const sessionLive = (project: string, session: string) => `EXISTS (SELECT 1 FROM sessions WHERE project_id = ${project} AND session_id = ${session})
  AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = ${project} AND t.session_id = ${session})`;

type ReportValues = [project: string, id: string, session: string, kind: string, artifactId: string, url: string, author: string, reportedAt: number];
const report = write<ReportValues, SessionArtifactRow>({ name: 'sessions.reportArtifact', sql:
  `INSERT INTO session_artifacts (project_id, id, session_id, kind, artifact_id, url, author, reported_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
    WHERE ${sessionLive('?1', '?3')}
    ON CONFLICT (project_id, session_id, kind, artifact_id) DO NOTHING
    RETURNING ${ARTIFACT_COLUMNS}` });
const reported = read<[project: string, session: string, kind: string, artifactId: string], SessionArtifactRow>({ name: 'sessions.reportedArtifact', sql:
  `SELECT ${ARTIFACT_COLUMNS} FROM session_artifacts WHERE project_id = ?1 AND session_id = ?2 AND kind = ?3 AND artifact_id = ?4` });
const held = read<[project: string, sessions: string], { session_id: string }>({ name: 'sessions.heldAmong', sql:
  'SELECT session_id FROM sessions WHERE project_id = ?1 AND session_id IN (SELECT value FROM json_each(?2))' });

export interface ArtifactInsert { projectId: string; id: string; sessionId: string; kind: string; artifactId: string; url: string; author: string; reportedAt: number }

/** The inserted row, or null when the session is not held or the artifact is already reported. */
export const insertReportedArtifact = (db: RelationalStore, row: ArtifactInsert): Promise<SessionArtifactRow | null> =>
  first(db, report.bind(row.projectId, row.id, row.sessionId, row.kind, row.artifactId, row.url, row.author, row.reportedAt));

export const reportedArtifact = (db: RelationalStore, projectId: string, sessionId: string, kind: string, artifactId: string): Promise<SessionArtifactRow | null> =>
  first(db, reported.bind(projectId, sessionId, kind, artifactId));

/** How many of `sessionIds` the Project holds. */
export async function heldSessionCount(db: RelationalStore, projectId: string, sessionIds: readonly string[]): Promise<number> {
  return (await rows(db, held.bind(projectId, JSON.stringify(sessionIds)))).length;
}

const restored = restoredColumnStatements<{ rowid: number }, 'write'>('sessions.restoreArtifact');

/** Restores one carried artifact row, unless the destination does not hold its session or has deleted it. */
export function restoreArtifactStatement(row: Readonly<Record<string, unknown>>): Bound<{ rowid: number }, 'write'> {
  const columns = Object.keys(row);
  const statement = restored(columns, (name, names) => write<BindValue[], { rowid: number }>({ name, sql:
    `INSERT OR IGNORE INTO session_artifacts (${names.join(', ')})
    SELECT ${names.map((_, index) => `?${index + 1}`).join(', ')}
    WHERE ${sessionLive(`?${names.length + 1}`, `?${names.length + 2}`)} RETURNING rowid` }));
  return statement.bind(...restoredValues(row, columns), (row.project_id ?? null) as BindValue, (row.session_id ?? null) as BindValue);
}
