/**
 * Reading an inline event body by byte slices, and the checkpoint a long body's scan keeps between passes. A checkpoint
 * names the exact source revision it scanned, and is written only while that revision is still the event's.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { commit, first, read, rows, write } from '../index.js';

export interface ScanSource {
  project_id: string; resource_id: string; session_id: string; event_id: string; token_id: string;
  envelope_hash: string; content_revision: number; bytes: number;
}
export interface ScanCheckpointRow {
  session_id: string; event_id: string; token_id: string; envelope_hash: string; content_revision: number; bytes: number;
  scanned_bytes: number; hash_state: string; preview_bytes: string;
}

const slice = read<[from: number, length: number, project: string, event: string, revision: number, envelope: string], { bytes: Uint8Array | number[] }>({
  name: 'contentScan.slice', sql:
  `SELECT substr(CAST(payload AS BLOB),?1,?2) AS bytes FROM events
          WHERE project_id=?3 AND event_id=?4 AND content_revision=?5 AND payload_format='inline' AND envelope_hash=?6` });
/** `length` bytes of the inline body from one-based byte `from`, while the event still holds this exact revision inline; null otherwise. */
export async function inlineBodySlice(db: RelationalStore, row: ScanSource, from: number, length: number): Promise<Uint8Array | number[] | null> {
  return (await first(db, slice.bind(from, length, row.project_id, row.resource_id, row.content_revision, row.envelope_hash)))?.bytes ?? null;
}

const checkpoint = read<[project: string, kind: string, resource: string], ScanCheckpointRow>({ name: 'contentScan.checkpoint', sql:
  `SELECT session_id,event_id,token_id,envelope_hash,content_revision,bytes,
    scanned_bytes,hash_state,preview_bytes FROM content_scan_checkpoints
    WHERE project_id=?1 AND source_kind=?2 AND resource_id=?3` });
export const readScanCheckpoint = (db: RelationalStore, project: string, kind: string, resource: string): Promise<ScanCheckpointRow | null> =>
  first(db, checkpoint.bind(project, kind, resource));

const dropCheckpoint = write<[project: string, kind: string, resource: string, revision: number, envelope: string, scanned: number]>({ name: 'contentScan.dropCheckpoint', sql:
  `DELETE FROM content_scan_checkpoints WHERE project_id=?1 AND source_kind=?2 AND resource_id=?3
      AND content_revision=?4 AND envelope_hash=?5 AND scanned_bytes=?6` });
/** Removes the checkpoint as read, where it names another revision of the source. */
export async function dropScanCheckpoint(db: RelationalStore, project: string, kind: string, resource: string, held: ScanCheckpointRow): Promise<void> {
  await commit(db, dropCheckpoint.bind(project, kind, resource, held.content_revision, held.envelope_hash, held.scanned_bytes));
}

const SOURCE_HELD = `EXISTS (SELECT 1 FROM events WHERE project_id=?1 AND event_id=?5 AND session_id=?4 AND token_id=?6
    AND envelope_hash=?7 AND content_revision=?8 AND payload_format='inline' AND length(CAST(payload AS BLOB))=?9)`;
const startCheckpoint = write<[project: string, kind: string, resource: string, session: string, event: string, token: string, envelope: string,
  revision: number, bytes: number, scanned: number, state: string, preview: string, now: number], { stored: number }>({ name: 'contentScan.startCheckpoint', sql:
  `INSERT INTO content_scan_checkpoints(project_id,source_kind,resource_id,session_id,event_id,token_id,
          envelope_hash,content_revision,bytes,scanned_bytes,hash_state,preview_bytes,updated_at)
          SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13 WHERE ${SOURCE_HELD} RETURNING 1 AS stored` });
const advanceCheckpoint = write<[project: string, kind: string, resource: string, session: string, event: string, token: string, envelope: string,
  revision: number, bytes: number, scanned: number, state: string, preview: string, now: number, held: number], { stored: number }>({ name: 'contentScan.advanceCheckpoint', sql:
  `UPDATE content_scan_checkpoints SET scanned_bytes=?10,hash_state=?11,preview_bytes=?12,updated_at=?13
          WHERE project_id=?1 AND source_kind=?2 AND resource_id=?3 AND scanned_bytes=?14 AND content_revision=?8 AND envelope_hash=?7
          AND ${SOURCE_HELD} RETURNING 1 AS stored` });

/**
 * Records a scan through `scanned` bytes with its hash state and preview: a new checkpoint where `heldAt` is null, else
 * the one held at `heldAt` advanced. False when the source or the checkpoint moved.
 */
export async function writeScanCheckpoint(db: RelationalStore, kind: string, row: ScanSource,
  scan: { scanned: number; state: string; preview: string; now: number; heldAt: number | null }): Promise<boolean> {
  const values = [row.project_id, kind, row.resource_id, row.session_id, row.event_id, row.token_id, row.envelope_hash,
    row.content_revision, row.bytes, scan.scanned, scan.state, scan.preview, scan.now] as const;
  const stored = await rows(db, scan.heldAt === null ? startCheckpoint.bind(...values) : advanceCheckpoint.bind(...values, scan.heldAt));
  return stored.length === 1;
}
