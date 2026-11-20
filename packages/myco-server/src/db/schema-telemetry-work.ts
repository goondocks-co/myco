import { projectIdGrammar } from './project-id.js';

const TELEMETRY_CLOCK_TOLERANCE_MS = 2_000;

const point = (
  project: string,
  branch: string,
  time: string,
) => `EXISTS(SELECT 1 FROM project_remotes p JOIN telemetry_dependency_windows w
 ON w.remote=p.remote AND w.ref=${branch} AND w.start_ms BETWEEN ${time}-${TELEMETRY_CLOCK_TOLERANCE_MS} AND ${time}+${TELEMETRY_CLOCK_TOLERANCE_MS} WHERE p.project_id=${project})`;
const turn = point(
  'NEW.project_id',
  '(SELECT branch FROM sessions WHERE project_id=NEW.project_id AND session_id=NEW.session_id)',
  'NEW.created_at',
);
const generation = `EXISTS(SELECT 1 FROM session_prompts prompt WHERE prompt.project_id=NEW.project_id AND prompt.session_id=NEW.session_id AND prompt.generation=NEW.generation AND prompt.turn_key=prompt.prompt_id
 AND ${point('NEW.project_id', '(SELECT branch FROM sessions WHERE project_id=NEW.project_id AND session_id=NEW.session_id)', 'prompt.created_at')})`;
const signal = (
  side: 'NEW' | 'OLD',
) => `UPDATE telemetry_totals SET source_revision=source_revision+1,work_due=0 WHERE id=1;
 INSERT INTO telemetry_session_changes(project_id,session_id,revision) VALUES(${side}.project_id,${side}.session_id,1)
 ON CONFLICT(project_id,session_id) DO UPDATE SET revision=revision+1,cursor_trace='',cursor_key='';`;

const publishedTurn = (side: 'NEW' | 'OLD') => `EXISTS(SELECT 1 FROM session_prompts prompt
 JOIN session_documents d ON d.project_id=prompt.project_id AND d.session_id=prompt.session_id AND d.generation=prompt.generation AND d.state='live'
 WHERE prompt.project_id=${side}.project_id AND prompt.session_id=${side}.session_id AND prompt.turn_key=prompt.prompt_id
 AND ${point(`${side}.project_id`, `${side}.branch`, 'prompt.created_at')})`;
const projectSignal = (
  side: 'NEW' | 'OLD',
) => `UPDATE telemetry_totals SET source_revision=source_revision+1,work_due=0 WHERE id=1;
 INSERT INTO telemetry_session_changes(project_id,session_id,scope,revision) VALUES(${side}.project_id,'','project',1)
 ON CONFLICT(project_id,session_id) DO UPDATE SET revision=revision+1,cursor_trace='',cursor_key='';`;
/** Capture publishes dependency changes; the wake fans them out in bounded pages. */
export const TELEMETRY_WORK_DDL = [
  `CREATE TABLE IF NOT EXISTS telemetry_trace_keys(trace_id TEXT NOT NULL,
    key_id TEXT NOT NULL REFERENCES telemetry_keys(id),spans INTEGER NOT NULL DEFAULT 0,next_check INTEGER,revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(trace_id,key_id),FOREIGN KEY(key_id,trace_id) REFERENCES telemetry_traces(key_id,trace_id) ON DELETE CASCADE) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_partition_empty ON telemetry_trace_keys(key_id,trace_id) WHERE spans=0',
  'CREATE INDEX IF NOT EXISTS idx_telemetry_trace_keys_key ON telemetry_trace_keys(key_id,trace_id)',
  'CREATE INDEX IF NOT EXISTS idx_telemetry_trace_key_due ON telemetry_trace_keys(next_check,key_id,trace_id) WHERE next_check IS NOT NULL AND spans>0',
  `CREATE TABLE IF NOT EXISTS telemetry_dependency_ids(trace_id TEXT NOT NULL,key_id TEXT NOT NULL,session_id TEXT NOT NULL,
    PRIMARY KEY(trace_id,key_id,session_id),FOREIGN KEY(trace_id,key_id) REFERENCES telemetry_trace_keys(trace_id,key_id) ON DELETE CASCADE) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_dependency_id ON telemetry_dependency_ids(session_id,trace_id,key_id)',
  `CREATE TABLE IF NOT EXISTS telemetry_dependency_windows(trace_id TEXT NOT NULL,key_id TEXT NOT NULL,span_id TEXT NOT NULL,remote TEXT NOT NULL,ref TEXT NOT NULL,start_ms INTEGER NOT NULL,
    PRIMARY KEY(trace_id,key_id,span_id),FOREIGN KEY(trace_id,key_id) REFERENCES telemetry_trace_keys(trace_id,key_id) ON DELETE CASCADE) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_dependency_window ON telemetry_dependency_windows(remote,ref,start_ms,trace_id,key_id)',
  `CREATE TABLE IF NOT EXISTS telemetry_session_changes(project_id TEXT NOT NULL CHECK(${projectIdGrammar('project_id')}),session_id TEXT NOT NULL,scope TEXT NOT NULL DEFAULT 'session' CHECK(scope IN('session','project')),revision INTEGER NOT NULL,
    cursor_trace TEXT NOT NULL DEFAULT '',cursor_key TEXT NOT NULL DEFAULT '',PRIMARY KEY(project_id,session_id)) WITHOUT ROWID`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_session_arrived AFTER INSERT ON sessions WHEN EXISTS(SELECT 1 FROM telemetry_dependency_ids WHERE session_id=NEW.session_id) OR ${point('NEW.project_id', 'NEW.branch', 'NEW.started_at')} BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_session_changed AFTER UPDATE OF started_at,branch ON sessions
    WHEN (OLD.started_at IS NOT NEW.started_at OR OLD.branch IS NOT NEW.branch) AND (${point('NEW.project_id', 'NEW.branch', 'NEW.started_at')} OR ${point('OLD.project_id', 'OLD.branch', 'OLD.started_at')} OR ${publishedTurn('NEW')} OR ${publishedTurn('OLD')}) BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_turn_arrived AFTER INSERT ON session_prompts WHEN ${turn} BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_document_arrived AFTER UPDATE OF state,generation ON session_documents WHEN NEW.state='live' AND (OLD.state IS NOT NEW.state OR OLD.generation IS NOT NEW.generation) AND ${generation} BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_document_created AFTER INSERT ON session_documents WHEN NEW.state='live' AND ${generation} BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_remote_bound AFTER INSERT ON project_remotes WHEN EXISTS(SELECT 1 FROM telemetry_dependency_windows WHERE remote=NEW.remote) BEGIN ${projectSignal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_session_deleted AFTER DELETE ON sessions WHEN EXISTS(SELECT 1 FROM telemetry_dependency_ids WHERE session_id=OLD.session_id)
 OR EXISTS(SELECT 1 FROM project_remotes p JOIN telemetry_dependency_windows w ON w.remote=p.remote WHERE p.project_id=OLD.project_id) BEGIN ${signal('OLD')} ${projectSignal('OLD')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_session_tombstoned AFTER INSERT ON session_tombstones WHEN EXISTS(SELECT 1 FROM telemetry_dependency_ids WHERE session_id=NEW.session_id)
 OR EXISTS(SELECT 1 FROM project_remotes p JOIN telemetry_dependency_windows w ON w.remote=p.remote WHERE p.project_id=NEW.project_id) BEGIN ${signal('NEW')} ${projectSignal('NEW')} END`,
];
