import { documentRecordIdSql, liveDocumentPromptSql, documentPromptUnreadSql, sessionDocumentUnreadSql } from './document-tables.js';
/** Content relations retired after every session has a live document. */
export const RETIRED_CONTENT_TABLES = [
  "prompt_batches",
  "tool_calls",
  "responses",
  "transcript_parser_state_chunks",
  "prompt_key_owners",
  "view_visible",
  "view_checkpoint_chunks",
  "view_checkpoints",
  "view_key_owners",
  "view_prompts",
  "view_responses",
  "view_tool_calls",
  "view_plans",
  "view_content_proofs",
  "view_findings",
  "fact_classes",
  "plan_promotions",
  "view_prompts_fts",
  "view_responses_fts",
  "view_plans_fts",
  "material_versions",
  "view_publication_material",
  "view_build_work",
  "view_legacy_ack_feed",
  "view_flip_calibrations",
  "view_work_samples",
  "learning_init_queue",
  "cutover_progress",
  "prompt_batches_fts",
  "responses_fts",
  "session_views",
  "view_instances"
] as const;

const retiredTriggers = [
  "clear_inline_parser_chunks",
  "extraction_acks_session_read_insert",
  "plans_legacy_class_insert",
  "plans_legacy_class_update",
  "tags_plan_legacy_class_insert",
  "tags_plan_legacy_class_delete"
] as const;

const promptCounter = (row: string, delta: number) => `UPDATE session_read_facts SET eligible_prompts=eligible_prompts+(${delta})
  WHERE project_id=${row}.project_id AND session_id=${row}.session_id AND ${liveDocumentPromptSql(row)} AND ${documentPromptUnreadSql(row)};`;
const recount = (row: string) => `UPDATE session_read_facts SET eligible_prompts=${sessionDocumentUnreadSql(`${row}.project_id`,`${row}.session_id`)}
  WHERE project_id=${row}.project_id AND session_id=${row}.session_id;`;
const documentCounters = [
  `CREATE TRIGGER IF NOT EXISTS session_prompts_unread_insert AFTER INSERT ON session_prompts BEGIN ${promptCounter('NEW',1)} END`,
  `CREATE TRIGGER IF NOT EXISTS session_prompts_unread_delete AFTER DELETE ON session_prompts BEGIN ${promptCounter('OLD',-1)} END`,
  `CREATE TRIGGER IF NOT EXISTS session_prompts_unread_update AFTER UPDATE OF project_id,session_id,generation,prompt_id,origin ON session_prompts
    BEGIN ${promptCounter('OLD',-1)} ${promptCounter('NEW',1)} END`,
  `CREATE TRIGGER IF NOT EXISTS session_documents_unread_insert AFTER INSERT ON session_documents BEGIN ${recount('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS session_documents_unread_delete AFTER DELETE ON session_documents BEGIN ${recount('OLD')} END`,
  `CREATE TRIGGER IF NOT EXISTS session_documents_unread_update AFTER UPDATE OF generation,state ON session_documents BEGIN ${recount('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS extraction_acks_session_read_insert AFTER INSERT ON extraction_acks WHEN NEW.kind='record'
    BEGIN UPDATE session_read_facts SET eligible_prompts=eligible_prompts-1 WHERE project_id=NEW.project_id AND session_id=NEW.session_id
      AND EXISTS (SELECT 1 FROM session_prompts p WHERE p.project_id=NEW.project_id AND p.session_id=NEW.session_id AND p.prompt_id=NEW.record_id
        AND ${liveDocumentPromptSql('p')} AND ${documentPromptUnreadSql('p','NEW.ack_id')}); END`,
  `CREATE TRIGGER IF NOT EXISTS extraction_acks_session_read_delete AFTER DELETE ON extraction_acks WHEN OLD.kind='record'
    BEGIN UPDATE session_read_facts SET eligible_prompts=eligible_prompts+1 WHERE project_id=OLD.project_id AND session_id=OLD.session_id
      AND EXISTS (SELECT 1 FROM session_prompts p WHERE p.project_id=OLD.project_id AND p.session_id=OLD.session_id AND p.prompt_id=OLD.record_id
        AND ${liveDocumentPromptSql('p')} AND ${documentPromptUnreadSql('p')}); END`,
  `UPDATE session_read_facts SET eligible_prompts=${sessionDocumentUnreadSql('session_read_facts.project_id','session_read_facts.session_id')}`,
];

