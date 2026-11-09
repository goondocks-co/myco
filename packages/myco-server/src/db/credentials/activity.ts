import type { RelationalStore } from '../../core/adapters.js';
import type { ProjectCursor } from '../../read/project-cursor.js';
import { read, readSet } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';

interface CredentialEventRow { event_id: string; project_id: string; session_id: string; kind: string; created_at: number; received_at: number }

const COLUMNS = 'event_id,project_id,session_id,kind,created_at,received_at';
const ORDER = 'ORDER BY created_at DESC,event_id DESC,project_id DESC LIMIT ?';

const newest = read<[token: string, limit: number], CredentialEventRow>({ name: 'credentialActivity.newest', sql:
  `SELECT ${COLUMNS} FROM events INDEXED BY idx_events_token_only WHERE token_id=? AND ${notTombstonedSql('events')} ${ORDER}` });
const after = read<[token: string, at: number, at2: number, at3: number, event: string, event2: string, project: string, limit: number], CredentialEventRow>({
  name: 'credentialActivity.after', sql: `SELECT ${COLUMNS} FROM events INDEXED BY idx_events_token_only WHERE token_id=? AND ${notTombstonedSql('events')}
    AND created_at<=? AND (created_at<? OR (created_at=? AND (event_id<? OR (event_id=? AND project_id<?)))) ${ORDER}` });

/** Up to `limit` events one credential wrote, across every Project, newest first and after `cursor` when given. */
export async function credentialEvents(db: RelationalStore, token: string, cursor: ProjectCursor | null, limit: number): Promise<CredentialEventRow[]> {
  const [rows] = await readSet(db, cursor === null ? newest.bind(token, limit)
    : after.bind(token, cursor.createdAt, cursor.createdAt, cursor.createdAt, cursor.id, cursor.id, cursor.projectId, limit));
  return rows;
}
