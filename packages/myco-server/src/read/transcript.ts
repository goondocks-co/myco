import type { RelationalStore } from '../core/adapters.js';
import { readSet, rows } from '../db/index.js';
import { archivedSegmentsPage, heldByIdentity, heldBySessionPage, hotSegmentsPage, sessionsHoldingTranscript, transcriptsOfRole, type TranscriptPageRow } from '../db/transcripts/reads.js';
import { binaryOrder,clampLimit,decodeCursor,encodeCursor,page,type Page,type ReadScope } from './scope.js';

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

/** Transcripts one discovery read holds in a page; a session's rotations are read to the end, never capped. */
const HELD_PAGE = 200;

/**
 * The held transcripts of any of these sessions, or under any of these identities.
 *
 * Both halves are needed and answer different questions. The identity match says where to resume a transcript the
 * Deployment already has; the session match says whether a DIFFERENT identity for the same session is the same file
 * renamed, which must not be re-derived, or a rotation, which is history worth importing. Only the head digest tells those
 * two apart. Sessions are paged to their end, so a rename is never mistaken for a rotation.
 */
export async function heldTranscriptsFor(db: RelationalStore, scope: ReadScope, sessionIds: readonly string[], transcriptIds: readonly string[]): Promise<HeldTranscript[]> {
  const held = new Map<string, HeldTranscript>();
  const keep = (row: { transcript_id: string; session_id: string; size: number; head_hash: string | null; role: string }) =>
    held.set(row.transcript_id, { transcriptId: row.transcript_id, sessionId: row.session_id, size: row.size, headHash: row.head_hash, role: row.role });
  if (transcriptIds.length > 0) (await rows(db, heldByIdentity.bind(scope.projectId, JSON.stringify(transcriptIds)))).forEach(keep);
  if (sessionIds.length === 0) return [...held.values()];
  const sessions = JSON.stringify(sessionIds);
  let afterSession = '', afterTranscript = '';
  for (;;) {
    const page = await rows(db, heldBySessionPage.bind(scope.projectId, sessions, afterSession, afterTranscript, HELD_PAGE));
    page.forEach(keep);
    const last = page.at(-1);
    if (last === undefined || page.length < HELD_PAGE) return [...held.values()];
    afterSession = last.session_id;
    afterTranscript = last.transcript_id;
  }
}

/** Which of these sessions hold a transcript: an existence answer, so it costs one index probe per session whatever each session holds. */
export async function sessionsWithTranscript(db: RelationalStore, scope: ReadScope, sessionIds: readonly string[], options: { machineId?: string; nonEmpty?: true } = {}): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const held = await rows(db, sessionsHoldingTranscript.bind(scope.projectId, JSON.stringify(sessionIds), options.machineId ?? null, options.nonEmpty === true ? 1 : 0));
  return new Set(held.map(row => row.session_id));
}

export interface SegmentRow {
  baseOffset: number;
  length: number;
  blobKey: string;
  createdAt: number;
  availability: 'hot' | 'archived';
}

function toTranscript(row: TranscriptPageRow): TranscriptRow {
  return {
    transcriptId: row.transcript_id,
    sessionId: row.session_id,
    machineId: row.machine_id,
    agent: row.agent,
    originPath: row.origin_path,
    size: row.size,
    segmentCount: row.segment_count,
    firstReceivedAt: row.first_received_at,
    lastReceivedAt: row.last_received_at,
    role: row.role ?? 'primary',
    parsedOffset: row.parsed_offset ?? 0,
    parsedAt: row.parsed_at,
    fidelity: row.fidelity,
    parseError: row.parse_error,
    parseFailedAt: row.parse_failed_at,
  };
}

/** A transcript's place in the ordered listing, primaries before subagent siblings. */
export const transcriptCursor = (row: TranscriptRow): string => encodeCursor(row.role === 'subagent' ? 1 : 0, row.transcriptId);

/**
 * A page of a session's transcripts, the primary first and each role ordered by id, so a reader sees the same order on
 * every target and every call. Reads `limit + 1` rows so the caller knows whether another page follows.
 */
export async function listTranscripts(db: RelationalStore, scope: ReadScope, sessionId: string, paging: { after?: string; limit: number; transcriptId?: string }): Promise<TranscriptRow[]> {
  const after = paging.after === undefined ? null : decodeCursor(paging.after);
  if (paging.after !== undefined && (after === null || (after.createdAt !== 0 && after.createdAt !== 1))) return [];
  const startRole = after?.createdAt ?? 0;
  const only = paging.transcriptId ?? null;
  const rowsWanted = paging.limit + 1;
  const first = await rows(db, transcriptsOfRole.bind(scope.projectId, sessionId, startRole, after?.id ?? '', only, rowsWanted));
  if (first.length >= rowsWanted || startRole === 1) return first.map(toTranscript);
  const rest = await rows(db, transcriptsOfRole.bind(scope.projectId, sessionId, 1, '', only, rowsWanted - first.length));
  return [...first, ...rest].map(toTranscript);
}

/** Hot and archived segment sources each seek and bound their complete order before merging. */
export async function pageSegments(db: RelationalStore, scope: ReadScope, transcriptId: string, opts: { limit?: number; cursor?: string } = {}): Promise<Page<SegmentRow>> {
  return (await pageSegmentsAcross(db, scope, [transcriptId], opts))[0]!;
}

/** The same page for several transcripts, read in one store round trip. */
export async function pageSegmentsAcross(db: RelationalStore, scope: ReadScope, transcriptIds: readonly string[], opts: { limit?: number; cursor?: string } = {}): Promise<Page<SegmentRow>[]> {
  const limit = clampLimit(opts.limit), after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return transcriptIds.map(() => ({ rows: [], cursor: null }));
  const fromOffset = after?.createdAt ?? -1, afterId = after?.id ?? '';
  const statements = transcriptIds.flatMap(transcript => [
    hotSegmentsPage.bind(scope.projectId, transcript, fromOffset, afterId, limit + 1),
    archivedSegmentsPage.bind(scope.projectId, transcript, fromOffset, afterId, limit + 1),
  ]);
  const pages = await readSet(db, ...statements);
  return transcriptIds.map((_, index) => {
    const merged: SegmentRow[] = [
      ...pages[index * 2]!.map(row => ({ baseOffset: row.base_offset, length: row.length, blobKey: row.blob_key, createdAt: row.created_at, availability: 'hot' as const })),
      ...pages[index * 2 + 1]!.map(row => ({ baseOffset: row.base_offset, length: row.length, blobKey: row.blob_key, createdAt: row.created_at, availability: 'archived' as const })),
    ];
    merged.sort((a, b) => a.baseOffset - b.baseOffset || binaryOrder(a.availability, b.availability) || binaryOrder(a.blobKey, b.blobKey));
    return page(merged, limit, row => ({ createdAt: row.baseOffset, id: `${row.availability}:${row.blobKey}` }));
  });
}
