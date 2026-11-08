import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import type { ChunkRow } from '../../content/document-reader.js';
import { assertion, commit, read, readSet, write } from '../index.js';

export interface UnlocatedDocument { project_id: string; session_id: string; generation: number; locate_after: number | null }

const CHUNKS_CHANGED = 'locator_chunks_changed';

const unlocated = read<[due: number], UnlocatedDocument>({ name: 'documentLocator.unlocated', sql: `
  SELECT p.project_id,p.session_id,p.generation,d.locate_after
  FROM session_prompts p INDEXED BY idx_session_prompts_unlocated
  JOIN session_documents d ON d.project_id=p.project_id AND d.session_id=p.session_id AND d.generation=p.generation AND d.state='live'
  WHERE p.page IS NULL AND d.rollup_due<=? LIMIT 1` });
const pageChunks = read<[project: string, session: string, generation: number, after: number, limit: number], ChunkRow>({ name: 'documentLocator.pageChunks', sql: `
  SELECT c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key
  FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.kind='page' AND c.chunk_no>?4
  ORDER BY c.chunk_no LIMIT ?5` });
/**
 * The page chunks the wake read are still the document's: same live generation and frontier, every chunk read still at the
 * version read, no page chunk added among them and, when the wake saw the last one, none after it.
 */
const chunksUnchanged = assertion<[project: string, session: string, generation: number, after: number | null, observed: string, through: number]>({
  name: 'documentLocator.chunksUnchanged', sql: `
  SELECT CASE WHEN EXISTS (SELECT 1 FROM session_documents WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND state='live' AND locate_after IS ?4)
    AND NOT EXISTS (SELECT 1 FROM json_each(?5) j LEFT JOIN session_chunks c ON c.project_id=?1 AND c.session_id=?2 AND c.generation=?3
      AND c.chunk_no=json_extract(j.value,'$[0]') AND c.kind='page' WHERE c.source_id IS NOT json_extract(j.value,'$[1]'))
    AND (SELECT COUNT(*) FROM session_chunks WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND kind='page'
      AND chunk_no>COALESCE(?4,-1) AND chunk_no<=?6)=json_array_length(?5)
  THEN 1 ELSE json_extract('[]','$[${CHUNKS_CHANGED}]') END` });
const place = write<[placed: string, project: string, session: string, generation: number]>({ name: 'documentLocator.place', sql: `
  UPDATE session_prompts SET page=(SELECT json_extract(j.value,'$.page') FROM json_each(?1) j WHERE json_extract(j.value,'$.id')=session_prompts.prompt_id)
  WHERE project_id=?2 AND session_id=?3 AND generation=?4 AND prompt_id IN (SELECT json_extract(value,'$.id') FROM json_each(?1)) AND page IS NULL` });
const unplaced = write<[project: string, session: string, generation: number]>({ name: 'documentLocator.unplaced', sql:
  `UPDATE session_prompts SET page=-1 WHERE project_id=? AND session_id=? AND generation=? AND page IS NULL` });
const advance = write<[after: number | null, project: string, session: string, generation: number]>({ name: 'documentLocator.advance', sql:
  `UPDATE session_documents SET locate_after=? WHERE project_id=? AND session_id=? AND generation=? AND state='live'` });

/** A live document holding a prompt with no locator, once its rollups are due. */
export async function nextUnlocatedDocument(db: RelationalStore, due: number): Promise<UnlocatedDocument | null> {
  const [rows] = await readSet(db, unlocated.bind(due));
  return rows[0] ?? null;
}

/** Up to `limit` page chunks after the document's locator frontier, in chunk order. */
export async function locatorPageChunks(db: RelationalStore, doc: UnlocatedDocument, limit: number): Promise<ChunkRow[]> {
  const [rows] = await readSet(db, pageChunks.bind(doc.project_id, doc.session_id, doc.generation, doc.locate_after ?? -1, limit));
  return rows;
}

function changed(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(CHUNKS_CHANGED) || changed(error.cause);
}

/**
 * Records the pages of the prompts held by the chunks read and moves the frontier past them; once `finished`, a prompt no
 * page holds is recorded as page -1. All of it lands only while those chunks are still the document's; false when a
 * concurrent write changed them, so nothing is recorded from a stale view.
 */
export async function commitLocated(db: RelationalStore, doc: UnlocatedDocument, read: readonly ChunkRow[],
  placed: readonly { id: string; page: number }[], finished: boolean): Promise<boolean> {
  const key = [doc.project_id, doc.session_id, doc.generation] as const;
  const through = finished ? Number.MAX_SAFE_INTEGER : read.at(-1)?.chunk_no ?? doc.locate_after ?? -1;
  try {
    await commit(db,
      chunksUnchanged.bind(...key, doc.locate_after, JSON.stringify(read.map(row => [row.chunk_no, row.source_id])), through),
      place.bind(JSON.stringify(placed), ...key),
      ...(finished ? [unplaced.bind(...key)] : []),
      advance.bind(read.at(-1)?.chunk_no ?? doc.locate_after, ...key));
    return true;
  } catch (error) {
    if (changed(error)) return false;
    throw error;
  }
}
