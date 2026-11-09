import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { assertion, write } from '../index.js';
import { changed, jsonKeys } from '../ddl.js';
import { everyPhaseDone, type CatchupFamily } from '../projections/family.js';

const measures = ['bytes', 'pending', 'sources', 'imported'] as const;
const columns = ['project_id', 'transcript_id', 'kind', 'generation', 'session_id', ...measures];
const key = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.transcript_id AS transcript_id`;
function affectedKeys(rows: readonly string[], select: (row: string) => string, id: string): string[] {
  return rows.map(row => select(row) + (rows.length === 2 && row === 'OLD'
    ? ` WHERE (OLD.project_id,OLD.${id}) IS NOT (NEW.project_id,NEW.${id})` : ''));
}
const sessionKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.session_id AS session_id`;

/** Source bytes are positive; each generation subtracts only the bytes its frontier covers. */
function reconcilePublicationContributions(keys: string): string[] {
  const source = `SELECT t.project_id,t.transcript_id,'source' AS kind,0 AS generation,t.session_id,
t.size AS bytes,(t.size>0) AS pending,1 AS sources,(t.imported_at IS NOT NULL) AS imported
FROM (${keys}) k CROSS JOIN transcripts t ON (t.project_id,t.transcript_id)=(k.project_id,k.transcript_id)
UNION ALL
SELECT t.project_id,t.transcript_id,'frontier',p.generation,t.session_id,
-MIN(t.size,p.published_offset),-(t.size>0 AND p.published_offset>=t.size),0,0
FROM (${keys}) k CROSS JOIN transcripts t ON (t.project_id,t.transcript_id)=(k.project_id,k.transcript_id)
LEFT JOIN session_documents d ON (d.project_id,d.session_id)=(t.project_id,t.session_id)
CROSS JOIN transcript_publication p ON (p.project_id,p.transcript_id)=(t.project_id,t.transcript_id) AND p.generation>=COALESCE(d.generation,0)`;
  return [
    `DELETE FROM document_publication_contributions WHERE (project_id,transcript_id) IN (${keys})
AND NOT EXISTS (SELECT 1 FROM (${source}) s WHERE
(s.project_id,s.transcript_id,s.kind,s.generation)=(document_publication_contributions.project_id,
document_publication_contributions.transcript_id,document_publication_contributions.kind,document_publication_contributions.generation))`,
    `INSERT INTO document_publication_contributions(${columns.join(',')}) SELECT ${columns.join(',')} FROM (${source}) WHERE true
ON CONFLICT(project_id,transcript_id,kind,generation) DO UPDATE SET
${['session_id', ...measures].map(c => `${c}=excluded.${c}`).join(',')}
WHERE (${['session_id', ...measures].map(c => `document_publication_contributions.${c}`).join(',')})
IS NOT (${['session_id', ...measures].map(c => `excluded.${c}`).join(',')})`,
  ];
}

/** A generation switch reads the source total and that generation's frontier total. */
function reconcilePublicationFacts(keys: string): string[] {
  return [
    `DELETE FROM document_publication_facts WHERE (project_id,session_id) IN (${keys})
AND NOT EXISTS (SELECT 1 FROM session_documents d WHERE (d.project_id,d.session_id)=(document_publication_facts.project_id,document_publication_facts.session_id))`,
    `INSERT INTO document_publication_facts(project_id,session_id,state,due_at,transcripts,bytes,imported,classes)
SELECT d.project_id,d.session_id,d.state,d.due_at,
CASE WHEN r.session_id IS NULL THEN COALESCE(held.transcripts,0) WHEN d.state='live' THEN COALESCE(s.pending,0)+COALESCE(f.pending,0) ELSE 0 END,
CASE WHEN r.session_id IS NULL THEN COALESCE(held.bytes,0) WHEN d.state='live' THEN COALESCE(s.bytes,0)+COALESCE(f.bytes,0) ELSE 0 END,
CASE WHEN r.session_id IS NULL THEN COALESCE(held.imported,0) ELSE COALESCE(s.sources,0)>0 AND s.imported=s.sources END,
CASE WHEN d.state='live' AND json_valid(d.build) THEN COALESCE(json_extract(d.build,'$.report.classes'),'{}') ELSE '{}' END
FROM (${keys}) k CROSS JOIN session_documents d ON (d.project_id,d.session_id)=(k.project_id,k.session_id)
LEFT JOIN document_publication_totals s ON (s.project_id,s.session_id,s.kind,s.generation)=(d.project_id,d.session_id,'source',0)
LEFT JOIN document_publication_totals f ON (f.project_id,f.session_id,f.kind,f.generation)=(d.project_id,d.session_id,'frontier',d.generation)
LEFT JOIN document_publication_ready r ON (r.project_id,r.session_id)=(d.project_id,d.session_id)
LEFT JOIN document_publication_facts held ON (held.project_id,held.session_id)=(d.project_id,d.session_id)
WHERE true
ON CONFLICT(project_id,session_id) DO UPDATE SET
${['state','due_at','transcripts','bytes','imported','classes'].map(c => `${c}=excluded.${c}`).join(',')}
WHERE (${['state','due_at','transcripts','bytes','imported','classes'].map(c => `document_publication_facts.${c}`).join(',')})
IS NOT (${['state','due_at','transcripts','bytes','imported','classes'].map(c => `excluded.${c}`).join(',')})`,
  ];
}

