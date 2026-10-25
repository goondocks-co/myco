import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { promptSessionReadTriggers } from './read-budget-session-statements.js';
import { unreadPromptSql } from './session-read-model.js';
import { ACTIVE_EXTRACTION_CANDIDATE_SQL } from './session-read-model.js';

/** Durable extraction acknowledgements and constant-cost unread contributions. */
export const V98_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_session_read_unread ON session_read_facts
    (project_id,(live_transcripts > 0) DESC,ended_at DESC,session_id DESC) WHERE ${ACTIVE_EXTRACTION_CANDIDATE_SQL}`,
  `CREATE TABLE IF NOT EXISTS extraction_acks (
     project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     ack_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('source', 'record')),
     source_transcript_id TEXT,
     source_offset INTEGER,
     source_end INTEGER,
     record_id TEXT,
     served_id TEXT,
     run_id TEXT NOT NULL,
     acknowledged_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, ack_id),
     CHECK ((kind = 'record' AND record_id IS NOT NULL AND source_transcript_id IS NULL AND source_offset IS NULL AND source_end IS NULL)
       OR (kind = 'source' AND record_id IS NULL AND source_transcript_id IS NOT NULL AND source_offset IS NOT NULL AND source_end IS NOT NULL AND source_end > source_offset)))`,
  `CREATE INDEX IF NOT EXISTS idx_extraction_acks_source ON extraction_acks (project_id, source_transcript_id, source_offset, source_end)`,
  `CREATE INDEX IF NOT EXISTS idx_extraction_acks_record ON extraction_acks (project_id, record_id)`,
  `CREATE INDEX IF NOT EXISTS idx_extraction_acks_session ON extraction_acks (project_id, session_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_extraction_acks_served ON extraction_acks (project_id, served_id)`,
  ...['insert', 'update', 'delete'].map(operation => `DROP TRIGGER IF EXISTS prompt_batches_session_read_${operation}`),
  ...promptSessionReadTriggers(),
  `CREATE TRIGGER IF NOT EXISTS extraction_acks_session_read_insert AFTER INSERT ON extraction_acks
    WHEN NEW.kind = 'record' BEGIN
    UPDATE session_read_facts SET eligible_prompts = eligible_prompts - 1
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id
        AND EXISTS (SELECT 1 FROM prompt_batches p WHERE p.project_id = NEW.project_id
          AND p.session_id = NEW.session_id AND p.prompt_id = NEW.record_id AND ${unreadPromptSql('p', { exceptAck: 'NEW.ack_id' })}); END`,
  `CREATE TRIGGER IF NOT EXISTS extraction_acks_immutable BEFORE UPDATE ON extraction_acks BEGIN
    SELECT RAISE(ABORT, 'extraction acknowledgements are immutable'); END`,
];
