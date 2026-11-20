import { TELEMETRY_CLOCK_TOLERANCE_MS } from '../core/telemetry-policy.js';
import { projectIdGrammar } from './project-id.js';

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
const signal = (side: 'NEW' | 'OLD') => `UPDATE telemetry_totals SET source_revision=source_revision+1 WHERE id=1;
 INSERT INTO telemetry_session_changes(project_id,session_id,revision) VALUES(${side}.project_id,${side}.session_id,1)
 ON CONFLICT(project_id,session_id) DO UPDATE SET revision=revision+1,cursor_trace='',cursor_key='';`;

/** Capture publishes dependency changes; the wake fans them out in bounded pages. */
export const TELEMETRY_WORK_DDL = [
  `CREATE TABLE IF NOT EXISTS telemetry_trace_keys(trace_id TEXT NOT NULL REFERENCES telemetry_traces(trace_id) ON DELETE CASCADE,
    key_id TEXT NOT NULL REFERENCES telemetry_keys(id),spans INTEGER NOT NULL DEFAULT 0,next_check INTEGER,revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(trace_id,key_id)) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_partition_empty ON telemetry_trace_keys(key_id,trace_id) WHERE spans=0',
  'CREATE INDEX IF NOT EXISTS idx_telemetry_trace_keys_key ON telemetry_trace_keys(key_id,trace_id)',
  'CREATE INDEX IF NOT EXISTS idx_telemetry_trace_key_due ON telemetry_trace_keys(key_id,next_check,trace_id) WHERE next_check IS NOT NULL AND spans>0',
  `CREATE TABLE IF NOT EXISTS telemetry_resolution_keys(trace_id TEXT NOT NULL,span_id TEXT NOT NULL,key_id TEXT NOT NULL REFERENCES telemetry_keys(id),
    PRIMARY KEY(trace_id,span_id,key_id),FOREIGN KEY(trace_id,span_id) REFERENCES telemetry_resolutions(trace_id,span_id) ON DELETE CASCADE) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_resolution_dependency ON telemetry_resolution_keys(key_id,trace_id,span_id)',
  `CREATE TABLE IF NOT EXISTS telemetry_dependency_ids(trace_id TEXT NOT NULL,key_id TEXT NOT NULL,session_id TEXT NOT NULL,
    PRIMARY KEY(trace_id,key_id,session_id),FOREIGN KEY(trace_id,key_id) REFERENCES telemetry_trace_keys(trace_id,key_id) ON DELETE CASCADE) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_dependency_id ON telemetry_dependency_ids(session_id,trace_id,key_id)',
  `CREATE TABLE IF NOT EXISTS telemetry_dependency_windows(trace_id TEXT NOT NULL,key_id TEXT NOT NULL,span_id TEXT NOT NULL,remote TEXT NOT NULL,ref TEXT NOT NULL,start_ms INTEGER NOT NULL,
    PRIMARY KEY(trace_id,key_id,span_id),FOREIGN KEY(trace_id,key_id) REFERENCES telemetry_trace_keys(trace_id,key_id) ON DELETE CASCADE) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_dependency_window ON telemetry_dependency_windows(remote,ref,start_ms,trace_id,key_id)',
  `CREATE TABLE IF NOT EXISTS telemetry_session_changes(project_id TEXT NOT NULL CHECK(${projectIdGrammar('project_id')}),session_id TEXT NOT NULL,revision INTEGER NOT NULL,
    cursor_trace TEXT NOT NULL DEFAULT '',cursor_key TEXT NOT NULL DEFAULT '',PRIMARY KEY(project_id,session_id)) WITHOUT ROWID`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_session_arrived AFTER INSERT ON sessions WHEN EXISTS(SELECT 1 FROM telemetry_dependency_ids WHERE session_id=NEW.session_id) OR ${point('NEW.project_id', 'NEW.branch', 'NEW.started_at')} BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_session_changed AFTER UPDATE OF started_at,branch ON sessions
    WHEN (OLD.started_at IS NOT NEW.started_at OR OLD.branch IS NOT NEW.branch) AND (${point('NEW.project_id', 'NEW.branch', 'NEW.started_at')} OR ${point('OLD.project_id', 'OLD.branch', 'OLD.started_at')}) BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_turn_arrived AFTER INSERT ON session_prompts WHEN ${turn} BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_document_arrived AFTER UPDATE OF state,generation ON session_documents WHEN NEW.state='live' AND (OLD.state IS NOT NEW.state OR OLD.generation IS NOT NEW.generation) AND ${generation} BEGIN ${signal('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_document_created AFTER INSERT ON session_documents WHEN NEW.state='live' AND ${generation} BEGIN ${signal('NEW')} END`,
];
