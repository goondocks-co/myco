import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { SESSION_COLUMNS, sessionFrom } from './browse.js';
import { presentedLive } from '../session-dates.js';
import { notTombstonedSql } from '../session-read-model.js';

const detail = read<[project: string, session: string, quiet: number | null], Record<string, unknown> & { published_revision: number }>({ name: 'session.detail',
  sql: `SELECT ${SESSION_COLUMNS},${presentedLive('?3', 's.')} AS live,COALESCE(d.published_revision,0) AS published_revision ${sessionFrom('')}
    LEFT JOIN session_documents d ON (d.project_id,d.session_id)=(s.project_id,s.session_id)
    WHERE s.project_id=?1 AND s.session_id=?2 AND ${notTombstonedSql('s')}` });

/** Session detail follows committed document changes independently of capture receipts; given `quietBefore`, it says whether the session is live. */
export async function readSessionDetail(db: RelationalStore, project: string, session: string, quietBefore: number | null = null) {
  const [rows] = await readSet(db, detail.bind(project, session, quietBefore));
  return rows[0] ?? null;
}
