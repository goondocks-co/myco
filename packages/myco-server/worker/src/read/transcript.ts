import type { D1Like } from '../env.js';
import type { ReadScope } from './scope.js';

export interface TranscriptRow {
  transcriptId: string;
  sessionId: string;
  machineId: string;
  agent: string | null;
  originPath: string | null;
  size: number;
  segmentCount: number;
  firstReceivedAt: number;
  lastReceivedAt: number;
}

export interface SegmentRow {
  baseOffset: number;
  length: number;
  blobKey: string;
  createdAt: number;
}

/** The transcript recorded for a session inside the scope, or null. */
export async function getTranscript(db: D1Like, scope: ReadScope, sessionId: string): Promise<TranscriptRow | null> {
  const row = await db
    .prepare(
      `SELECT transcript_id, session_id, machine_id, agent, origin_path, size, segment_count, first_received_at, last_received_at
         FROM transcripts WHERE project_id = ? AND session_id = ?`
    )
    .bind(scope.projectId, sessionId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  return {
    transcriptId: row.transcript_id as string,
    sessionId: row.session_id as string,
    machineId: row.machine_id as string,
    agent: (row.agent as string | null) ?? null,
    originPath: (row.origin_path as string | null) ?? null,
    size: row.size as number,
    segmentCount: row.segment_count as number,
    firstReceivedAt: row.first_received_at as number,
    lastReceivedAt: row.last_received_at as number,
  };
}

/** A transcript's segments in offset order. */
export async function listSegments(db: D1Like, scope: ReadScope, transcriptId: string): Promise<SegmentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT base_offset, length, blob_key, created_at FROM transcript_segments
        WHERE project_id = ? AND transcript_id = ? ORDER BY base_offset ASC`
    )
    .bind(scope.projectId, transcriptId)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    baseOffset: r.base_offset as number,
    length: r.length as number,
    blobKey: r.blob_key as string,
    createdAt: r.created_at as number,
  }));
}
