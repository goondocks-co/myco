import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { DOCUMENT_PREVIEW_CHARS } from './document-tables.js';

const project = `project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR})`;

/**
 * Session documents: the catalog of per-session documents held in the blob store, the publisher's own progress per
 * transcript, and its queue of member events. A session present before this step waits for conversion (`convert`);
 * a session whose first transcript or queued event arrives after it is published from its first byte. A transcript
 * that arrives or grows makes its live session due.
 */
export const V111_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_documents (${project}, session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('convert','live')), generation INTEGER, build TEXT,
    prompts INTEGER NOT NULL DEFAULT 0, user_prompts INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0, failed_tools INTEGER NOT NULL DEFAULT 0, plans INTEGER NOT NULL DEFAULT 0,
    attachments INTEGER NOT NULL DEFAULT 0,
    first_prompt TEXT CHECK (first_prompt IS NULL OR length(first_prompt) <= ${DOCUMENT_PREVIEW_CHARS}),
    last_record_at INTEGER, open_turn_key TEXT, next_chunk INTEGER NOT NULL DEFAULT 0, due_at INTEGER,
    updated_at INTEGER NOT NULL, PRIMARY KEY (project_id, session_id))`,
  `CREATE INDEX IF NOT EXISTS idx_session_documents_due ON session_documents (due_at) WHERE due_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS session_chunks (${project}, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    chunk_no INTEGER NOT NULL, blob_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('page','body')),
    encoding TEXT NOT NULL CHECK (encoding IN ('gzip-ndjson','identity')), bytes INTEGER NOT NULL,
    source_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('building','live')),
    PRIMARY KEY (project_id, session_id, generation, chunk_no))`,
  `CREATE INDEX IF NOT EXISTS idx_session_chunks_blob ON session_chunks (project_id, blob_key)`,
  `CREATE TABLE IF NOT EXISTS retired_objects (${project}, session_id TEXT NOT NULL, blob_key TEXT NOT NULL,
    source_id TEXT NOT NULL, retired_at INTEGER NOT NULL, PRIMARY KEY (project_id, session_id, blob_key, source_id))`,
  `CREATE INDEX IF NOT EXISTS idx_retired_objects_blob ON retired_objects (project_id, blob_key)`,
  `CREATE INDEX IF NOT EXISTS idx_retired_objects_at ON retired_objects (retired_at)`,
  `CREATE TABLE IF NOT EXISTS session_pages (${project}, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    owner TEXT NOT NULL, page INTEGER NOT NULL, chunk_no INTEGER NOT NULL, records INTEGER NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id, generation, owner, page))`,
  `CREATE TABLE IF NOT EXISTS session_prompts (${project}, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    prompt_id TEXT NOT NULL, turn_key TEXT, parent_hint TEXT, ord INTEGER NOT NULL, origin TEXT, prompt_kind TEXT,
    thread_label TEXT, created_at INTEGER NOT NULL, claim TEXT, source_key TEXT, prompt_key_hash TEXT,
    preview TEXT CHECK (preview IS NULL OR length(preview) <= ${DOCUMENT_PREVIEW_CHARS}), text_chars INTEGER,
    tools INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0, children INTEGER NOT NULL DEFAULT 0,
    plans INTEGER NOT NULL DEFAULT 0, attachments INTEGER NOT NULL DEFAULT 0, input_hash TEXT, input_chars INTEGER,
    PRIMARY KEY (project_id, session_id, generation, prompt_id))`,
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_turns ON session_prompts (project_id, session_id, generation, ord)
    WHERE turn_key = prompt_id`,
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_turn ON session_prompts (project_id, session_id, generation, turn_key)`,
  `CREATE TABLE IF NOT EXISTS transcript_publication (${project}, transcript_id TEXT NOT NULL, generation INTEGER NOT NULL,
    session_id TEXT NOT NULL, published_offset INTEGER NOT NULL DEFAULT 0, segment_lines INTEGER, open_prompt_id TEXT,
    unfinished INTEGER NOT NULL DEFAULT 0 CHECK (unfinished IN (0,1)),
    reply_unfinished INTEGER NOT NULL DEFAULT 0 CHECK (reply_unfinished IN (0,1)), reply_latest_at INTEGER,
    prompt_scheme TEXT, record_scheme TEXT NOT NULL, parser_version INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','awaiting','failed')), failure TEXT,
    awaited_size INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (project_id, transcript_id, generation))`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_publication_session ON transcript_publication (project_id, session_id, generation)`,
  `CREATE TABLE IF NOT EXISTS publish_queue (${project}, session_id TEXT NOT NULL, event_id TEXT NOT NULL,
    queued_at INTEGER NOT NULL, PRIMARY KEY (project_id, session_id, event_id))`,
  `CREATE INDEX IF NOT EXISTS idx_publish_queue_at ON publish_queue (queued_at)`,
  `CREATE TABLE IF NOT EXISTS session_paths (${project}, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    path TEXT NOT NULL, tool_calls INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id, generation, path))`,
  `CREATE TABLE IF NOT EXISTS myco_tool_calls (${project}, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    tool_call_id TEXT NOT NULL, myco_tool TEXT NOT NULL, myco_op TEXT, success INTEGER NOT NULL CHECK (success IN (0,1)),
    created_at INTEGER NOT NULL, harness TEXT, PRIMARY KEY (project_id, session_id, generation, tool_call_id))`,
  `CREATE INDEX IF NOT EXISTS idx_myco_tool_calls_at ON myco_tool_calls (project_id, created_at)`,
  `INSERT OR IGNORE INTO session_documents (project_id, session_id, state, updated_at)
    SELECT project_id, session_id, 'convert', CAST(unixepoch() * 1000 AS INTEGER) FROM sessions`,
  `CREATE TRIGGER IF NOT EXISTS transcripts_document_insert AFTER INSERT ON transcripts BEGIN
    INSERT OR IGNORE INTO session_documents (project_id, session_id, state, generation, updated_at)
      VALUES (NEW.project_id, NEW.session_id, 'live', 1, NEW.last_received_at);
    UPDATE session_documents SET due_at = 0
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id AND state = 'live' AND due_at IS NOT 0; END`,
  `CREATE TRIGGER IF NOT EXISTS transcripts_document_size AFTER UPDATE OF size ON transcripts WHEN NEW.size <> OLD.size BEGIN
    UPDATE session_documents SET due_at = 0
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id AND state = 'live' AND due_at IS NOT 0; END`,
];
