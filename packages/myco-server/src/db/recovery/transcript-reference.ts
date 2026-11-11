/**
 * Restoring an imported transcript's raw reference. The reference lands only where the destination holds the same
 * transcript, every one of its segments as the artifact lists them, and no raw owner that disagrees with the artifact's;
 * the insert commits with a guard that re-checks the transcript and the provenance revision the decision read.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { commit, first, read, write, type BindValue, type Bound } from '../index.js';
import { effectiveRawOwnerSql, rawProvenanceRevision } from '../raw/claims.js';

const TRANSCRIPT_RAW_COLUMNS = ['project_id', 'transcript_id', 'session_id', 'machine_id', 'token_id', 'agent', 'origin_path', 'role', 'head_hash', 'size', 'segment_count', 'first_received_at', 'last_received_at', 'imported_at'] as const;
const TRANSCRIPT_SEGMENT_COLUMNS = ['project_id', 'transcript_id', 'base_offset', 'length', 'blob_key', 'event_id', 'created_at', 'received_at', 'token_id'] as const;
/** Artifact segments one agreement read compares. */
const SEGMENT_PAGE = 20;

const heldOwner = effectiveRawOwnerSql('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id');
const importedOwner = effectiveRawOwnerSql("json_extract(candidate.value, '$.owner_member_id')", "json_extract(candidate.value, '$.provenance')", "json_extract(candidate.value, '$.revision')", "json_extract(candidate.value, '$.claim_member_id')");
/** ?1 the expected transcript, ?2 the Project, ?3 the transcript, ?4 its artifact segment count, ?5 the artifact's reference row. */
const COMPATIBLE = `EXISTS (SELECT 1 FROM transcripts held, json_each(?1) expected WHERE ${TRANSCRIPT_RAW_COLUMNS
    .map((column) => `held.${column} IS json_extract(expected.value, '$.${column}')`).join(' AND ')})
  AND (SELECT COUNT(*) FROM transcript_segments WHERE project_id = ?2 AND transcript_id = ?3) = ?4
  AND NOT EXISTS (SELECT 1 FROM raw_resources r, json_each(?5) candidate
    WHERE r.project_id = ?2 AND r.kind = 'transcript' AND r.resource_id = ?3
      AND (r.provenance = 'ambiguous'
        OR (r.claim_member_id IS NOT NULL AND r.claim_member_id IS NOT COALESCE(${importedOwner}, json_extract(candidate.value, '$.claim_member_id')))
        OR (${heldOwner} IS NOT NULL AND ${heldOwner} IS NOT ${importedOwner})))`;
type Compatibility = [expected: string, project: BindValue, transcript: BindValue, segments: number, reference: string];

const compatible = read<Compatibility, { matches: number }>({ name: 'recovery.transcriptReferenceCompatible', sql: `SELECT (${COMPATIBLE}) AS matches` });
const segmentsAgree = read<[page: string], { matches: number }>({ name: 'recovery.transcriptSegmentsAgree', sql:
  `SELECT (NOT EXISTS (SELECT 1 FROM json_each(?1) expected LEFT JOIN transcript_segments held
    ON held.project_id = json_extract(expected.value, '$.project_id')
      AND held.transcript_id = json_extract(expected.value, '$.transcript_id')
      AND held.base_offset = json_extract(expected.value, '$.base_offset')
    WHERE held.base_offset IS NULL OR ${TRANSCRIPT_SEGMENT_COLUMNS
      .map((column) => `held.${column} IS NOT json_extract(expected.value, '$.${column}')`).join(' OR ')})) AS matches` });
const stillCompatible = write<[...Compatibility, revision: number]>({ name: 'recovery.transcriptReferenceHolds', sql:
  `INSERT INTO restore_reference_guard (missing)
    SELECT 'transcript ownership conflicts with held raw data'
      WHERE NOT ((SELECT revision FROM raw_provenance_state WHERE id = 1) = ?6 AND (${COMPATIBLE}))` });

async function agrees(db: RelationalStore, bound: Bound<{ matches: number }, 'read'>): Promise<boolean> {
  const result = await first(db, bound);
  if (result === null) throw new Error('Transcript restore comparison returned no result');
  return result.matches === 1;
}

/**
 * Imported transcript attribution requires the held raw identity, bytes and existing owners to agree: `insert`, the
 * artifact's reference row, commits only then, and the answer is the rows it inserted.
 */
export async function restoreTranscriptReference(
  db: RelationalStore, row: Readonly<Record<string, unknown>>, transcript: Readonly<Record<string, unknown>> | undefined,
  segments: readonly Record<string, unknown>[], insert: Bound<unknown, 'write'>,
): Promise<number> {
  if (transcript === undefined) return 0;
  const expected = Object.fromEntries(TRANSCRIPT_RAW_COLUMNS.map((column) => [column,
    transcript[column] ?? (column === 'role' ? 'primary' : column === 'size' || column === 'segment_count' ? 0 : null)]));
  const compatibility: Compatibility = [JSON.stringify([expected]), row.project_id as BindValue, row.resource_id as BindValue, segments.length, JSON.stringify([row])];
  const revision = await rawProvenanceRevision(db);
  if (revision === null) throw new Error('Raw provenance revision is missing');
  if (!await agrees(db, compatible.bind(...compatibility))) return 0;
  for (let start = 0; start < segments.length; start += SEGMENT_PAGE) {
    if (!await agrees(db, segmentsAgree.bind(JSON.stringify(segments.slice(start, start + SEGMENT_PAGE))))) return 0;
  }
  const [, applied] = await commit(db, stillCompatible.bind(...compatibility, revision), insert);
  return applied.results.length;
}
