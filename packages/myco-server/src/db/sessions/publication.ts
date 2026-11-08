import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { SESSION_COLUMNS, sessionFrom } from './browse.js';
import { notTombstonedSql } from '../session-read-model.js';

const detail = read<[string, string], Record<string, unknown> & { published_revision: number }>({ name: 'session.detail',
  sql: `SELECT ${SESSION_COLUMNS},COALESCE(d.published_revision,0) AS published_revision ${sessionFrom('')}
    LEFT JOIN session_documents d ON (d.project_id,d.session_id)=(s.project_id,s.session_id)
    WHERE s.project_id=? AND s.session_id=? AND ${notTombstonedSql('s')}` });

/** Session detail follows committed document changes independently of capture receipts. */
export async function readSessionDetail(db: RelationalStore, project: string, session: string) {
  const [rows] = await readSet(db, detail.bind(project, session));
  return rows[0] ?? null;
}
