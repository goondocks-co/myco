import { archivedEventPayloadSql, documentRecordIdSql, eventPayloadFieldSql, liveDocumentPromptSql, documentPromptUnreadSql, sessionDocumentUnreadSql } from './document-tables.js';
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

export const RETIRED_CONTENT_TRIGGERS = [
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

/** Admission is repeated before the destructive transactions. */
const documentGuard: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _v117_documents_guard (missing INTEGER NOT NULL CONSTRAINT "documents_retirement_incomplete: verify missing document records, body mismatches or unpromoted plans on the previous release" CHECK (missing=0))`,
  `INSERT INTO _v117_documents_guard
    WITH retained AS (SELECT project_id,session_id FROM prompt_batches UNION SELECT project_id,session_id FROM responses
      UNION SELECT project_id,session_id FROM tool_calls UNION SELECT project_id,session_id FROM session_documents WHERE state<>'live')
    SELECT COUNT(*) FROM retained r WHERE NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=r.project_id AND t.session_id=r.session_id)
      AND (NOT EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=r.project_id AND s.session_id=r.session_id)
        OR NOT EXISTS (SELECT 1 FROM session_documents d WHERE d.project_id=r.project_id AND d.session_id=r.session_id AND d.state='live'))`,
  `INSERT INTO _v117_documents_guard SELECT COUNT(*) FROM session_documents d
    WHERE NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)
      AND (d.build IS NOT NULL AND NOT json_valid(d.build) OR EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(d.build) THEN d.build ELSE '{}' END,'$.report.classes') c
        WHERE c.value>0 AND (c.key GLOB 'ids_differ:*'
          OR c.key GLOB 'body_differs:*' OR c.key GLOB 'plan_not_promoted*')))`,
  `DROP TABLE _v117_documents_guard`,
];
const emptyDocuments =
`UPDATE session_documents SET state='live',generation=COALESCE(generation,1),due_at=0 WHERE state='convert' AND prompts=0 AND replies=0 AND tool_calls=0 AND plans=0 AND attachments=0
    AND NOT EXISTS(SELECT 1 FROM session_chunks c WHERE c.project_id=session_documents.project_id AND c.session_id=session_documents.session_id)
    AND NOT EXISTS(SELECT 1 FROM prompt_batches p WHERE p.project_id=session_documents.project_id AND p.session_id=session_documents.session_id)
    AND NOT EXISTS(SELECT 1 FROM responses r WHERE r.project_id=session_documents.project_id AND r.session_id=session_documents.session_id)
    AND NOT EXISTS(SELECT 1 FROM tool_calls t WHERE t.project_id=session_documents.project_id AND t.session_id=session_documents.session_id)
    AND NOT EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=session_documents.project_id AND t.session_id=session_documents.session_id AND t.size>0)`;
const clearableStopWake =
`UPDATE session_documents SET due_at = 0 WHERE state = 'live' AND due_at IS NULL AND (project_id, session_id, generation) IN
    (SELECT project_id, session_id, generation FROM transcript_publication WHERE state = 'failed' AND failure IN ('blob_absent', 'receipt_absent'))`;

/** Archiving retains compact identity and blob metadata throughout retirement. */
const archiveMetadataGuard = `CREATE TRIGGER IF NOT EXISTS retirement_archive_metadata BEFORE UPDATE OF payload,payload_format ON events
  WHEN OLD.payload_format='inline' AND NEW.payload_format='archived' AND NEW.kind IN ('prompt','response','tool.use','tool.failure')
    AND EXISTS (SELECT 1 FROM json_each(${archivedEventPayloadSql('OLD.')}) old_field
      JOIN json_each(${archivedEventPayloadSql('NEW.')}) new_field ON old_field.key=new_field.key
      WHERE old_field.value IS NOT NULL AND old_field.value IS NOT new_field.value)
  BEGIN SELECT RAISE(ABORT,'retirement_archive_metadata_required'); END`;

const TOOL_BACKFILL_PARTITIONS = 32;
const backfillSources = [
    {table:'prompt_batches',id:'prompt_id',field:'promptId',blob:'blob_key',kinds:"'prompt'"},
    {table:'responses',id:'response_id',field:'responseId',blob:'blob_key',kinds:"'response'"},
    {table:'tool_calls',id:'tool_call_id',field:'toolCallId',blob:'input_blob_key',kinds:"'tool.use','tool.failure'"},
  ] as const;
const backfill = ({table,id,field,blob,kinds}: (typeof backfillSources)[number], partition?: number) =>`WITH backfill AS MATERIALIZED (
      SELECT p.project_id,p.event_id,json_set(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,
        '$.${field}',COALESCE(${eventPayloadFieldSql(field,'e.')},p.${id}),
        '$.blob',COALESCE(${eventPayloadFieldSql('blob','e.')},p.${blob})${table==='tool_calls'?`,
        '$.outputBlob',COALESCE(${eventPayloadFieldSql('outputBlob','e.')},p.output_blob_key)`:''}) payload
      FROM ${table} p CROSS JOIN events e
      WHERE e.project_id=p.project_id AND e.event_id=p.event_id AND e.kind IN (${kinds}) AND e.payload_format='archived'${partition===undefined?'':` AND p.rowid % ${TOOL_BACKFILL_PARTITIONS} = ${partition}`})
    UPDATE events AS e SET payload=b.payload FROM backfill b WHERE e.project_id=b.project_id AND e.event_id=b.event_id`;

const largeTables = new Set<string>([
  'prompt_batches', 'responses', 'tool_calls', 'view_tool_calls', 'fact_classes',
  'material_versions', 'view_content_proofs', 'view_prompts', 'view_responses',
]);
const isolatedDrop = (table: string) => largeTables.has(table) || table.endsWith('_fts');
const dropTable = (table: string) => `DROP TABLE IF EXISTS ${table}`;

/** Each step is one transaction; backfills and index builds finish before any retained source is dropped. */
export const RETIREMENT_SCHEMA_STEPS = [
  [documentGuard[0]!, emptyDocuments, ...documentGuard.slice(1), clearableStopWake, archiveMetadataGuard],
  ...backfillSources.slice(0, 2).map(source => [backfill(source)]),
  ...Array.from({length: TOOL_BACKFILL_PARTITIONS}, (_, partition) => [backfill(backfillSources[2], partition)]),
  [`CREATE INDEX IF NOT EXISTS idx_events_record_identity ON events(project_id,${documentRecordIdSql()}) WHERE kind IN ('prompt','response','tool.use','tool.failure')`],
  [`CREATE INDEX IF NOT EXISTS idx_events_payload_blob ON events(project_id,${eventPayloadFieldSql('blob')}) WHERE ${eventPayloadFieldSql('blob')} IS NOT NULL`],
  [`CREATE INDEX IF NOT EXISTS idx_events_payload_output_blob ON events(project_id,${eventPayloadFieldSql('outputBlob')}) WHERE ${eventPayloadFieldSql('outputBlob')} IS NOT NULL`],
  documentGuard,
  RETIRED_CONTENT_TRIGGERS.map(name => `DROP TRIGGER IF EXISTS ${name}`),
  ...RETIRED_CONTENT_TABLES.filter(isolatedDrop).map(table => [dropTable(table)]),
  RETIRED_CONTENT_TABLES.filter(table => !isolatedDrop(table)).map(dropTable),
  [
    `UPDATE raw_provenance_backfill SET source=0,cursor_project='',cursor_id='' WHERE complete=0`,
    'ALTER TABLE transcript_publication ADD COLUMN diagnostic TEXT',
    'DROP TRIGGER retirement_archive_metadata',
    ...documentCounters,
  ],
].map((statements, index) => ({version: 117 + index, statements}));
