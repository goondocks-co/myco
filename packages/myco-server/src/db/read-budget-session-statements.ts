import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { READ_ORIGINS } from '../read/extraction-origins.js';
import { EXTRACTION_CANDIDATE_SQL, transcriptPendingSql } from './session-read-model.js';

const origins = READ_ORIGINS.map((origin) => `'${origin}'`).join(',');
const promptEligible = (row: string): string => `(${row}.processed = 0 AND ${row}.origin IN (${origins}))`;
const liveSession = (row: string): string => `(${row}.has_session = 1 AND ${row}.tombstoned = 0)`;

/** Apply a child-row contribution to its session, including children received before the session itself. */
function contribution(row: string, values: Record<string, string>, sign: 1 | -1): string {
  const columns = Object.keys(values);
  return `INSERT INTO session_read_facts(project_id,session_id,${columns.join(',')})
    VALUES(${row}.project_id,${row}.session_id,${Object.values(values).map((value) => `${sign} * ${value}`).join(',')})
    ON CONFLICT(project_id,session_id) DO UPDATE SET ${columns.map((column) => `${column} = ${column} + excluded.${column}`).join(',')};`;
}

function childTriggers(table: string, updateColumns: string, values: (row: string) => Record<string, string>): string[] {
  const oldValues = values('OLD');
  const newValues = values('NEW');
  const changed = ['OLD.project_id IS NOT NEW.project_id', 'OLD.session_id IS NOT NEW.session_id',
    ...Object.keys(oldValues).map(column => `(${oldValues[column]}) IS NOT (${newValues[column]})`)].join(' OR ');
  return ['INSERT', 'UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER IF NOT EXISTS ${table}_session_read_${operation.toLowerCase()}
    AFTER ${operation === 'UPDATE' ? `UPDATE OF ${updateColumns}` : operation} ON ${table}${operation === 'UPDATE' ? `
    WHEN ${changed}` : ''} BEGIN${operation === 'INSERT' ? '' : `
    ${contribution('OLD', oldValues, -1)}`}
    ${operation === 'DELETE' ? '' : contribution('NEW', newValues, 1)} END`);
}

function sessionPresent(row: string): string {
  return `INSERT INTO session_read_facts(project_id,session_id,has_session,ended_at,last_received_at)
    VALUES(${row}.project_id,${row}.session_id,1,${row}.ended_at,${row}.last_received_at)
    ON CONFLICT(project_id,session_id) DO UPDATE SET has_session=1,ended_at=excluded.ended_at,last_received_at=excluded.last_received_at;`;
}

/** Session selection and Project counts are maintained by the same transaction as every source mutation. */
export const READ_BUDGET_SESSION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_read_facts (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), session_id TEXT NOT NULL,
    has_session INTEGER NOT NULL DEFAULT 0, tombstoned INTEGER NOT NULL DEFAULT 0,
    ended_at INTEGER, last_received_at INTEGER,
    eligible_prompts INTEGER NOT NULL DEFAULT 0,
    pending_transcripts INTEGER NOT NULL DEFAULT 0,
    live_transcripts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(project_id,session_id))`,
  `CREATE TABLE IF NOT EXISTS project_session_counts (
    project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}), session_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_session_read_extraction ON session_read_facts
    (project_id,(live_transcripts > 0) DESC,ended_at DESC,session_id DESC) WHERE ${EXTRACTION_CANDIDATE_SQL}`,
  `CREATE INDEX IF NOT EXISTS idx_session_read_activity ON session_read_facts
    (project_id,last_received_at DESC) WHERE has_session = 1 AND tombstoned = 0`,
  `INSERT INTO session_read_facts(project_id,session_id,has_session,ended_at,last_received_at)
    SELECT project_id,session_id,1,ended_at,last_received_at FROM sessions WHERE 1
    ON CONFLICT(project_id,session_id) DO UPDATE SET has_session=1,ended_at=excluded.ended_at,last_received_at=excluded.last_received_at`,
  `INSERT INTO session_read_facts(project_id,session_id,tombstoned)
    SELECT project_id,session_id,1 FROM session_tombstones WHERE 1
    ON CONFLICT(project_id,session_id) DO UPDATE SET tombstoned=1`,
  `INSERT INTO session_read_facts(project_id,session_id,eligible_prompts)
    SELECT p.project_id,p.session_id,SUM(${promptEligible('p')}) FROM prompt_batches p GROUP BY p.project_id,p.session_id
    ON CONFLICT(project_id,session_id) DO UPDATE SET eligible_prompts=excluded.eligible_prompts`,
  `INSERT INTO session_read_facts(project_id,session_id,pending_transcripts,live_transcripts)
    SELECT t.project_id,t.session_id,SUM(${transcriptPendingSql('t')}),SUM(t.imported_at IS NULL)
    FROM transcripts t GROUP BY t.project_id,t.session_id
    ON CONFLICT(project_id,session_id) DO UPDATE SET pending_transcripts=excluded.pending_transcripts,live_transcripts=excluded.live_transcripts`,
  `INSERT INTO project_session_counts(project_id,session_count)
    SELECT project_id,SUM(has_session = 1 AND tombstoned = 0) FROM session_read_facts GROUP BY project_id
    ON CONFLICT(project_id) DO UPDATE SET session_count=excluded.session_count`,
  ...['INSERT', 'UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER IF NOT EXISTS session_read_facts_count_${operation.toLowerCase()}
    AFTER ${operation === 'UPDATE' ? 'UPDATE OF project_id,has_session,tombstoned' : operation} ON session_read_facts
    ${operation === 'UPDATE' ? `WHEN OLD.project_id <> NEW.project_id OR ${liveSession('OLD')} <> ${liveSession('NEW')}` : ''} BEGIN${operation === 'INSERT' ? '' : `
    INSERT INTO project_session_counts(project_id,session_count) VALUES(OLD.project_id,-${liveSession('OLD')})
      ON CONFLICT(project_id) DO UPDATE SET session_count=session_count+excluded.session_count;`}
    ${operation === 'DELETE' ? '' : `INSERT INTO project_session_counts(project_id,session_count) VALUES(NEW.project_id,${liveSession('NEW')})
      ON CONFLICT(project_id) DO UPDATE SET session_count=session_count+excluded.session_count;`} END`),
  `CREATE TRIGGER IF NOT EXISTS sessions_read_insert AFTER INSERT ON sessions BEGIN ${sessionPresent('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_read_update AFTER UPDATE OF project_id,session_id,ended_at,last_received_at ON sessions BEGIN
    UPDATE session_read_facts SET has_session=0,ended_at=NULL,last_received_at=NULL WHERE project_id=OLD.project_id AND session_id=OLD.session_id
      AND (OLD.project_id <> NEW.project_id OR OLD.session_id <> NEW.session_id);
    ${sessionPresent('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_read_delete AFTER DELETE ON sessions BEGIN
    UPDATE session_read_facts SET has_session=0,ended_at=NULL,last_received_at=NULL WHERE project_id=OLD.project_id AND session_id=OLD.session_id; END`,
  ...childTriggers('prompt_batches', 'project_id,session_id,processed,origin', (row) => ({ eligible_prompts: promptEligible(row) })),
  ...childTriggers('transcripts', 'project_id,session_id,parsed_offset,size,parse_error,imported_at', (row) => ({
    pending_transcripts: transcriptPendingSql(row), live_transcripts: `(${row}.imported_at IS NULL)`,
  })),
  ...childTriggers('session_tombstones', 'project_id,session_id', () => ({ tombstoned: '1' })),
];
