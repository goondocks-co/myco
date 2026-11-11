/** The session rows a `session.start` or `session.end` projects into, each written only when this request stored the event. */
import { write, type Bound } from '../index.js';
import { storedByThisRequest } from './event-write.js';

/** The request that stored the event, which every projection is gated on. */
export interface Stored { project: string; session: string; event: string; nonce: string }

/** A fact is the earliest start's, whether it carries the field or not: an event ranking earlier replaces it, a later one leaves it. */
const EARLIER = 'started_at IS NULL OR ?1 < started_at OR (?1 = started_at AND (facts_event_id IS NULL OR ?2 < facts_event_id))';
const fact = (column: string, slot: string) => `${column} = CASE WHEN ${EARLIER} THEN ${slot} ELSE ${column} END`;
const facts = write<[startedAt: number, event: string, agent: string | null, branch: string | null, originPath: string | null, parentSession: string | null,
  parentReason: string | null, launchParent: string | null, project: string, session: string, nonce: string], { applied: number }>({ name: 'capture.sessionStartFacts', sql:
  `UPDATE sessions SET ${fact('agent', '?3')}, ${fact('branch', '?4')}, ${fact('origin_path', '?5')}, ${fact('parent_session_id', '?6')},
      ${fact('parent_reason', '?7')}, ${fact('launch_parent_session_id', '?8')}, ${fact('facts_event_id', '?2')}, ${fact('started_at', '?1')}
    WHERE project_id = ?9 AND session_id = ?10 AND ${storedByThisRequest('?9', '?2', '?11')} RETURNING 1 AS applied` });

/** The facts a `session.start` carries, by the order it ranks in: client time, then the smaller event id. */
export interface StartFacts {
  startedAt: number; agent: string | null; branch: string | null; originPath: string | null; parentSessionId: string | null;
  parentReason: string | null; launchParentSessionId: string | null;
}
export const sessionStartFacts = (s: Stored, f: StartFacts): Bound<{ applied: number }> =>
  facts.bind(f.startedAt, s.event, f.agent, f.branch, f.originPath, f.parentSessionId, f.parentReason, f.launchParentSessionId, s.project, s.session, s.nonce);

const nameProject = write<[name: string, project: string, event: string, nonce: string], { applied: number }>({ name: 'capture.nameProject', sql:
  `UPDATE projects SET name = ?1 WHERE project_id = ?2 AND name = project_id AND ${storedByThisRequest('?2', '?3', '?4')} RETURNING 1 AS applied` });
/** A Project still named by its own id takes the name its first start carries; a renamed Project keeps its name. */
export const nameProjectFromStart = (s: Stored, name: string): Bound<{ applied: number }> => nameProject.bind(name, s.project, s.event, s.nonce);

/** Whether an incoming capture point replaces the held one: the earliest start or the latest end, ties to the smaller event id. */
const wins = (order: '<' | '>') => `(excluded.captured_at ${order} knowledge_git_provenance.captured_at OR
    (excluded.captured_at = knowledge_git_provenance.captured_at AND
      (knowledge_git_provenance.event_id IS NULL OR excluded.event_id < knowledge_git_provenance.event_id)))`;
type Commit = [project: string, identity: string, session: string, point: string, at: number, event: string, headSha: string, dirty: number,
  error: string | null, now: number, nonce: string];
const commit = (name: string, order: '<' | '>') => write<Commit, { applied: number }>({ name, sql:
  `INSERT INTO knowledge_git_provenance
      (project_id, identity_key, session_id, capture_point, captured_at, event_id, branch, head_sha, is_dirty, error, status_hash, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, (SELECT branch FROM sessions WHERE project_id = ?1 AND session_id = ?3), ?7, ?8, ?9, '', ?10
      WHERE ${storedByThisRequest('?1', '?6', '?11')}
    ON CONFLICT(project_id, identity_key) DO UPDATE SET head_sha = excluded.head_sha, is_dirty = excluded.is_dirty, error = excluded.error,
      captured_at = excluded.captured_at, event_id = excluded.event_id, branch = excluded.branch
      WHERE ${wins(order)} RETURNING 1 AS applied` });
const COMMITS = { session_start: commit('capture.sessionStartCommit', '<'), session_end: commit('capture.sessionEndCommit', '>') } as const;

/** The commit a session stood on at one capture point, with whether tracked files differed from it, or the error that says it could not tell. */
export interface CommitPoint { point: 'session_start' | 'session_end'; at: number; headSha: string; dirty: boolean; error: string | null; now: number }
export const sessionCommit = (s: Stored, c: CommitPoint): Bound<{ applied: number }> =>
  COMMITS[c.point].bind(s.project, `session:${s.session}:${c.point}`, s.session, c.point, c.at, s.event, c.headSha, c.dirty ? 1 : 0, c.error, c.now, s.nonce);

const title = write<[title: string, summary: string | null, now: number, project: string, session: string, event: string, nonce: string], { applied: number }>({
  name: 'capture.importedTitle', sql: `UPDATE sessions SET title = ?1, summary = ?2, titled_at = ?3
    WHERE project_id = ?4 AND session_id = ?5 AND titled_by IS NULL AND ${storedByThisRequest('?4', '?6', '?7')} RETURNING 1 AS applied` });
/** The title and summary an import end carries, stored as the session's one titling attempt unless an administrator titled it. */
export const importedTitle = (s: Stored, t: { title: string; summary: string | null; now: number }): Bound<{ applied: number }> =>
  title.bind(t.title, t.summary, t.now, s.project, s.session, s.event, s.nonce);
