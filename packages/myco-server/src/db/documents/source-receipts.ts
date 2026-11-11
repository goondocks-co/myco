import type { RelationalStore } from '../../core/adapters.js';
import { read, rows } from '../index.js';

/** When the Deployment received each source offset: from the hot segment that holds it, or the archived range that does. */
const receipts = read<[project: string, transcript: string, offsets: string], { offset: number; received_at: number | null }>({ name: 'documents.sourceReceipts', sql:
  `SELECT j.value offset,COALESCE(
    (SELECT s.received_at FROM transcript_segments s WHERE s.project_id=?1 AND s.transcript_id=?2 AND s.base_offset<=j.value AND s.base_offset+s.length>j.value ORDER BY s.base_offset DESC LIMIT 1),
    (SELECT r.received_at FROM raw_archive_refs r WHERE r.project_id=?1 AND r.transcript_id=?2 AND r.source_kind='transcript' AND r.disposition='archived'
      AND r.base_offset<=j.value AND r.base_offset+r.length>j.value ORDER BY r.base_offset DESC LIMIT 1)) received_at FROM json_each(?3) j` });

/** The receipt time of each offset a transcript's source records start at; null where no held segment or archived range covers it. */
export async function sourceReceiptRows(db: RelationalStore, project: string, transcript: string, offsets: readonly number[]) {
  return rows(db, receipts.bind(project, transcript, JSON.stringify(offsets)));
}
