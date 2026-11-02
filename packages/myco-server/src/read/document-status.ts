/**
 * The documents fact of the status surface: how many sessions are live or still converting, how far the publisher
 * stands behind the bytes received, the member events it has yet to publish, the superseded objects awaiting release,
 * and the conversion report's difference classes summed over every converted session. Each is one catalog statement.
 */
import type { RelationalStore } from '../core/adapters.js';

export interface DocumentStatus {
  sessions: { live: number; converting: number };
  lagBytes: number;
  queued: number;
  retired: number;
  differences: Record<string, number>;
}

export async function readDocumentStatus(db: RelationalStore): Promise<DocumentStatus> {
  const [totals,differences] = await db.batch([
    db.prepare('SELECT live,converting,lag,queued,retired FROM document_status_totals WHERE slot=1'),
    db.prepare('SELECT class,n FROM document_difference_totals'),
  ]);
  const row = totals!.results[0] as {live:number;converting:number;lag:number;queued:number;retired:number};
  return {
    sessions:{live:Number(row.live),converting:Number(row.converting)},lagBytes:Number(row.lag),queued:Number(row.queued),retired:Number(row.retired),
    differences:Object.fromEntries((differences!.results as {class:string;n:number}[]).map(item=>[item.class,Number(item.n)])),
  };
}

/**
 * A bounded observation of due sessions and their unpublished transcripts and bytes, split by import.
 */
export interface PublicationBacklog {
  sessions: number;
  /** True when a due class extends past the observed page; counts and bytes are lower bounds. */
  limited?: true;
  transcripts: number;
  bytes: number;
  imported: { sessions: number; transcripts: number; bytes: number };
}

/** Due sessions observed per capture class; both classes remain visible to wake admission. */
export const PUBLICATION_BACKLOG_PAGE=64;

/** A fresh bounded backlog observation; a limited result is a lower bound. */
export async function pendingPublication(db:RelationalStore,now:number):Promise<PublicationBacklog> {
  const results=await db.batch([0,1].map(imported=>db.prepare(`SELECT f.transcripts,f.bytes FROM document_due q CROSS JOIN document_publication_facts f
    WHERE q.imported=? AND q.due_at<=? AND f.project_id=q.project_id AND f.session_id=q.session_id
    ORDER BY q.due_at,q.project_id,q.session_id LIMIT ?`).bind(imported,now,PUBLICATION_BACKLOG_PAGE+1)));
  const counts=results.map(result=>{
    const page=result.results.slice(0,PUBLICATION_BACKLOG_PAGE) as {transcripts:number;bytes:number}[];
    return {sessions:page.length,transcripts:page.reduce((n,row)=>n+Number(row.transcripts),0),bytes:page.reduce((n,row)=>n+Number(row.bytes),0)};
  });
  return {sessions:counts[0]!.sessions+counts[1]!.sessions,transcripts:counts[0]!.transcripts+counts[1]!.transcripts,
    bytes:counts[0]!.bytes+counts[1]!.bytes,imported:counts[1]!,
    ...(results.some(result=>result.results.length>PUBLICATION_BACKLOG_PAGE) ? {limited:true as const} : {})};
}