function delta(row: string, sign: number, when = '1'): string {
  return `INSERT INTO document_publication_totals(project_id,session_id,kind,generation,${measures.join(',')})
    SELECT ${row}.project_id,${row}.session_id,${row}.kind,${row}.generation,${measures.map(c => `${sign}*${row}.${c}`).join(',')} WHERE (${when}) AND (${measures.map(c => `${row}.${c}<>0`).join(' OR ')})
      AND (${row}.kind='source' OR ${row}.generation>=COALESCE((SELECT generation FROM session_documents WHERE (project_id,session_id)=(${row}.project_id,${row}.session_id)),0))
    ON CONFLICT(project_id,session_id,kind,generation) DO UPDATE SET ${measures.map(c => `${c}=${c}+excluded.${c}`).join(',')};`;
}

const bump = (row: string) => `UPDATE session_documents SET publication_input_revision=publication_input_revision+1
  WHERE (project_id,session_id)=(${row}.project_id,${row}.session_id);`;

/** Frozen into the schema step; runtime catch-up uses these same keyed reconciles. */
export function publicationContributionSchema(): string[] {
  const statements = [
    'ALTER TABLE session_documents ADD COLUMN publication_input_revision INTEGER NOT NULL DEFAULT 0',
    `CREATE TABLE IF NOT EXISTS document_publication_ready(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,PRIMARY KEY(project_id,session_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS document_publication_contributions(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),transcript_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('source','frontier')),generation INTEGER NOT NULL,session_id TEXT NOT NULL,
      ${measures.map(c => `${c} INTEGER NOT NULL`).join(',')},PRIMARY KEY(project_id,transcript_id,kind,generation)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS document_publication_totals(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('source','frontier')),generation INTEGER NOT NULL,
      ${measures.map(c => `${c} INTEGER NOT NULL`).join(',')},PRIMARY KEY(project_id,session_id,kind,generation)) WITHOUT ROWID`,
  ];
  for (const action of ['insert','update','delete']) {
    const rows = action === 'insert' ? ['NEW'] : action === 'delete' ? ['OLD'] : ['OLD','NEW'];
    const sameTotal = '(OLD.project_id,OLD.session_id,OLD.kind,OLD.generation) IS (NEW.project_id,NEW.session_id,NEW.kind,NEW.generation)';
    statements.push(`CREATE TRIGGER IF NOT EXISTS publication_contribution_${action} AFTER ${action.toUpperCase()} ON document_publication_contributions BEGIN
      ${action === 'update' ? `INSERT INTO document_publication_totals(project_id,session_id,kind,generation,${measures.join(',')})
        SELECT NEW.project_id,NEW.session_id,NEW.kind,NEW.generation,${measures.map(c => `NEW.${c}-OLD.${c}`).join(',')} WHERE ${sameTotal} AND (${measures.map(c => `NEW.${c}<>OLD.${c}`).join(' OR ')})
          AND (NEW.kind='source' OR NEW.generation>=COALESCE((SELECT generation FROM session_documents WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id)),0))
        ON CONFLICT(project_id,session_id,kind,generation) DO UPDATE SET ${measures.map(c => `${c}=${c}+excluded.${c}`).join(',')};` : ''}
      ${rows.map(row => delta(row, row === 'OLD' ? -1 : 1, action === 'update' ? `NOT ${sameTotal}` : '1')).join(' ')}
      ${rows.map(row => `DELETE FROM document_publication_totals
        WHERE (project_id,session_id,kind,generation)=(${row}.project_id,${row}.session_id,${row}.kind,${row}.generation)
          AND ((sources=0 AND bytes=0 AND pending=0 AND imported=0) OR (kind='frontier' AND EXISTS(SELECT 1 FROM session_documents
            WHERE (project_id,session_id)=(${row}.project_id,${row}.session_id) AND generation>${row}.generation)));`).join(' ')} END`);
    for (const table of ['transcripts','transcript_publication']) {
      const fields = table === 'transcripts' ? ['project_id','session_id','transcript_id','size','imported_at']
        : ['project_id','session_id','transcript_id','generation','published_offset'];
      const factKeys = affectedKeys(rows, sessionKey, 'session_id');
      if (table === 'transcript_publication') factKeys.push(`SELECT t.project_id,t.session_id
        FROM (${affectedKeys(rows, key, 'transcript_id').join(' UNION ')}) k CROSS JOIN transcripts t
        ON (t.project_id,t.transcript_id)=(k.project_id,k.transcript_id)`);
      statements.push(`DROP TRIGGER IF EXISTS ${table}_facts_${action}`);
      statements.push(`CREATE TRIGGER IF NOT EXISTS ${table}_facts_${action} AFTER ${action === 'update' ? `UPDATE OF ${fields.join(',')}` : action.toUpperCase()} ON ${table}
        ${action === 'update' ? `WHEN ${changed(fields)}` : ''} BEGIN
        ${affectedKeys(rows, key, 'transcript_id').flatMap(reconcilePublicationContributions).join(';')};
        ${reconcilePublicationFacts(factKeys.join(' UNION ')).join(';')}; END`);
    }
    statements.push(`DROP TRIGGER IF EXISTS session_documents_facts_${action}`);
    const fields = ['project_id','session_id','generation','state','due_at','build'];
    if (action === 'insert') statements.push(`CREATE TRIGGER IF NOT EXISTS publication_ready_insert AFTER INSERT ON session_documents
      WHEN NOT EXISTS(SELECT 1 FROM projection_catchup WHERE projection='publication' AND phase='publicationInputs' AND done=0)
      BEGIN INSERT INTO document_publication_ready(project_id,session_id) VALUES(NEW.project_id,NEW.session_id) ON CONFLICT DO NOTHING;
      ${reconcilePublicationFacts(sessionKey('NEW')).join(';')}; END`);
    if (action === 'delete') statements.push(`CREATE TRIGGER IF NOT EXISTS publication_ready_delete AFTER DELETE ON session_documents BEGIN
      DELETE FROM document_publication_ready WHERE (project_id,session_id)=(OLD.project_id,OLD.session_id); END`);
    if (action === 'update') statements.push(`CREATE TRIGGER IF NOT EXISTS publication_ready_update AFTER UPDATE OF project_id,session_id ON session_documents
      WHEN (OLD.project_id,OLD.session_id) IS NOT (NEW.project_id,NEW.session_id) BEGIN
      INSERT INTO document_publication_ready(project_id,session_id) SELECT NEW.project_id,NEW.session_id
        WHERE EXISTS(SELECT 1 FROM document_publication_ready WHERE (project_id,session_id)=(OLD.project_id,OLD.session_id))
          OR NOT EXISTS(SELECT 1 FROM projection_catchup WHERE projection='publication' AND phase='publicationInputs' AND done=0)
        ON CONFLICT DO NOTHING;
      DELETE FROM document_publication_ready WHERE (project_id,session_id)=(OLD.project_id,OLD.session_id);
      ${reconcilePublicationFacts(sessionKey('NEW')).join(';')}; END`);
    statements.push(`CREATE TRIGGER IF NOT EXISTS session_documents_facts_${action} AFTER ${action === 'update' ? `UPDATE OF ${fields.join(',')}` : action.toUpperCase()} ON session_documents
      ${action === 'update' ? `WHEN ${changed(fields)}` : ''} BEGIN ${affectedKeys(rows, sessionKey, 'session_id').flatMap(reconcilePublicationFacts).join(';')}; END`);
  }
  const inputs = {
    transcripts: ['project_id','session_id','transcript_id','size','imported_at','last_received_at','agent','role','prompt_identity_scheme','record_identity_scheme'],
    transcript_publication: ['project_id','session_id','transcript_id','generation','published_offset','segment_lines','parser_version','open_prompt_id','unfinished','reply_unfinished','reply_latest_at','prompt_scheme','record_scheme','state','failure','awaited_size','placed_records','placed_digest'],
    publish_queue: ['project_id','session_id','rank','created_at','event_id','retry_at','retry_cause','failure'],
    session_tombstones: ['project_id','session_id','created_at'],
  };
  for (const [table, fields] of Object.entries(inputs)) for (const action of ['insert','update','delete']) {
    statements.push(`CREATE TRIGGER IF NOT EXISTS publication_input_${table}_${action} AFTER ${action === 'update' ? `UPDATE OF ${fields.join(',')}` : action.toUpperCase()} ON ${table}
      ${action === 'update' ? `WHEN ${changed(fields)}` : ''} BEGIN
      ${bump(action === 'delete' ? 'OLD' : 'NEW')}
      ${action === 'update' ? `UPDATE session_documents SET publication_input_revision=publication_input_revision+1
        WHERE (project_id,session_id)=(OLD.project_id,OLD.session_id) AND (OLD.project_id,OLD.session_id) IS NOT (NEW.project_id,NEW.session_id);` : ''} END`);
  }
  statements.push(`CREATE TRIGGER IF NOT EXISTS publication_input_document_update AFTER UPDATE OF project_id,session_id,state,generation ON session_documents
    WHEN ${changed(['project_id','session_id','state','generation'])} BEGIN ${bump('NEW')} END`);
  statements.push("INSERT INTO projection_catchup(projection,phase,done) SELECT 'publication','publicationInputs',NOT EXISTS(SELECT 1 FROM transcripts)",
    "INSERT INTO projection_catchup(projection,phase,done) SELECT 'publication','publicationSessions',NOT EXISTS(SELECT 1 FROM session_documents)");
  return statements.map(sql => sql.replace(/[ \t]+$/gm, ''));
}

