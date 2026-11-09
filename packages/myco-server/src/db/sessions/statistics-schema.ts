import { changed, trigger, type Trigger } from '../ddl.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { occurredAt, presentedEndedAt } from '../session-dates.js';

/**
 * What a Project holds, maintained on write and never recounted. A session contributes one `session_statistics` row and,
 * while it holds attachments, one `session_attachment_counts` row, each re-derived from its sources whenever a trigger or
 * a catch-up page names its key; triggers on those rows move the Project's counters and day rollup by `-old +new`, so
 * replaying a key can never count it twice.
 */
export const PROJECT_STATISTICS_PROJECTION = 'project_statistics';
export const PROJECT_STATISTICS_SESSION_PHASE = 'projectStatisticsSessions';
export const PROJECT_STATISTICS_ATTACHMENT_PHASE = 'projectStatisticsAttachments';

export const DAY_MS = 86_400_000;

const LIVE = 'NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=s.project_id AND t.session_id=s.session_id)';
const STATISTIC_COLUMNS = ['open_session', 'occurred_day', 'prompts', 'tool_calls'] as const;

/** Re-derive the statistics of the session keys `keys` (columns `project_id,session_id`): a key with no live session loses its row. */
export function reconcileSessionStatistics(keys: string): string[] {
  return [
    `DELETE FROM session_statistics WHERE (project_id,session_id) IN (SELECT project_id,session_id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=session_statistics.project_id AND s.session_id=session_statistics.session_id AND ${LIVE})`,
    `INSERT INTO session_statistics(project_id,session_id,open_session,occurred_day,prompts,tool_calls)
      SELECT s.project_id,s.session_id,${presentedEndedAt('s.')} IS NULL,${occurredAt('s.')}/${DAY_MS},COALESCE(d.prompts,0),COALESCE(d.tool_calls,0)
      FROM (${keys}) key JOIN sessions s ON s.project_id=key.project_id AND s.session_id=key.session_id
      LEFT JOIN session_documents d ON d.project_id=s.project_id AND d.session_id=s.session_id AND d.state='live'
      WHERE ${LIVE}
      ON CONFLICT(project_id,session_id) DO UPDATE SET open_session=excluded.open_session,occurred_day=excluded.occurred_day,prompts=excluded.prompts,tool_calls=excluded.tool_calls
      WHERE ${STATISTIC_COLUMNS.map(column => `session_statistics.${column} IS NOT excluded.${column}`).join(' OR ')}`,
  ];
}

/** Re-derive the attachment counts of the session keys `keys`: a key whose session is deleted or holds none loses its row. */
export function reconcileAttachmentCounts(keys: string): string[] {
  const holds = (project: string, session: string) => `EXISTS (SELECT 1 FROM attachments a WHERE a.project_id=${project} AND a.session_id=${session})`;
  const tombstoned = (project: string, session: string) => `EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=${project} AND t.session_id=${session})`;
  return [
    `DELETE FROM session_attachment_counts WHERE (project_id,session_id) IN (SELECT project_id,session_id FROM (${keys}))
      AND (NOT ${holds('session_attachment_counts.project_id', 'session_attachment_counts.session_id')} OR ${tombstoned('session_attachment_counts.project_id', 'session_attachment_counts.session_id')})`,
    `INSERT INTO session_attachment_counts(project_id,session_id,n)
      SELECT key.project_id,key.session_id,(SELECT COUNT(*) FROM attachments a WHERE a.project_id=key.project_id AND a.session_id=key.session_id)
      FROM (${keys}) key WHERE ${holds('key.project_id', 'key.session_id')} AND NOT ${tombstoned('key.project_id', 'key.session_id')}
      ON CONFLICT(project_id,session_id) DO UPDATE SET n=excluded.n WHERE session_attachment_counts.n IS NOT excluded.n`,
  ];
}

const rowKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.session_id AS session_id`;

/** Triggers re-deriving a key's row: on insert, on a change to a watched column of either key, and on delete. */
function sourceTriggers(prefix: string, table: string, watched: readonly string[], reconcile: (keys: string) => string[], rowFilter?: (row: string) => string): Trigger[] {
  const both = [...reconcile(rowKey('OLD')), ...reconcile(rowKey('NEW'))];
  const filtered = (row: string) => (rowFilter === undefined ? null : rowFilter(row));
  return [
    trigger(`${prefix}_insert`, table, 'INSERT', reconcile(rowKey('NEW')), filtered('NEW')),
    trigger(`${prefix}_update`, table, `UPDATE OF ${watched.join(',')}`, both, changed(watched)),
    trigger(`${prefix}_delete`, table, 'DELETE', reconcile(rowKey('OLD')), filtered('OLD')),
  ];
}

const counterUpsert = (project: string, columns: Record<string, string>) => `INSERT INTO project_session_counts(project_id,${Object.keys(columns).join(',')}) VALUES(${project},${Object.values(columns).join(',')})
  ON CONFLICT(project_id) DO UPDATE SET ${Object.keys(columns).map(column => `${column}=${column}+excluded.${column}`).join(',')}`;
const sessionCounters = (row: string, sign: '' | '-') => counterUpsert(`${row}.project_id`, { open_sessions: `${sign}${row}.open_session`, prompts: `${sign}${row}.prompts`, tool_calls: `${sign}${row}.tool_calls` });
const sessionCounterDelta = counterUpsert('NEW.project_id', { open_sessions: 'NEW.open_session-OLD.open_session', prompts: 'NEW.prompts-OLD.prompts', tool_calls: 'NEW.tool_calls-OLD.tool_calls' });
const attachmentCounter = (row: string, sign: '' | '-') => counterUpsert(`${row}.project_id`, { attachments: `${sign}${row}.n` });
const attachmentCounterDelta = counterUpsert('NEW.project_id', { attachments: 'NEW.n-OLD.n' });
const attachmentArrives = `INSERT INTO session_attachment_counts(project_id,session_id,n)
  SELECT NEW.project_id,NEW.session_id,1 WHERE NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=NEW.project_id AND t.session_id=NEW.session_id)
  ON CONFLICT(project_id,session_id) DO UPDATE SET n=n+1`;
const attachmentLeaves = [
  `UPDATE session_attachment_counts SET n=n-1 WHERE project_id=OLD.project_id AND session_id=OLD.session_id`,
  `DELETE FROM session_attachment_counts WHERE project_id=OLD.project_id AND session_id=OLD.session_id AND n<=0`,
];
const dayBump = (row: string, delta: 1 | -1) => `INSERT INTO project_session_days(project_id,day,n) VALUES(${row}.project_id,${row}.occurred_day,${delta})
  ON CONFLICT(project_id,day) DO UPDATE SET n=n${delta === 1 ? '+1' : '-1'}`;

/** The derived tables, their triggers and the catch-up seed, as one schema step freezes them. */
export function projectStatisticsSchemaStatements(): string[] {
  const SESSION_SOURCE = ['project_id', 'session_id', 'first_received_at', 'started_at', 'occurred_started_at', 'ended_at', 'occurred_ended_at'];
  const DOCUMENT_SOURCE = ['project_id', 'session_id', 'state', 'prompts', 'tool_calls'];
  const COUNTED = ['open_session', 'prompts', 'tool_calls'];
  return [
    `ALTER TABLE project_session_counts ADD COLUMN open_sessions INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE project_session_counts ADD COLUMN prompts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE project_session_counts ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE project_session_counts ADD COLUMN attachments INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS session_statistics(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
      open_session INTEGER NOT NULL CHECK (open_session IN (0,1)),occurred_day INTEGER NOT NULL,prompts INTEGER NOT NULL,tool_calls INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS session_attachment_counts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,n INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS project_session_days(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),day INTEGER NOT NULL,n INTEGER NOT NULL,
      PRIMARY KEY(project_id,day)) WITHOUT ROWID`,
    ...[
      ...sourceTriggers('project_statistics_session', 'sessions', SESSION_SOURCE, reconcileSessionStatistics),
      ...sourceTriggers('project_statistics_document', 'session_documents', DOCUMENT_SOURCE, reconcileSessionStatistics, row => `${row}.state='live'`),
      trigger('project_statistics_attachment_insert', 'attachments', 'INSERT', attachmentArrives),
      trigger('project_statistics_attachment_update', 'attachments', 'UPDATE OF project_id,session_id', [...reconcileAttachmentCounts(rowKey('OLD')), ...reconcileAttachmentCounts(rowKey('NEW'))], changed(['project_id', 'session_id'])),
      trigger('project_statistics_attachment_delete', 'attachments', 'DELETE', attachmentLeaves),
      trigger('project_statistics_tombstone_insert', 'session_tombstones', 'INSERT', [...reconcileSessionStatistics(rowKey('NEW')), ...reconcileAttachmentCounts(rowKey('NEW'))]),
      trigger('project_statistics_tombstone_delete', 'session_tombstones', 'DELETE', [...reconcileSessionStatistics(rowKey('OLD')), ...reconcileAttachmentCounts(rowKey('OLD'))]),
      trigger('session_statistics_insert', 'session_statistics', 'INSERT', [sessionCounters('NEW', ''), dayBump('NEW', 1)]),
      trigger('session_statistics_counted', 'session_statistics', `UPDATE OF ${COUNTED.join(',')}`, sessionCounterDelta, changed(COUNTED)),
      trigger('session_statistics_day', 'session_statistics', 'UPDATE OF occurred_day', [dayBump('OLD', -1), dayBump('NEW', 1)], changed(['occurred_day'])),
      trigger('session_statistics_delete', 'session_statistics', 'DELETE', [sessionCounters('OLD', '-'), dayBump('OLD', -1)]),
      trigger('session_attachment_counts_insert', 'session_attachment_counts', 'INSERT', attachmentCounter('NEW', '')),
      trigger('session_attachment_counts_update', 'session_attachment_counts', 'UPDATE OF n', attachmentCounterDelta, changed(['n'])),
      trigger('session_attachment_counts_delete', 'session_attachment_counts', 'DELETE', attachmentCounter('OLD', '-')),
    ].map(built => built.sql),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${PROJECT_STATISTICS_PROJECTION}','${PROJECT_STATISTICS_SESSION_PHASE}',NOT EXISTS(SELECT 1 FROM sessions) ON CONFLICT DO NOTHING`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${PROJECT_STATISTICS_PROJECTION}','${PROJECT_STATISTICS_ATTACHMENT_PHASE}',NOT EXISTS(SELECT 1 FROM attachments) ON CONFLICT DO NOTHING`,
  ];
}
