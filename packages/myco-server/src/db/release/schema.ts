import { changed, trigger } from '../ddl.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';

/**
 * Release provenance's maintained relations: one due row per enabled Project, one work row per session with a captured
 * commit, a keyed queue that carries a session's state to its spores and plans, and the report of stored rows the
 * namespace catch-up could not place. `knowledge_release_state` keeps one current row per record; the catch-up
 * canonicalizes what older writers left, and `canonical=1` is what the unique current key covers.
 */
export const RELEASE_PROJECTION = 'release_provenance';
export const RELEASE_CHECK_PHASE = 'releaseCheckDue';
export const RELEASE_STATE_PHASE = 'releaseStateCurrent';
export const RELEASE_WORK_PHASE = 'releaseWorkSeed';

/** Whether tracked files differed from a git provenance row `g`: session starts and rows with an observation error are `unknown`. */
export const CLEANLINESS_SQL = "CASE WHEN g.capture_point = 'session_start' OR g.error IS NOT NULL THEN 'unknown' ELSE CAST(g.is_dirty AS TEXT) END";

/** Holds on `g` for the commit a session is classified from: its end, or its start while no end is captured. */
export const latestSourceOf = (project: string, session: string): string => `g.project_id=${project} AND g.session_id=${session} AND g.head_sha IS NOT NULL
  AND g.capture_point=(SELECT MIN(i.capture_point) FROM knowledge_git_provenance i WHERE i.project_id=${project} AND i.session_id=${session}
    AND i.head_sha IS NOT NULL AND i.capture_point IN ('session_start','session_end'))`;

/** Any change of the commit a session is classified from re-opens its work; a capture that changes nothing else leaves it. */
const sourceUpsert = (project: string, session: string) => `INSERT INTO release_work_due (project_id,session_id,point,head_sha,cleanliness,captured_at)
  SELECT g.project_id,g.session_id,g.capture_point,g.head_sha,${CLEANLINESS_SQL},g.captured_at FROM knowledge_git_provenance g WHERE ${latestSourceOf(project, session)}
  ON CONFLICT (project_id,session_id) DO UPDATE SET point=excluded.point,head_sha=excluded.head_sha,cleanliness=excluded.cleanliness,captured_at=excluded.captured_at,
    source_revision=source_revision+1,settled_generation=0,final=0
  WHERE point IS NOT excluded.point OR head_sha IS NOT excluded.head_sha OR cleanliness IS NOT excluded.cleanliness`;

const NOW_MS = 'CAST(unixepoch()*1000 AS INTEGER)';

/** A record that names a session already classified queues that session's state for it; a session never classified has nothing to carry. */
const queueDerived = (row: 'NEW') => `INSERT INTO release_propagation_due(project_id,session_id,queued_at)
  SELECT ${row}.project_id,${row}.session_id,${NOW_MS} WHERE EXISTS (SELECT 1 FROM knowledge_release_state k WHERE k.project_id=${row}.project_id AND k.namespace='sessions' AND k.record_id=${row}.session_id)
  ON CONFLICT(project_id,session_id) DO UPDATE SET generation=generation+1,after_namespace='',after_record='',queued_at=excluded.queued_at`;

/**
 * A path change moves the source revision too, so a check that read the paths before it settles nothing and the session
 * stays due. Only a clean end commit is classified from its paths; a start, a dirty end or an unreadable one is not.
 */
const REOPEN_FOR_PATHS = `UPDATE release_work_due SET settled_generation=0,source_revision=source_revision+1 WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND final=0
  AND point='session_end' AND cleanliness='0'
  AND EXISTS (SELECT 1 FROM project_release_provenance p WHERE p.project_id=NEW.project_id AND p.package_map<>'[]')`;

