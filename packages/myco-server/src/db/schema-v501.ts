import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { documentFactChange,documentFactDelta,refreshDocumentFacts,updateDocumentMetadata } from './document-facts.js';

/** A lifecycle change releases the model and fences calls from its prior generation. */
const releaseProvider = (row:string) => `DELETE FROM embedding_provider_holds WHERE model_key=${row}.model_key;
    UPDATE schema_meta SET value=CAST(value AS INTEGER)+1 WHERE key='embedding_provider_revision';`;

const setup:readonly string[] = [
  `ALTER TABLE embedding_cursors ADD COLUMN hubness_publication_revision INTEGER`,
  `CREATE TABLE IF NOT EXISTS document_due(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
    imported INTEGER NOT NULL,due_at INTEGER NOT NULL,PRIMARY KEY(imported,due_at,project_id,session_id),UNIQUE(project_id,session_id)) WITHOUT ROWID`,
  ...['insert','update','delete'].flatMap(operation=>[
    `DROP TRIGGER IF EXISTS document_publication_facts_${operation}`,
    `CREATE TRIGGER IF NOT EXISTS document_publication_facts_${operation} AFTER ${operation.toUpperCase()} ON document_publication_facts
      BEGIN ${operation==='update' ? documentFactChange() : documentFactDelta(operation==='insert' ? 'NEW' : 'OLD',operation==='insert' ? 1 : -1)} END`,
  ]),
  `DROP TRIGGER IF EXISTS session_documents_facts_update`,
  `CREATE TRIGGER IF NOT EXISTS session_documents_facts_update AFTER UPDATE OF project_id,session_id,state,generation,due_at,build ON session_documents BEGIN
    DELETE FROM document_publication_facts WHERE project_id=OLD.project_id AND session_id=OLD.session_id
      AND (OLD.project_id<>NEW.project_id OR OLD.session_id<>NEW.session_id);
    ${refreshDocumentFacts('NEW','OLD.project_id<>NEW.project_id OR OLD.session_id<>NEW.session_id OR OLD.state<>NEW.state OR OLD.generation IS NOT NEW.generation')}
    ${updateDocumentMetadata()} END`,
  ...['transcripts','transcript_publication'].flatMap(table=>[
    `DROP TRIGGER IF EXISTS ${table}_facts_update`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_facts_update AFTER UPDATE OF ${table==='transcripts' ? 'project_id,session_id,transcript_id,size,imported_at' : 'project_id,session_id,transcript_id,generation,published_offset'} ON ${table} BEGIN
      ${refreshDocumentFacts('OLD','OLD.project_id<>NEW.project_id OR OLD.session_id<>NEW.session_id')}
      ${refreshDocumentFacts('NEW')} END`,
  ]),
  ...['INSERT','DELETE'].map(operation=>`CREATE TRIGGER IF NOT EXISTS embedding_switches_hold_${operation.toLowerCase()} AFTER ${operation} ON embedding_switches BEGIN
    ${releaseProvider(operation==='INSERT' ? 'NEW' : 'OLD')} END`),
  `CREATE TRIGGER IF NOT EXISTS embedding_switches_hold_resume AFTER UPDATE OF state,retry_at ON embedding_switches
    WHEN NEW.state='building' AND (OLD.state='paused' OR OLD.retry_at IS NOT NULL AND NEW.retry_at IS NULL) BEGIN
      ${releaseProvider('NEW')} END`,
  `UPDATE embedding_provider_holds SET retry_at=0 WHERE retry_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS _document_due_range(high INTEGER NOT NULL)`,
  `INSERT INTO _document_due_range SELECT COALESCE(MAX(rowid),0) FROM document_publication_facts`,
];
const PARTS=32;
const pages=Array.from({length:PARTS},(_,index)=>[
  `INSERT OR IGNORE INTO document_due(project_id,session_id,imported,due_at)
    SELECT project_id,session_id,imported,due_at FROM document_publication_facts WHERE state='live' AND due_at IS NOT NULL
      AND rowid>((SELECT high FROM _document_due_range)/${PARTS})*${index}${index===PARTS-1 ? '' : ` AND rowid<=((SELECT high FROM _document_due_range)/${PARTS})*${index+1}`}`,
]);
/** Due identities enter the ordered queue in disjoint rowid transactions. */
export const PUBLICATION_QUEUE_STEPS=[setup,...pages,['DROP TABLE _document_due_range']].map((statements,index)=>({version:501+index,statements}));
