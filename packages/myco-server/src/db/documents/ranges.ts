import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { write } from '../index.js';
import { prepareBound } from '../kernel/statement.js';

/** A logical transcript range selects its archived representation once that transition commits. */
export const archivedTranscriptRangeSql = (project: string, transcript: string, offset: string): string =>
  `EXISTS (SELECT 1 FROM raw_archive_refs r WHERE r.project_id=${project} AND r.transcript_id=${transcript}
    AND r.base_offset=${offset} AND r.source_kind='transcript' AND r.disposition='archived')`;
const clear = write<[string,string,number]>({name:'publication.clearArchivedRange',sql:`DELETE FROM transcript_segments
  WHERE project_id=?1 AND transcript_id=?2 AND base_offset=?3
    AND ${archivedTranscriptRangeSql('transcript_segments.project_id','transcript_segments.transcript_id','transcript_segments.base_offset')}`});
const restore = write<[string,string,number,number,string,string,number,number,string],{rowid:number}>({name:'publication.restoreHotRange',sql:`INSERT INTO transcript_segments
  (project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE NOT ${archivedTranscriptRangeSql('?1','?2','?3')}
    AND NOT EXISTS(SELECT 1 FROM transcripts t JOIN session_tombstones s ON (s.project_id,s.session_id)=(t.project_id,t.session_id)
      WHERE t.project_id=?1 AND t.transcript_id=?2)
  ON CONFLICT DO NOTHING RETURNING rowid`});

/** Archive selection and removal of its hot representation share the caller's transaction. */
export function clearArchivedTranscriptRanges(db: RelationalStore, project: string, transcript: string, offset: number): PreparedStatement {
  return prepareBound(db,clear.bind(project,transcript,offset));
}
/** Additive restore admits a hot range only while no archived selection or tombstone owns it. */
export function restoreTranscriptSegmentStatement(db:RelationalStore,row:Record<string,unknown>):PreparedStatement {
  return prepareBound(db,restore.bind(row.project_id as string,row.transcript_id as string,row.base_offset as number,row.length as number,
    row.blob_key as string,row.event_id as string,row.created_at as number,row.received_at as number,row.token_id as string));
}