export function releaseSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS release_check_due (
       project_id  TEXT NOT NULL PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
       next_at     INTEGER NOT NULL,
       revision    TEXT NOT NULL,
       lease_id    TEXT,
       lease_until INTEGER)`,
    'CREATE INDEX IF NOT EXISTS idx_release_check_due_head ON release_check_due (next_at, project_id)',
    `CREATE TABLE IF NOT EXISTS release_work_due (
       project_id         TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
       session_id         TEXT NOT NULL,
       point              TEXT NOT NULL,
       head_sha           TEXT NOT NULL,
       cleanliness        TEXT NOT NULL,
       captured_at        INTEGER NOT NULL,
       source_revision    INTEGER NOT NULL DEFAULT 1,
       settled_generation INTEGER NOT NULL DEFAULT 0,
       final              INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1)),
       PRIMARY KEY (project_id, session_id))`,
    'CREATE INDEX IF NOT EXISTS idx_release_work_open ON release_work_due (project_id, settled_generation, captured_at DESC, session_id) WHERE final = 0',
    `CREATE TABLE IF NOT EXISTS release_propagation_due (
       project_id      TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
       session_id      TEXT NOT NULL,
       generation      INTEGER NOT NULL DEFAULT 1,
       after_namespace TEXT NOT NULL DEFAULT '',
       after_record    TEXT NOT NULL DEFAULT '',
       queued_at       INTEGER NOT NULL,
       PRIMARY KEY (project_id, session_id))`,
    'CREATE INDEX IF NOT EXISTS idx_release_propagation_head ON release_propagation_due (queued_at, project_id, session_id)',
    `CREATE TABLE IF NOT EXISTS release_state_unresolved (
       project_id   TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
       row_id       TEXT NOT NULL,
       reason       TEXT NOT NULL CHECK (reason IN ('duplicate','unknown_namespace','identity_mismatch','identity_taken')),
       namespace    TEXT NOT NULL,
       record_id    TEXT NOT NULL,
       state        TEXT NOT NULL,
       winner_id    TEXT,
       winner_state TEXT,
       row_json     TEXT NOT NULL,
       reported_at  INTEGER NOT NULL,
       PRIMARY KEY (project_id, row_id))`,
    'ALTER TABLE knowledge_release_state ADD COLUMN canonical INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE knowledge_release_state ADD COLUMN source_key TEXT',
    'ALTER TABLE knowledge_release_state ADD COLUMN config_revision TEXT',
    'ALTER TABLE knowledge_release_state ADD COLUMN refs_fingerprint TEXT',
    'ALTER TABLE knowledge_release_state ADD COLUMN paths_mark INTEGER',
    'ALTER TABLE project_release_provenance ADD COLUMN work_generation INTEGER NOT NULL DEFAULT 1',
    ...[
      trigger('release_work_capture_insert', 'knowledge_git_provenance', 'INSERT', sourceUpsert('NEW.project_id', 'NEW.session_id'), 'NEW.session_id IS NOT NULL AND NEW.head_sha IS NOT NULL'),
      trigger('release_work_capture_update', 'knowledge_git_provenance', 'UPDATE OF head_sha,is_dirty,error', sourceUpsert('NEW.project_id', 'NEW.session_id'),
        `NEW.session_id IS NOT NULL AND NEW.head_sha IS NOT NULL AND (${changed(['head_sha', 'is_dirty', 'error'])})`),
      trigger('release_work_paths_insert', 'session_documents', 'INSERT', REOPEN_FOR_PATHS, 'COALESCE(NEW.tool_calls,0)>0'),
      trigger('release_work_paths_update', 'session_documents', 'UPDATE OF tool_calls', REOPEN_FOR_PATHS, changed(['tool_calls'])),
      trigger('release_propagation_spore_insert', 'spores', 'INSERT', queueDerived('NEW'), 'NEW.session_id IS NOT NULL'),
      trigger('release_propagation_spore_update', 'spores', 'UPDATE OF session_id', queueDerived('NEW'), `NEW.session_id IS NOT NULL AND ${changed(['session_id'])}`),
      trigger('release_propagation_plan_insert', 'plans', 'INSERT', queueDerived('NEW'), 'NEW.session_id IS NOT NULL'),
      trigger('release_propagation_plan_update', 'plans', 'UPDATE OF session_id', queueDerived('NEW'), `NEW.session_id IS NOT NULL AND ${changed(['session_id'])}`),
    ].map(built => built.sql),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${RELEASE_PROJECTION}','${RELEASE_CHECK_PHASE}',NOT EXISTS(SELECT 1 FROM project_release_provenance) ON CONFLICT DO NOTHING`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${RELEASE_PROJECTION}','${RELEASE_STATE_PHASE}',NOT EXISTS(SELECT 1 FROM knowledge_release_state) ON CONFLICT DO NOTHING`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${RELEASE_PROJECTION}','${RELEASE_WORK_PHASE}',NOT EXISTS(SELECT 1 FROM knowledge_git_provenance) ON CONFLICT DO NOTHING`,
  ];
}
