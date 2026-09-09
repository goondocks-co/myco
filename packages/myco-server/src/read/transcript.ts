import type { RelationalStore } from '../core/adapters.js';
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
  /** The session's own transcript, or a subagent sibling beside it. */
  role: string;
  /** How far the server has parsed, and what it read the file as; null fidelity means no parse has classified it yet. */
  parsedOffset: number;
  parsedAt: number | null;
  fidelity: string | null;
  /** The classifier of the failure that stopped this transcript's parse, or null while it is healthy. */
  parseError: string | null;
  parseFailedAt: number | null;
}

/** What an import needs to know about a transcript this Project holds: where to resume it, and what its head says it is. */
export interface HeldTranscript {
  transcriptId: string;
  sessionId: string;
  size: number;
  headHash: string | null;
  role: string;
}

/**
 * The held transcripts of any of these sessions, or under any of these
 * identities.
 *
 * Both halves are needed and answer different questions. The identity match
 * says where to resume a transcript the Deployment already has; the session
 * match says whether a DIFFERENT identity for the same session is the same file
 * renamed — which must not be re-derived — or a rotation, which is history
 * worth importing. Only the head digest tells those two apart.
 */
export async function heldTranscriptsFor(
  db: RelationalStore, scope: ReadScope, sessionIds: readonly string[], transcriptIds: readonly string[],
): Promise<HeldTranscript[]> {
  // One statement per key, not one with an OR across two. An OR leaves the
  // planner a single equality to work with and it falls back to scanning the
  // table; separately, each half is an index lookup. It also removes the
  // `IN ()` an empty list would produce, which is a syntax error rather than an
  // empty answer.
  const rows = new Map<string, HeldTranscript>();
  for (const [column, keys] of [['session_id', sessionIds], ['transcript_id', transcriptIds]] as const) {
    if (keys.length === 0) continue;
    const { results } = await db
      .prepare(`SELECT transcript_id, session_id, size, head_hash, role FROM transcripts
                 WHERE project_id = ? AND ${column} IN (${keys.map(() => '?').join(', ')})`)
      .bind(scope.projectId, ...keys)
      .all<{ transcript_id: string; session_id: string; size: number; head_hash: string | null; role: string }>();
    for (const r of results) {
      rows.set(r.transcript_id, { transcriptId: r.transcript_id, sessionId: r.session_id, size: r.size, headHash: r.head_hash, role: r.role });
    }
  }
  return [...rows.values()];
}

export interface SegmentRow {
  baseOffset: number;
  length: number;
  blobKey: string;
  createdAt: number;
}

const TRANSCRIPT_COLUMNS = `transcript_id, session_id, machine_id, agent, origin_path, size, segment_count,
     first_received_at, last_received_at, role, parsed_offset, parsed_at, fidelity, parse_error, parse_failed_at`;

function toTranscript(row: Record<string, unknown>): TranscriptRow {
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
    role: (row.role as string | null) ?? 'primary',
    parsedOffset: (row.parsed_offset as number | null) ?? 0,
    parsedAt: (row.parsed_at as number | null) ?? null,
    fidelity: (row.fidelity as string | null) ?? null,
    parseError: (row.parse_error as string | null) ?? null,
    parseFailedAt: (row.parse_failed_at as number | null) ?? null,
  };
}

/**
 * Every transcript a session holds, the primary first.
 *
 * A session holds more than one as soon as a subagent sibling is shipped beside
 * the primary, so a reader that takes the first row of an unordered result
 * shows one of several chosen by the store. Ordering by role then id makes the
 * answer the same on every target and on every call.
 */
export async function listTranscripts(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<TranscriptRow[]> {
  const { results } = await db
    .prepare(`SELECT ${TRANSCRIPT_COLUMNS} FROM transcripts WHERE project_id = ? AND session_id = ?
              ORDER BY CASE WHEN role = 'subagent' THEN 1 ELSE 0 END, transcript_id`)
    .bind(scope.projectId, sessionId)
    .all<Record<string, unknown>>();
  return results.map(toTranscript);
}

/** A transcript's segments in offset order. */
export async function listSegments(db: RelationalStore, scope: ReadScope, transcriptId: string): Promise<SegmentRow[]> {
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
