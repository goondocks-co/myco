import type { RelationalStore } from '../../core/adapters.js';
import { sessionMaterialReadySql } from '../../read/material-readiness.js';
import { containsPattern, projectsFiltering, type ProjectSet } from '../../read/scope.js';
import { composedRead } from '../browse/composed.js';
import { readSet, type BindValue } from '../index.js';
import { occurredAt, presentedEndedAt, presentedStartedAt } from '../session-dates.js';
import { notTombstonedSql } from '../session-read-model.js';

/** The opening of a session's first user prompt as its document catalog keeps it, for the label of a session with no title. */
export const firstPromptSql = (alias: string): string =>
  `(SELECT first_prompt FROM session_documents first_doc WHERE first_doc.project_id = ${alias}.project_id AND first_doc.session_id = ${alias}.session_id)`;

/** Presented conversation dates fall back to raw lifecycle dates. */
export const PRESENTED_STARTED_AT = presentedStartedAt('s.');
export const PRESENTED_ENDED_AT = presentedEndedAt('s.');

/** The instant a session is ordered by, spelled as `idx_sessions_occurred` and the Deployment-wide index spell it. */
export const SESSION_OCCURRED_AT = occurredAt('s.');

/** All joins land on primary keys, preserving the session row count. */
export const SESSION_COLUMNS = `s.session_id, s.machine_id, s.created_by_token_id, s.first_received_at, s.last_received_at,
     s.agent, s.branch, ${PRESENTED_STARTED_AT} AS started_at, ${PRESENTED_ENDED_AT} AS ended_at, s.origin_path, s.parent_session_id, s.parent_reason, s.launch_parent_session_id,
     s.title, s.summary, s.titled_at, s.ended_by, ${firstPromptSql('s')} AS first_prompt,
     c.member_id, c.runtime_kind, m.label AS member_label, e.label AS ended_by_label, s.working_since`;

/** The session read's joins, with the sessions table read through `indexedBy` where one is named. */
export function sessionFrom(indexedBy: string): string {
  return `FROM sessions s${indexedBy === '' ? '' : ` INDEXED BY ${indexedBy}`}
     LEFT JOIN member_credentials c ON c.id = s.created_by_token_id
     LEFT JOIN members m ON m.id = c.member_id
     LEFT JOIN members e ON e.id = s.ended_by`;
}

/** The Deployment-wide order every read of sessions across Projects walks: the instant, the Project, the id. */
export const SESSIONS_ACROSS_INDEX = 'idx_sessions_occurred_deployment';

/**
 * The index an activity window reads: it leads with the last receipt, so the read seeks the sessions received from
 * the window's start on, however long ago they started, and sorts that set alone.
 */
export const SESSIONS_ACTIVE_INDEX = 'idx_sessions_capture';

/** The index the sessions working now are read through: it holds the sessions with an open turn alone. */
export const SESSIONS_WORKING_INDEX = 'idx_sessions_working';

/**
 * How long a turn may stay open and still read as working. A turn ends when its end reaches the Deployment; this
 * bounds only a turn whose end never does (a crash, an interrupt no hook reports), which reads as working no longer.
 */
export const WORKING_CAP_MS = 3 * 60 * 60 * 1000;

const LIVE_SESSION = notTombstonedSql('s');

/** Every primary and sibling transcript is fully parsed at full fidelity. */
const FULL_FIDELITY = `${sessionMaterialReadySql('s')} AND NOT EXISTS (SELECT 1 FROM transcripts t
  WHERE t.project_id = s.project_id AND t.session_id = s.session_id
    AND t.fidelity IS NOT NULL AND t.fidelity <> 'full')`;

export interface SessionBrowseFilters {
  since?: number;
  until?: number;
  branch?: string;
  agent?: string;
  window?: 'start' | 'activity';
  now?: number;
  state?: 'open' | 'ended';
  memberLabel?: string;
  sessionId?: string;
  q?: string;
  fidelity?: 'full' | 'any';
}

/** The key after which a page starts: within one Project the instant and the id; across Projects the Project too. */
export interface SessionPageKey { createdAt: number; projectId?: string; id: string }

export interface SessionPageRequest {
  /** One Project, or a set of Projects read across. */
  scope: { projectId: string } | ProjectSet;
  filters: SessionBrowseFilters;
  /** Whether the page lists the sessions active in a window that opens at the filters' start instant. */
  active: boolean;
  after: SessionPageKey | null;
  limit: number;
}

/**
 * One session page as stored rows, at most `limit` + 1 of them, newest occurrence first: the Project admits the rows,
 * the filters narrow them, and the order and the key are the occurred instant and the id, with the Project between them
 * across Projects. A read across Projects walks the Deployment-wide index; an activity window reads the sessions
 * received from its start on and, judged at an instant, also the sessions working now, read apart as `working`.
 */
