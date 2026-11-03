import type { PreparedStatement, RelationalStore } from './adapters.js';

/** A logical transcript range selects its archived representation once that transition commits. */
export const archivedTranscriptRangeSql = (project: string, transcript: string, offset: string): string =>
  `EXISTS (SELECT 1 FROM raw_archive_refs r WHERE r.project_id=${project} AND r.transcript_id=${transcript}
    AND r.base_offset=${offset} AND r.source_kind='transcript' AND r.disposition='archived')`;

/** The archive selection and removal of its hot representation share the caller's transaction. */
export function clearArchivedTranscriptRanges(db: RelationalStore, project: string, transcript: string, offset: number): PreparedStatement {
  return db.prepare(`DELETE FROM transcript_segments WHERE project_id=? AND transcript_id=? AND base_offset=?
    AND ${archivedTranscriptRangeSql('transcript_segments.project_id','transcript_segments.transcript_id','transcript_segments.base_offset')}`)
    .bind(project, transcript, offset);
}

/** Additive restore admits a hot range only while its canonical range has no archived selection. */
export function restoreTranscriptSegmentStatement(db: RelationalStore, row: Record<string, unknown>): PreparedStatement {
  const columns = Object.keys(row);
  return db.prepare(`INSERT OR IGNORE INTO transcript_segments(${columns.join(',')})
    SELECT ${columns.map(() => '?').join(',')} WHERE NOT ${archivedTranscriptRangeSql('?','?','?')} RETURNING rowid`)
    .bind(...columns.map(column => row[column] ?? null), row.project_id, row.transcript_id, row.base_offset);
}