/** Retained content must be published before its relational source can be removed. */
export const V117_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _v117_documents_guard (missing INTEGER NOT NULL CONSTRAINT documents_retirement_incomplete CHECK (missing=0))`,
  `UPDATE session_documents SET state='live',generation=COALESCE(generation,1),due_at=0 WHERE state='convert' AND prompts=0 AND replies=0 AND tool_calls=0 AND plans=0 AND attachments=0
    AND NOT EXISTS(SELECT 1 FROM session_chunks c WHERE c.project_id=session_documents.project_id AND c.session_id=session_documents.session_id)
    AND NOT EXISTS(SELECT 1 FROM prompt_batches p WHERE p.project_id=session_documents.project_id AND p.session_id=session_documents.session_id)
    AND NOT EXISTS(SELECT 1 FROM responses r WHERE r.project_id=session_documents.project_id AND r.session_id=session_documents.session_id)
    AND NOT EXISTS(SELECT 1 FROM tool_calls t WHERE t.project_id=session_documents.project_id AND t.session_id=session_documents.session_id)
    AND NOT EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=session_documents.project_id AND t.session_id=session_documents.session_id AND t.size>0)`,
  `INSERT INTO _v117_documents_guard SELECT COUNT(*) FROM sessions s
    WHERE NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=s.project_id AND t.session_id=s.session_id)
      AND (EXISTS (SELECT 1 FROM prompt_batches p WHERE p.project_id=s.project_id AND p.session_id=s.session_id)
        OR EXISTS (SELECT 1 FROM responses r WHERE r.project_id=s.project_id AND r.session_id=s.session_id)
        OR EXISTS (SELECT 1 FROM tool_calls c WHERE c.project_id=s.project_id AND c.session_id=s.session_id)
        OR EXISTS (SELECT 1 FROM session_documents d WHERE d.project_id=s.project_id AND d.session_id=s.session_id AND d.state<>'live'))
      AND NOT EXISTS (SELECT 1 FROM session_documents d WHERE d.project_id=s.project_id AND d.session_id=s.session_id AND d.state='live')`,
  `DROP TABLE _v117_documents_guard`,
  `UPDATE events SET payload=json_set(payload,'$.promptId',(SELECT prompt_id FROM prompt_batches p WHERE p.project_id=events.project_id AND p.event_id=events.event_id))
    WHERE kind='prompt' AND payload_format='archived' AND json_extract(payload,'$.promptId') IS NULL`,
  `UPDATE events SET payload=json_set(payload,'$.responseId',(SELECT response_id FROM responses r WHERE r.project_id=events.project_id AND r.event_id=events.event_id))
    WHERE kind='response' AND payload_format='archived' AND json_extract(payload,'$.responseId') IS NULL`,
  `UPDATE events SET payload=json_set(payload,'$.toolCallId',(SELECT tool_call_id FROM tool_calls t WHERE t.project_id=events.project_id AND t.event_id=events.event_id))
    WHERE kind IN ('tool.use','tool.failure') AND payload_format='archived' AND json_extract(payload,'$.toolCallId') IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_events_record_identity ON events(project_id,${documentRecordIdSql()}) WHERE kind IN ('prompt','response','tool.use','tool.failure')`,
  `CREATE INDEX IF NOT EXISTS idx_events_payload_blob ON events(project_id,json_extract(payload,'$.blob')) WHERE json_extract(payload,'$.blob') IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_events_payload_output_blob ON events(project_id,json_extract(payload,'$.outputBlob')) WHERE json_extract(payload,'$.outputBlob') IS NOT NULL`,
  ...retiredTriggers.map((name) => `DROP TRIGGER IF EXISTS ${name}`),
  ...RETIRED_CONTENT_TABLES.map((name) => `DROP TABLE IF EXISTS ${name}`),
  `UPDATE raw_provenance_backfill SET source=0,cursor_project='',cursor_id='' WHERE complete=0`,
  'ALTER TABLE transcript_publication ADD COLUMN diagnostic TEXT',
  `CREATE INDEX IF NOT EXISTS idx_transcript_publication_failed ON transcript_publication(project_id,failure,updated_at) WHERE state='failed'`,
  ...documentCounters,
];
