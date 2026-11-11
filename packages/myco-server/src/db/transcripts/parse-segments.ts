import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../storage/registered-object-key.js';
import { read, rows } from '../index.js';

/** One stored range of a transcript as the parser reads it: its registered object and original creation time. */
export interface ParseSegment {
  base_offset: number;
  length: number;
  blob_key: string;
  object_key: string | null;
  created_at: number;
}

/**
 * The ranges a parse reads past `after`, hot or archived alike: each arm starts at the range holding `after` (or `after`
 * itself), and both arms together are ordered by offset and held to `limit`.
 */
const segments = read<[project: string, transcript: string, after: number, limit: number], ParseSegment>({ name: 'transcripts.parseSegments', sql:
  `SELECT * FROM (
  SELECT s.base_offset,s.length,s.blob_key,COALESCE(e.created_at,s.created_at) AS created_at,
    ${registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key
    FROM transcript_segments s LEFT JOIN events e ON e.project_id=s.project_id AND e.event_id=s.event_id
    WHERE s.project_id=?1 AND s.transcript_id=?2
      AND s.base_offset>=COALESCE((SELECT MAX(k.base_offset) FROM transcript_segments k
        WHERE k.project_id=?1 AND k.transcript_id=?2 AND k.base_offset<=?3),?3)
      AND s.base_offset+s.length>?3
  UNION ALL
  SELECT r.base_offset,r.length,r.archive_key AS blob_key,r.created_at,
    ${registeredObjectKeySql('r.project_id', 'r.archive_key')} AS object_key
    FROM raw_archive_refs r WHERE r.project_id=?1 AND r.transcript_id=?2
      AND r.source_kind='transcript' AND r.disposition='archived'
      AND r.base_offset>=COALESCE((SELECT MAX(k.base_offset) FROM raw_archive_refs k
        WHERE k.project_id=?1 AND k.transcript_id=?2 AND k.base_offset<=?3),?3)
      AND r.base_offset+r.length>?3) ORDER BY base_offset LIMIT ?4` });

/** The first `limit` ranges a parse of `transcript` reads from `after`. */
export async function parseSegments(db: RelationalStore, project: string, transcript: string, after: number, limit: number): Promise<ParseSegment[]> {
  return rows(db, segments.bind(project, transcript, after, limit));
}
