/** Refreshes one session's publication facts through its catalog identities. */
export function documentFactsSelect(where: string): string {
  const transcripts = `FROM transcripts t LEFT JOIN transcript_publication p ON p.project_id=t.project_id
    AND p.transcript_id=t.transcript_id AND p.generation=d.generation WHERE t.project_id=d.project_id AND t.session_id=d.session_id`;
  return `SELECT d.project_id,d.session_id,d.state,d.due_at,
      CASE WHEN d.state='live' THEN (SELECT COUNT(*) ${transcripts} AND COALESCE(p.published_offset,0)<t.size) ELSE 0 END,
      CASE WHEN d.state='live' THEN (SELECT COALESCE(SUM(MAX(0,t.size-COALESCE(p.published_offset,0))),0) ${transcripts}) ELSE 0 END,
      EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)
        AND NOT EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=d.project_id AND t.session_id=d.session_id AND t.imported_at IS NULL),
      CASE WHEN d.state='live' AND json_valid(d.build) THEN COALESCE(json_extract(d.build,'$.report.classes'),'{}') ELSE '{}' END
    FROM session_documents d WHERE ${where}`;
}

export const DOCUMENT_FACT_COLUMNS = 'project_id,session_id,state,due_at,transcripts,bytes,imported,classes';

/** Radix sixteen partitions of nonnegative millisecond deadlines, through the safe integer time range. */
const DOCUMENT_DUE_RADIX = 16;
const DOCUMENT_DUE_LEVELS = Math.ceil(Math.log2(Number.MAX_SAFE_INTEGER)/Math.log2(DOCUMENT_DUE_RADIX));
const DOCUMENT_DUE_DIVISORS = Array.from({length:DOCUMENT_DUE_LEVELS},(_,level)=>DOCUMENT_DUE_RADIX ** level);

export const refreshDocumentFacts = (row: string): string => `INSERT INTO document_publication_facts(${DOCUMENT_FACT_COLUMNS})
  ${documentFactsSelect(`d.project_id=${row}.project_id AND d.session_id=${row}.session_id`)}
  ON CONFLICT(project_id,session_id) DO UPDATE SET state=excluded.state,due_at=excluded.due_at,
    transcripts=excluded.transcripts,bytes=excluded.bytes,imported=excluded.imported,classes=excluded.classes
  WHERE ${['state','due_at','transcripts','bytes','imported','classes'].map(column=>`document_publication_facts.${column} IS NOT excluded.${column}`).join(' OR ')};`;

export function documentFactDelta(row: string, delta: number): string {
  return `UPDATE document_status_totals SET live=live+${delta}*(${row}.state='live'),converting=converting+${delta}*(${row}.state='convert'),lag=lag+${delta}*${row}.bytes;
    INSERT INTO document_difference_totals(class,n,members) SELECT key,${delta}*value,${delta} FROM json_each(${row}.classes) WHERE 1
      ON CONFLICT(class) DO UPDATE SET n=n+excluded.n,members=members+excluded.members;
    DELETE FROM document_difference_totals WHERE members=0;
    ${documentDueDelta(row,delta)}`;
}

function documentDueDelta(row:string,delta:number):string {
  return `INSERT INTO document_due_totals(level,bucket,sessions,transcripts,bytes,imported_sessions,imported_transcripts,imported_bytes)
      SELECT key,CAST(MAX(0,${row}.due_at)/value AS INTEGER),${delta},${delta}*${row}.transcripts,${delta}*${row}.bytes,
        ${delta}*${row}.imported,${delta}*${row}.imported*${row}.transcripts,${delta}*${row}.imported*${row}.bytes
      FROM json_each('${JSON.stringify(DOCUMENT_DUE_DIVISORS)}') WHERE ${row}.state='live' AND ${row}.due_at IS NOT NULL
      ON CONFLICT(level,bucket) DO UPDATE SET sessions=sessions+excluded.sessions,transcripts=transcripts+excluded.transcripts,
        bytes=bytes+excluded.bytes,imported_sessions=imported_sessions+excluded.imported_sessions,
        imported_transcripts=imported_transcripts+excluded.imported_transcripts,imported_bytes=imported_bytes+excluded.imported_bytes;
    DELETE FROM document_due_totals WHERE sessions=0 AND (level,bucket) IN
      (SELECT key,CAST(MAX(0,${row}.due_at)/value AS INTEGER) FROM json_each('${JSON.stringify(DOCUMENT_DUE_DIVISORS)}'));`;
}