const PUBLICATION_SOURCE_RECONCILE = [...reconcilePublicationContributions(
  jsonKeys(['project_id', 'transcript_id']),
), ...reconcilePublicationFacts(
  "SELECT DISTINCT t.project_id,t.session_id FROM json_each(?1) j CROSS JOIN transcripts t ON (t.project_id,t.transcript_id)=(json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]'))",
)].map((sql, i) => write<[string]>({ name: `publication.sourcePage${i}`, sql }));
const PUBLICATION_INPUTS_READY = assertion<[string]>({ name: 'publication.sourcesReady', sql: `SELECT CASE WHEN json_valid(?1)
  AND EXISTS(SELECT 1 FROM projection_catchup WHERE projection='publication' AND phase='publicationInputs' AND done=1)
  THEN 1 ELSE json_extract('[]','$[publication_inputs_building]') END` });
const PUBLICATION_DOCUMENT_RECONCILE = [PUBLICATION_INPUTS_READY, ...[
  `INSERT INTO document_publication_ready(project_id,session_id) SELECT d.project_id,d.session_id
    FROM json_each(?1) j JOIN session_documents d ON (d.project_id,d.session_id)=(json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]'))
    WHERE true ON CONFLICT DO NOTHING`,
  ...reconcilePublicationFacts(
  jsonKeys(['project_id', 'session_id']),
)].map((sql, i) => write<[string]>({ name: `publication.documentPage${i}`, sql }))];

export const PUBLICATION_CATCHUP = {
  projection: 'publication',
  phases: {
    publicationInputs: { source: { table: 'transcripts', columns: ['project_id', 'transcript_id'] }, reconcile: PUBLICATION_SOURCE_RECONCILE },
    publicationSessions: { source: { table: 'session_documents', columns: ['project_id', 'session_id'] }, reconcile: PUBLICATION_DOCUMENT_RECONCILE, frontier: () => [PUBLICATION_INPUTS_READY.bind('[]')] },
  },
} as const satisfies CatchupFamily;

export const publicationReady = (phases: readonly { phase: string; done: number }[]): boolean => everyPhaseDone(PUBLICATION_CATCHUP, phases);
