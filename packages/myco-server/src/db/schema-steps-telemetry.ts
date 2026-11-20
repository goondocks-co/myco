import { telemetryKeyUseSql } from './telemetry/key-use.js';
import { TELEMETRY_DAY_MS, TELEMETRY_HOUR_MS } from '../core/telemetry-policy.js';
import { TELEMETRY_REPORT_DDL } from './schema-telemetry-reports.js';
import { TELEMETRY_WORK_DDL } from './schema-telemetry-work.js';
import { projectIdGrammar } from './project-id.js';
import { NEXT_TELEMETRY } from './schema-vNEXT-telemetry.js';
import { reaching, type SchemaStep } from './schema-step.js';

/** Ingest credentials carry no member, Project or editorial authority. */
export const TELEMETRY_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_TELEMETRY,
    statements: [
      `CREATE TABLE IF NOT EXISTS telemetry_keys(id TEXT PRIMARY KEY,key_hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,
      created_by TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER,revoked_at INTEGER,revoked_by TEXT,spans INTEGER NOT NULL DEFAULT 0,clock_skew_ms INTEGER,cleanup_done INTEGER NOT NULL DEFAULT 0)`,
      'CREATE INDEX IF NOT EXISTS idx_telemetry_live_key ON telemetry_keys(id) WHERE revoked_at IS NULL',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_key_cleanup ON telemetry_keys(revoked_at,id) WHERE revoked_at IS NOT NULL AND cleanup_done=0',
      `CREATE TABLE IF NOT EXISTS telemetry_totals(id INTEGER PRIMARY KEY CHECK(id=1),spans INTEGER NOT NULL DEFAULT 0,source_revision INTEGER NOT NULL DEFAULT 0,keys INTEGER NOT NULL DEFAULT 0,work_due INTEGER,wake_revision INTEGER NOT NULL DEFAULT 0)`,
      'INSERT OR IGNORE INTO telemetry_totals(id) VALUES(1)',
      `CREATE TABLE IF NOT EXISTS telemetry_traces(key_id TEXT NOT NULL REFERENCES telemetry_keys(id),trace_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,last_received_at INTEGER NOT NULL,next_check INTEGER,revision INTEGER NOT NULL,spans INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(key_id,trace_id)) WITHOUT ROWID`,
      'CREATE INDEX IF NOT EXISTS idx_telemetry_trace_empty ON telemetry_traces(trace_id) WHERE spans=0',
      `CREATE TABLE IF NOT EXISTS telemetry_spans(trace_id TEXT NOT NULL,span_id TEXT NOT NULL,key_id TEXT NOT NULL REFERENCES telemetry_keys(id),
      parent_span_id TEXT,name TEXT NOT NULL,kind INTEGER NOT NULL,service_name TEXT,service_version TEXT,
      start_ns TEXT NOT NULL,end_ns TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,
      conversation_id TEXT,agent_name TEXT,operation TEXT,attributes TEXT NOT NULL,status INTEGER NOT NULL,received_at INTEGER NOT NULL,receipt_newest_ms INTEGER,
      PRIMARY KEY(key_id,trace_id,span_id)) WITHOUT ROWID`,
      'CREATE INDEX IF NOT EXISTS idx_telemetry_spans_key_trace ON telemetry_spans(key_id,trace_id,span_id)',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_spans_expiry ON telemetry_spans(received_at,trace_id,span_id)',
      `CREATE TABLE IF NOT EXISTS telemetry_resolutions(trace_id TEXT NOT NULL,span_id TEXT NOT NULL,key_id TEXT NOT NULL REFERENCES telemetry_keys(id),
      project_id TEXT NOT NULL CHECK(${projectIdGrammar('project_id')}),session_id TEXT NOT NULL,parent_project_id TEXT CHECK(parent_project_id IS NULL OR (${projectIdGrammar('parent_project_id')})),parent_session_id TEXT,parent_span_id TEXT,
      repository TEXT,ref TEXT,agent_name TEXT,service_name TEXT,reported_at INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL DEFAULT 0,
      matched_by TEXT NOT NULL CHECK(matched_by IN ('exact','inferred')),invocation INTEGER NOT NULL CHECK(invocation IN (0,1)),
      PRIMARY KEY(key_id,trace_id,span_id),FOREIGN KEY(key_id,trace_id,span_id) REFERENCES telemetry_spans(key_id,trace_id,span_id) ON DELETE CASCADE,
      FOREIGN KEY(key_id,trace_id,parent_span_id) REFERENCES telemetry_spans(key_id,trace_id,span_id) ON DELETE CASCADE,
      FOREIGN KEY(project_id,session_id) REFERENCES sessions(project_id,session_id) ON DELETE CASCADE,
      FOREIGN KEY(parent_project_id,parent_session_id) REFERENCES sessions(project_id,session_id) ON DELETE CASCADE) WITHOUT ROWID`,
      'CREATE INDEX IF NOT EXISTS idx_telemetry_invocation_window ON telemetry_resolutions(project_id,session_id,started_at,trace_id,span_id,key_id) WHERE invocation=1',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_resolutions_session ON telemetry_resolutions(project_id,session_id,matched_by,trace_id,span_id)',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_resolutions_invoker ON telemetry_resolutions(key_id,parent_project_id,parent_session_id,agent_name,repository,ref,project_id,session_id)',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_resolutions_links ON telemetry_resolutions(project_id,session_id,matched_by,trace_id,span_id) WHERE parent_session_id IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_resolutions_parent ON telemetry_resolutions(parent_project_id,parent_session_id,project_id,session_id)',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_resolutions_ancestor ON telemetry_resolutions(key_id,trace_id,parent_span_id)',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_resolution_newest ON telemetry_resolutions(key_id,project_id,session_id,matched_by,reported_at DESC,started_at DESC,trace_id DESC,span_id DESC) WHERE parent_session_id IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_resolutions_key ON telemetry_resolutions(key_id,trace_id,span_id)',
      `CREATE TABLE IF NOT EXISTS telemetry_counts(key_id TEXT NOT NULL REFERENCES telemetry_keys(id),hour INTEGER NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0,rejected INTEGER NOT NULL DEFAULT 0,logs INTEGER NOT NULL DEFAULT 0,metrics INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(key_id,hour)) WITHOUT ROWID`,
      'CREATE INDEX IF NOT EXISTS idx_telemetry_counts_expiry ON telemetry_counts(hour,key_id)',
      `CREATE TRIGGER IF NOT EXISTS telemetry_count_added AFTER INSERT ON telemetry_counts BEGIN
      UPDATE telemetry_totals SET work_due=NEW.hour*${TELEMETRY_HOUR_MS}+${TELEMETRY_DAY_MS}+${TELEMETRY_HOUR_MS} WHERE id=1
      AND (work_due IS NULL OR work_due>NEW.hour*${TELEMETRY_HOUR_MS}+${TELEMETRY_DAY_MS}+${TELEMETRY_HOUR_MS}); END`,
      ...TELEMETRY_WORK_DDL,
      ...TELEMETRY_REPORT_DDL,
      `CREATE TRIGGER IF NOT EXISTS telemetry_key_added AFTER INSERT ON telemetry_keys BEGIN UPDATE telemetry_totals SET keys=keys+1 WHERE id=1; END`,
      `CREATE TRIGGER IF NOT EXISTS telemetry_key_removed AFTER DELETE ON telemetry_keys BEGIN UPDATE telemetry_totals SET keys=keys-1 WHERE id=1; END`,
      `CREATE TRIGGER IF NOT EXISTS telemetry_key_revoked AFTER UPDATE OF revoked_at ON telemetry_keys WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN UPDATE telemetry_totals SET work_due=0 WHERE id=1; END`,
      `CREATE TRIGGER IF NOT EXISTS telemetry_span_added AFTER INSERT ON telemetry_spans BEGIN
      UPDATE telemetry_totals SET spans=spans+1,wake_revision=wake_revision+(work_due IS NOT 0),work_due=0 WHERE id=1;
      UPDATE telemetry_keys SET spans=spans+1,clock_skew_ms=NEW.received_at-COALESCE(NEW.receipt_newest_ms,NEW.end_ms) WHERE id=NEW.key_id;
      ${telemetryKeyUseSql('NEW.key_id', 'NEW.received_at')};
      INSERT INTO telemetry_traces(key_id,trace_id,received_at,last_received_at,next_check,revision,spans) VALUES(NEW.key_id,NEW.trace_id,NEW.received_at,NEW.received_at,NULL,1,1)
        ON CONFLICT(key_id,trace_id) DO UPDATE SET last_received_at=MAX(last_received_at,NEW.received_at),revision=revision+1,spans=spans+1;
      INSERT INTO telemetry_trace_keys(trace_id,key_id,spans,next_check) VALUES(NEW.trace_id,NEW.key_id,1,0)
        ON CONFLICT(trace_id,key_id) DO UPDATE SET spans=spans+1;
      UPDATE telemetry_trace_keys SET next_check=0 WHERE trace_id=NEW.trace_id AND key_id=NEW.key_id AND (next_check IS NULL OR next_check>0);
      INSERT INTO telemetry_counts(key_id,hour,accepted) VALUES(NEW.key_id,NEW.received_at/3600000,1)
      ON CONFLICT(key_id,hour) DO UPDATE SET accepted=accepted+1; END`,
      `CREATE TRIGGER IF NOT EXISTS telemetry_span_removed AFTER DELETE ON telemetry_spans BEGIN
      UPDATE telemetry_totals SET spans=spans-1,work_due=0 WHERE id=1;
      UPDATE telemetry_keys SET spans=spans-1 WHERE id=OLD.key_id;
      UPDATE telemetry_trace_keys SET spans=spans-1 WHERE trace_id=OLD.trace_id AND key_id=OLD.key_id;
      UPDATE telemetry_traces SET revision=revision+1,spans=spans-1 WHERE trace_id=OLD.trace_id AND key_id=OLD.key_id;
      UPDATE telemetry_trace_keys SET next_check=0 WHERE trace_id=OLD.trace_id AND key_id=OLD.key_id AND (next_check IS NULL OR next_check>0); END`,
    ],
    reaches: reaching(
      ['sessions', 'session_prompts', 'session_documents', 'project_remotes', 'session_tombstones'],
      'Capture publishes indexed telemetry dependency notifications.',
    ),
    deploymentIndexes: [
      {
        index: 'idx_telemetry_live_key',
        read: 'Issuance and ingestion count only the at most eight live keys when admitting a key or computing its current quota.',
      },
      {
        index: 'idx_telemetry_resolution_newest',
        read: 'A key selects its latest strongest report for one canonical child.',
      },
      {
        index: 'idx_telemetry_key_cleanup',
        read: 'Housekeeping selects the next revoked key without reading retired key history.',
      },
      {
        index: 'idx_telemetry_report_parent',
        read: 'Lineage seeks bounded report profiles for one parent without scanning invocation history.',
      },
      {
        index: 'idx_telemetry_partition_empty',
        read: 'Housekeeping retires bounded empty work partitions without scanning retained spans.',
      },
      {
        index: 'idx_telemetry_trace_empty',
        read: 'Housekeeping retires a bounded page of empty traces without reading held traces.',
      },
      {
        index: 'idx_telemetry_trace_keys_key',
        read: 'Revocation retires only one key’s bounded work partitions.',
      },
      {
        index: 'idx_telemetry_dependency_id',
        read: 'Capture finds traces depending on a canonical conversation id.',
      },
      {
        index: 'idx_telemetry_dependency_window',
        read: 'Capture seeks dependency windows by repository, ref and time.',
      },
      {
        index: 'idx_telemetry_trace_key_due',
        read: 'The wake reads the next bounded page of trace reconciliation deadlines.',
      },
      {
        index: 'idx_telemetry_spans_expiry',
        read: 'Housekeeping retires a bounded page of expired spans across the Deployment.',
      },
      {
        index: 'idx_telemetry_counts_expiry',
        read: 'Housekeeping and Settings seek the rolling telemetry counter window.',
      },
      {
        index: 'idx_telemetry_resolutions_invoker',
        read: 'A later invocation seeks the unique session already linked to this lead, agent, repository and ref across Projects.',
      },
      {
        index: 'idx_telemetry_resolutions_parent',
        read: 'A lineage finds telemetry children across Projects by the canonical parent pair.',
      },
    ],
  },
  {
    version: NEXT_TELEMETRY + 1,
    statements: ['CREATE INDEX IF NOT EXISTS idx_sessions_telemetry_id ON sessions(session_id,project_id)'],
    reaches: reaching(
      ['sessions'],
      'An exported conversation id resolves across Projects without scanning sessions.',
    ),
    deploymentIndexes: [
      {
        index: 'idx_sessions_telemetry_id',
        read: 'An exported conversation id resolves only when exactly one live session in the Deployment holds it.',
      },
    ],
  },
  {
    version: NEXT_TELEMETRY + 2,
    statements: [
      'CREATE INDEX IF NOT EXISTS idx_sessions_telemetry_start ON sessions(project_id,branch,started_at,session_id)',
    ],
    reaches: reaching(
      ['sessions'],
      'Inference seeks session starts in one repository, branch and time window.',
    ),
  },
  {
    version: NEXT_TELEMETRY + 3,
    statements: [
      'CREATE INDEX IF NOT EXISTS idx_session_prompts_telemetry_time ON session_prompts(project_id,created_at,session_id,generation,prompt_id) WHERE turn_key=prompt_id',
    ],
    reaches: reaching(['session_prompts'], 'Inference seeks a bounded turn-start window in a Project.'),
  },
];