export async function readSessionPage(db: RelationalStore, request: SessionPageRequest):
  Promise<{ received: Record<string, unknown>[]; working: Record<string, unknown>[] }> {
  const { scope, filters, active, after, limit } = request;
  const across = !('projectId' in scope);
  const projects = across ? projectsFiltering(scope, 's') : { sql: 's.project_id = ?', params: [scope.projectId] };
  const O = SESSION_OCCURRED_AT;
  const page = async (window: 'receipt' | 'working', through: string) => {
    const conditions = [projects.sql, LIVE_SESSION];
    const params: BindValue[] = [...projects.params];
    if ((filters.fidelity ?? 'full') === 'full') conditions.push(FULL_FIDELITY);
    if (filters.branch !== undefined) { conditions.push('s.branch = ?'); params.push(filters.branch); }
    if (filters.agent !== undefined) { conditions.push('s.agent = ?'); params.push(filters.agent); }
    if (window === 'working') {
      // Working now: a turn opened within the cap, with no end recorded or one older than the turn.
      conditions.push('s.working_since IS NOT NULL', 's.working_since > ?', `(${PRESENTED_ENDED_AT} IS NULL OR ${PRESENTED_ENDED_AT} < s.working_since)`);
      params.push(filters.now! - WORKING_CAP_MS);
    } else if (active) {
      // Active in the window: a receipt at or after its start, and no end recorded before it.
      conditions.push('s.last_received_at >= ?', `(${PRESENTED_ENDED_AT} IS NULL OR ${PRESENTED_ENDED_AT} >= ?)`);
      params.push(filters.since!, filters.since!);
    } else if (filters.since !== undefined) {
      // The instant the page is ordered by, so the filter admits what the order shows.
      conditions.push(`${O} >= ?`); params.push(filters.since);
    }
    if (filters.until !== undefined) { conditions.push(`${O} < ?`); params.push(filters.until); }
    // Open and ended as the page shows them, each session under one. A session working again after its recorded end is
    // open while it works: the working read lists it as open, and a read of ended sessions judged at an instant leaves it
    // out.
    if (filters.state === 'open' && window !== 'working') conditions.push(`${PRESENTED_ENDED_AT} IS NULL`);
    if (filters.state === 'ended') {
      conditions.push(`${PRESENTED_ENDED_AT} IS NOT NULL`);
      if (filters.now !== undefined) {
        conditions.push(`NOT (s.working_since IS NOT NULL AND s.working_since > ${PRESENTED_ENDED_AT} AND s.working_since > ?)`);
        params.push(filters.now - WORKING_CAP_MS);
      }
    }
    if (filters.memberLabel !== undefined) { conditions.push('m.label = ?'); params.push(filters.memberLabel); }
    if (filters.sessionId !== undefined) { conditions.push('s.session_id = ?'); params.push(filters.sessionId); }
    if (filters.q !== undefined && filters.q.trim() !== '') {
      const pattern = containsPattern(filters.q.trim());
      conditions.push(`(s.title LIKE ? ESCAPE '\\' OR s.agent LIKE ? ESCAPE '\\' OR s.branch LIKE ? ESCAPE '\\' OR s.session_id LIKE ? ESCAPE '\\' OR ${firstPromptSql('s')} LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (after !== null) {
      if (across) {
        conditions.push(`${O} <= ? AND (${O} < ? OR (${O} = ? AND (s.project_id < ? OR (s.project_id = ? AND s.session_id < ?))))`);
        params.push(after.createdAt, after.createdAt, after.createdAt, after.projectId!, after.projectId!, after.id);
      } else {
        conditions.push(`${O} <= ? AND (${O} < ? OR (${O} = ? AND s.session_id < ?))`);
        params.push(after.createdAt, after.createdAt, after.createdAt, after.id);
      }
    }
    const sql = `SELECT s.project_id, ${SESSION_COLUMNS} ${sessionFrom(through)} WHERE ${conditions.join(' AND ')}
      ORDER BY ${O} DESC,${across ? ' s.project_id DESC,' : ''} s.session_id DESC LIMIT ?`;
    const [rows] = await readSet(db, composedRead<Record<string, unknown>>('sessionBrowse', sql).bind(...params, limit + 1));
    return rows;
  };
  const received = await page('receipt', active ? SESSIONS_ACTIVE_INDEX : across ? SESSIONS_ACROSS_INDEX : '');
  const working = active && filters.now !== undefined ? await page('working', SESSIONS_WORKING_INDEX) : [];
  return { received, working };
}
