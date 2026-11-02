import { EVENT_REFERENCE_COLUMNS, eventReferenceUpdates } from './event-references.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { documentRecordIdSql, eventPayloadFieldSql, liveDocumentPromptSql, documentPromptUnreadSql, sessionDocumentUnreadSql } from './document-tables.js';
/** Step 172 drops the triggers that read or write the relational content tables. */
const LEGACY_CONTENT_TRIGGERS = [
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

const references = (alias: string, old?: string) => [documentRecordIdSql(alias),eventPayloadFieldSql('blob',alias),eventPayloadFieldSql('outputBlob',alias)]
  .map((value,index)=>old===undefined?value:`COALESCE(${value},${[documentRecordIdSql(old),eventPayloadFieldSql('blob',old),eventPayloadFieldSql('outputBlob',old)][index]})`);
const captureReferences = (old?: string) => {
  const fields=references('NEW.',old);
  return `INSERT INTO event_refs (${EVENT_REFERENCE_COLUMNS}) SELECT NEW.project_id,NEW.event_id,NEW.session_id,NEW.kind,${fields.join(',')}
    WHERE NEW.kind IN ('prompt','response','tool.use','tool.failure')
    ON CONFLICT(project_id,event_id) DO UPDATE SET session_id=excluded.session_id,kind=excluded.kind,
      ${eventReferenceUpdates(false)};`;
};
const referenceSchema = [
  `CREATE TABLE IF NOT EXISTS event_refs (project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),event_id TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,
    record_id TEXT,blob TEXT,output_blob TEXT,PRIMARY KEY(project_id,event_id))`,
  `CREATE INDEX IF NOT EXISTS idx_event_refs_identity ON event_refs(project_id,record_id,session_id,kind) WHERE record_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_event_refs_blob ON event_refs(project_id,blob) WHERE blob IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_event_refs_output_blob ON event_refs(project_id,output_blob) WHERE output_blob IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_event_refs_session ON event_refs(project_id,session_id,kind,record_id)`,
  `CREATE TRIGGER IF NOT EXISTS events_refs_insert AFTER INSERT ON events BEGIN ${captureReferences()} END`,
  `CREATE TRIGGER IF NOT EXISTS events_refs_update AFTER UPDATE OF payload ON events BEGIN ${captureReferences('OLD.')} END`,
  `CREATE TRIGGER IF NOT EXISTS events_refs_delete AFTER DELETE ON events BEGIN DELETE FROM event_refs WHERE project_id=OLD.project_id AND event_id=OLD.event_id; END`,
];
const rangeSources = [
  {table:'tool_calls',parts:64,id:'tool_call_id',field:'toolCallId',blob:'input_blob_key',kinds:"'tool.use','tool.failure'"},
  {table:'prompt_batches',parts:4,id:'prompt_id',field:'promptId',blob:'blob_key',kinds:"'prompt'"},
  {table:'responses',parts:4,id:'response_id',field:'responseId',blob:'blob_key',kinds:"'response'"},
  {table:'events',parts:64},
] as const;
const rangeTable = '_v117_reference_ranges';
const range = (table: string, parts: number, partition: number) => {
  const limit=`(SELECT high FROM ${rangeTable} WHERE source='${table}')`;
  return `p.rowid > (${limit} / ${parts}) * ${partition}${partition===parts-1?'':` AND p.rowid <= (${limit} / ${parts}) * ${partition+1}`}`;
};
const fillReferences = (select: string) => `INSERT INTO event_refs (${EVENT_REFERENCE_COLUMNS}) ${select}
  ON CONFLICT(project_id,event_id) DO UPDATE SET ${eventReferenceUpdates(true)}`;
const backfills = rangeSources.flatMap(source=>Array.from({length:source.parts},(_,partition)=> {
  const within=range(source.table,source.parts,partition);
  if(source.table==='events') {
    const fields=references('p.');
    return [fillReferences(`SELECT p.project_id,p.event_id,p.session_id,p.kind,${fields.join(',')} FROM events p
      WHERE ${within} AND p.payload_format='inline' AND p.kind IN ('prompt','response','tool.use','tool.failure')`)];
  }
  return [fillReferences(`SELECT p.project_id,p.event_id,e.session_id,e.kind,p.${source.id},p.${source.blob},${source.table==='tool_calls'?'p.output_blob_key':'NULL'}
    FROM ${source.table} p CROSS JOIN events e WHERE ${within}
      AND e.project_id=p.project_id AND e.event_id=p.event_id AND e.kind IN (${source.kinds}) AND (e.payload_format='archived' OR p.${source.blob} IS NOT NULL${source.table==='tool_calls'?' OR p.output_blob_key IS NOT NULL':''})`)];
}));

/** Reference backfills use fixed rowid ranges and never rewrite their event sources. */
export const RETIREMENT_SCHEMA_STEPS = [
  [documentGuard[0]!,emptyDocuments,...documentGuard.slice(1),clearableStopWake,...referenceSchema,
    `CREATE TABLE IF NOT EXISTS ${rangeTable} (source TEXT PRIMARY KEY,high INTEGER NOT NULL) WITHOUT ROWID`,
    ...rangeSources.map(({table})=>`INSERT INTO ${rangeTable} SELECT '${table}',COALESCE(MAX(rowid),0) FROM ${table}`)],
  ...backfills,
  [
    `UPDATE raw_provenance_backfill SET source=0,cursor_project='',cursor_id='' WHERE complete=0`,
    'ALTER TABLE transcript_publication ADD COLUMN diagnostic TEXT',
    ...LEGACY_CONTENT_TRIGGERS.map(name=>`DROP TRIGGER IF EXISTS ${name}`),
    ...documentCounters,
    `DROP TABLE ${rangeTable}`,
  ],
].map((statements,index)=>({version:117+index,statements}));
