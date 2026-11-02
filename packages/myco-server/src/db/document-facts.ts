/** Conversion difference classes held by a live document. */
const classes = (row:string) => `CASE WHEN ${row}.state='live' AND json_valid(${row}.build)
  THEN COALESCE(json_extract(${row}.build,'$.report.classes'),'{}') ELSE '{}' END`;

/** Refreshes one session's publication facts through its catalog identities. */
export function documentFactsSelect(where:string):string {
  const transcripts = `FROM transcripts t LEFT JOIN transcript_publication p ON p.project_id=t.project_id
    AND p.transcript_id=t.transcript_id AND p.generation=d.generation WHERE t.project_id=d.project_id AND t.session_id=d.session_id`;
  return `SELECT d.project_id,d.session_id,d.state,d.due_at,
      CASE WHEN d.state='live' THEN (SELECT COUNT(*) ${transcripts} AND COALESCE(p.published_offset,0)<t.size) ELSE 0 END,
      CASE WHEN d.state='live' THEN (SELECT COALESCE(SUM(MAX(0,t.size-COALESCE(p.published_offset,0))),0) ${transcripts}) ELSE 0 END,
      EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)
        AND NOT EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=d.project_id AND t.session_id=d.session_id AND t.imported_at IS NULL),
      ${classes('d')} FROM session_documents d WHERE ${where}`;
}

export const DOCUMENT_FACT_COLUMNS = 'project_id,session_id,state,due_at,transcripts,bytes,imported,classes';

export const refreshDocumentFacts = (row:string,when='1'):string => `INSERT INTO document_publication_facts(${DOCUMENT_FACT_COLUMNS})
  ${documentFactsSelect(`(${when}) AND d.project_id=${row}.project_id AND d.session_id=${row}.session_id`)}
  ON CONFLICT(project_id,session_id) DO UPDATE SET state=excluded.state,due_at=excluded.due_at,
    transcripts=excluded.transcripts,bytes=excluded.bytes,imported=excluded.imported,classes=excluded.classes
  WHERE ${['state','due_at','transcripts','bytes','imported','classes'].map(column=>`document_publication_facts.${column} IS NOT excluded.${column}`).join(' OR ')};`;

/** Same-generation metadata changes need no transcript reads. */
export const updateDocumentMetadata = ():string => `UPDATE document_publication_facts SET due_at=NEW.due_at,classes=${classes('NEW')}
  WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND OLD.project_id=NEW.project_id AND OLD.session_id=NEW.session_id
    AND OLD.state=NEW.state AND OLD.generation IS NEW.generation AND (due_at IS NOT NEW.due_at OR classes IS NOT ${classes('NEW')});`;

const active = (row:string) => `(${row}.state='live' AND ${row}.due_at IS NOT NULL)`;

function queueDue(row:string,when='1'):string {
  return `INSERT INTO document_due(project_id,session_id,imported,due_at)
    SELECT ${row}.project_id,${row}.session_id,${row}.imported,${row}.due_at WHERE ${active(row)} AND (${when})
    ON CONFLICT(project_id,session_id) DO UPDATE SET imported=excluded.imported,due_at=excluded.due_at
    WHERE document_due.imported IS NOT excluded.imported OR document_due.due_at IS NOT excluded.due_at;`;
}

function differenceDelta(row:string,delta:number,when='1'):string {
  return `INSERT INTO document_difference_totals(class,n,members) SELECT key,${delta}*value,${delta} FROM json_each(${row}.classes) WHERE ${when}
    ON CONFLICT(class) DO UPDATE SET n=n+excluded.n,members=members+excluded.members;
    DELETE FROM document_difference_totals WHERE members=0;`;
}

/** Adds or removes a session's facts with its catalog identity. */
export function documentFactDelta(row:string,delta:number):string {
  return `UPDATE document_status_totals SET live=live+${delta}*(${row}.state='live'),converting=converting+${delta}*(${row}.state='convert'),lag=lag+${delta}*${row}.bytes;
    ${differenceDelta(row,delta)}
    ${delta>0 ? queueDue(row) : `DELETE FROM document_due WHERE project_id=${row}.project_id AND session_id=${row}.session_id;`}`;
}

/** Only changed totals and queue coordinates are written. */
export function documentFactChange():string {
  return `UPDATE document_status_totals SET live=live+(NEW.state='live')-(OLD.state='live'),
      converting=converting+(NEW.state='convert')-(OLD.state='convert'),lag=lag+NEW.bytes-OLD.bytes
    WHERE NEW.state IS NOT OLD.state OR NEW.bytes IS NOT OLD.bytes;
    ${differenceDelta('OLD',-1,'OLD.classes IS NOT NEW.classes')}
    ${differenceDelta('NEW',1,'OLD.classes IS NOT NEW.classes')}
    DELETE FROM document_due WHERE project_id=OLD.project_id AND session_id=OLD.session_id AND NOT ${active('NEW')};
    ${queueDue('NEW',"OLD.state IS NOT NEW.state OR OLD.due_at IS NOT NEW.due_at OR OLD.imported IS NOT NEW.imported")}`;
}
