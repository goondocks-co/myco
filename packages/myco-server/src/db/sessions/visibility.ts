import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { activityAt, occurredAt, presentedEndedAt, presentedOpen } from '../session-dates.js';
import { notTombstonedSql } from '../session-read-model.js';
import { DAY_MS } from './statistics-schema.js';

/** NULL records have no capture-time evidence of emptiness. */
export const retainedSession = (prefix = ''): string => `${prefix}has_activity IS NOT 0`;

/** Empty sessions with an open lifecycle are eligible for the live window. */
export const emptyOpenSession = (prefix = ''): string => `${prefix}has_activity=0 AND ${presentedOpen(prefix)}`;

/** The single admission rule for a captured empty session at a read's instant. */
export const emptyLiveSession = (quiet: string, prefix = ''): string => `${emptyOpenSession(prefix)} AND ${activityAt(prefix)}>${quiet}`;

/** An empty session is retained through its current turn, even while capture is quiet. */
export const emptyWorkingSession = (workingAfter: string, quiet: string, prefix = ''): string =>
  `${emptyOpenSession(prefix)} AND ${prefix}working_since IS NOT NULL AND ${prefix}working_since>${workingAfter}
   AND (${quiet} IS NULL OR ${activityAt(prefix)}<=${quiet})`;

/** Live receipts and quiet current turns form disjoint, indexed sets of empty sessions. */
export const emptyVisibleFrom = (project: string, quiet: string, workingAfter: string): string => {
  const columns = 'project_id,session_id,last_received_at,occurred_started_at,started_at,first_received_at,occurred_ended_at,ended_at';
  return `FROM (
    SELECT ${columns} FROM sessions s INDEXED BY idx_sessions_empty_live_project
      WHERE s.project_id=${project} AND ${emptyLiveSession(quiet, 's.')}
    UNION ALL SELECT ${columns} FROM sessions s INDEXED BY idx_sessions_empty_working_project
      WHERE s.project_id=${project} AND ${emptyWorkingSession(workingAfter, quiet, 's.')}
  ) s WHERE ${notTombstonedSql('s')}`;
};

/** A total subtracts all confirmed empties, then restores those live or working at the read's instant. */
export const visibleSessionCount = (project: string, quiet: string, workingAfter: string, total: string): string => `(${total}
  - COALESCE((SELECT n FROM project_empty_session_counts WHERE project_id=${project}),0)
  + (SELECT COUNT(*) ${emptyVisibleFrom(project, quiet, workingAfter)}))`;

/** Receipt time remains the Project's last-contact display, over sessions visible at this instant. */
export const visibleLastReceipt = (project: string, quiet: string, workingAfter: string): string => `(SELECT MAX(at) FROM (
  SELECT (SELECT f.last_received_at FROM session_read_facts f INDEXED BY idx_session_read_retained_activity
    WHERE f.project_id=${project} AND f.has_session=1 AND f.tombstoned=0 AND ${retainedSession('f.')}
    ORDER BY f.last_received_at DESC LIMIT 1) AS at
  UNION ALL SELECT MAX(s.last_received_at) ${emptyVisibleFrom(project, quiet, workingAfter)}))`;

/** Empty contributions are maintained only when capture evidence, dates or deletion change. */
export function emptySessionSchema(): string[] {
  const contribution = (row: string, sign: '' | '-', sourceKind: 'session' | 'tombstone') => {
    const key = `s.project_id=${row}.project_id AND s.session_id=${row}.session_id`;
    const columns = ['project_id','session_id','has_activity','occurred_started_at','started_at','first_received_at','occurred_ended_at','ended_at'];
    const source = sourceKind === 'tombstone' ? `FROM sessions s WHERE ${key}` : `FROM (SELECT ${columns.map(c => `${row}.${c} AS ${c}`).join(',')}) s WHERE 1`;
    const held = `${source} AND s.has_activity=0${sourceKind === 'tombstone' ? '' : ` AND ${notTombstonedSql('s')}`}`;
    return [
      `INSERT INTO project_empty_session_counts(project_id,n,open_n)
        SELECT s.project_id,${sign}1,${sign}(${presentedEndedAt('s.')} IS NULL) ${held}
        ON CONFLICT(project_id) DO UPDATE SET n=n+excluded.n,open_n=open_n+excluded.open_n;`,
      `INSERT INTO project_empty_session_days(project_id,day,n)
        SELECT s.project_id,${occurredAt('s.')}/${DAY_MS},${sign}1 ${held}
        ON CONFLICT(project_id,day) DO UPDATE SET n=n+excluded.n;`,
    ].join('\n');
  };
  const watched = ['project_id','session_id','has_activity','occurred_started_at','started_at','first_received_at','occurred_ended_at','ended_at'];
  return [
    ...['INSERT', 'UPDATE OF project_id,session_id,has_activity'].map((event, index) =>
      `CREATE TRIGGER IF NOT EXISTS sessions_activity_read_${index === 0 ? 'insert' : 'update'} AFTER ${event} ON sessions
       WHEN ${index === 0 ? 'NEW.has_activity IS NOT NULL' : 'OLD.project_id IS NOT NEW.project_id OR OLD.session_id IS NOT NEW.session_id OR OLD.has_activity IS NOT NEW.has_activity'} BEGIN
       INSERT INTO session_read_facts(project_id,session_id,has_activity) VALUES(NEW.project_id,NEW.session_id,NEW.has_activity)
       ON CONFLICT(project_id,session_id) DO UPDATE SET has_activity=excluded.has_activity; END`),
    `CREATE TABLE IF NOT EXISTS project_empty_session_counts(project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}),n INTEGER NOT NULL,open_n INTEGER NOT NULL) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS project_empty_session_days(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),day INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(project_id,day)) WITHOUT ROWID`,
    `CREATE TRIGGER IF NOT EXISTS sessions_empty_insert AFTER INSERT ON sessions WHEN NEW.has_activity=0 BEGIN ${contribution('NEW','','session')} END`,
    `CREATE TRIGGER IF NOT EXISTS sessions_empty_update AFTER UPDATE OF ${watched.join(',')} ON sessions
      WHEN (${watched.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ')}) AND (OLD.has_activity=0 OR NEW.has_activity=0)
      BEGIN ${contribution('OLD','-','session')} ${contribution('NEW','','session')} END`,
    `CREATE TRIGGER IF NOT EXISTS sessions_empty_delete AFTER DELETE ON sessions WHEN OLD.has_activity=0 BEGIN ${contribution('OLD','-','session')} END`,
    `CREATE TRIGGER IF NOT EXISTS tombstones_empty_insert AFTER INSERT ON session_tombstones BEGIN ${contribution('NEW','-','tombstone')} END`,
    `CREATE TRIGGER IF NOT EXISTS tombstones_empty_delete AFTER DELETE ON session_tombstones BEGIN ${contribution('OLD','','tombstone')} END`,
  ];
}
