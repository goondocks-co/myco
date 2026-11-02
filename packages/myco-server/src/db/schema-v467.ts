import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { documentFactDelta, documentFactsSelect, DOCUMENT_FACT_COLUMNS, refreshDocumentFacts } from './document-facts-v467.js';

/** Publication facts and deadline partitions change in the catalog mutation's transaction. */
const setup: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS document_status_totals(slot INTEGER PRIMARY KEY CHECK(slot=1),live INTEGER NOT NULL DEFAULT 0,
    converting INTEGER NOT NULL DEFAULT 0,lag INTEGER NOT NULL DEFAULT 0,queued INTEGER NOT NULL DEFAULT 0,retired INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO document_status_totals(slot,queued,retired) SELECT 1,(SELECT COUNT(*) FROM publish_queue),(SELECT COUNT(*) FROM retired_objects)`,
  `CREATE TABLE IF NOT EXISTS document_difference_totals(class TEXT PRIMARY KEY,n INTEGER NOT NULL,members INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS document_publication_facts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
    state TEXT NOT NULL,due_at INTEGER,transcripts INTEGER NOT NULL,bytes INTEGER NOT NULL,imported INTEGER NOT NULL,classes TEXT NOT NULL,
    PRIMARY KEY(project_id,session_id))`,
  `CREATE TABLE IF NOT EXISTS document_due_totals(level INTEGER NOT NULL,bucket INTEGER NOT NULL,sessions INTEGER NOT NULL,
    transcripts INTEGER NOT NULL,bytes INTEGER NOT NULL,imported_sessions INTEGER NOT NULL,imported_transcripts INTEGER NOT NULL,
    imported_bytes INTEGER NOT NULL,PRIMARY KEY(level,bucket))`,
  ...['INSERT','UPDATE','DELETE'].map(op => `CREATE TRIGGER IF NOT EXISTS document_publication_facts_${op.toLowerCase()} AFTER ${op} ON document_publication_facts
    BEGIN ${op === 'INSERT' ? '' : documentFactDelta('OLD',-1)} ${op === 'DELETE' ? '' : documentFactDelta('NEW',1)} END`),
  `CREATE TRIGGER IF NOT EXISTS session_documents_facts_insert AFTER INSERT ON session_documents BEGIN ${refreshDocumentFacts('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS session_documents_facts_update AFTER UPDATE OF project_id,session_id,state,generation,due_at,build ON session_documents
    BEGIN DELETE FROM document_publication_facts WHERE project_id=OLD.project_id AND session_id=OLD.session_id
      AND (OLD.project_id<>NEW.project_id OR OLD.session_id<>NEW.session_id); ${refreshDocumentFacts('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS session_documents_facts_delete AFTER DELETE ON session_documents BEGIN
    DELETE FROM document_publication_facts WHERE project_id=OLD.project_id AND session_id=OLD.session_id; END`,
  ...['transcripts','transcript_publication'].flatMap(table => ['INSERT','UPDATE','DELETE'].map(op =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_facts_${op.toLowerCase()} AFTER ${op === 'UPDATE' ? `UPDATE OF ${table === 'transcripts' ? 'project_id,session_id,transcript_id,size,imported_at' : 'project_id,session_id,transcript_id,generation,published_offset'}` : op} ON ${table}
      BEGIN ${(op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD','NEW']).map(refreshDocumentFacts).join(' ')} END`)),
  ...[['publish_queue','queued'],['retired_objects','retired']].flatMap(([table,column]) => ['INSERT','DELETE'].map(op =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_facts_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN
      UPDATE document_status_totals SET ${column}=${column}${op === 'INSERT' ? '+1' : '-1'}; END`)),
  `CREATE TABLE IF NOT EXISTS _document_fact_range(high INTEGER NOT NULL)`,
  `INSERT INTO _document_fact_range SELECT COALESCE(MAX(rowid),0) FROM session_documents`,
];

/** Existing documents enter the facts in disjoint rowid ranges; each range is its own transaction. */
const PARTS = 32;
const pages = Array.from({length:PARTS},(_,index) => [
  `INSERT OR IGNORE INTO document_publication_facts(${DOCUMENT_FACT_COLUMNS})
    ${documentFactsSelect(`d.rowid>((SELECT high FROM _document_fact_range)/${PARTS})*${index}${index === PARTS-1 ? '' : ` AND d.rowid<=((SELECT high FROM _document_fact_range)/${PARTS})*${index+1}`}`)}`,
]);

export const PUBLICATION_FACT_STEPS = [setup,...pages,['DROP TABLE _document_fact_range']].map((statements,index) => ({version:467+index,statements}));
