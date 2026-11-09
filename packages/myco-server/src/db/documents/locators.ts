import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import type { ChunkRow } from '../../content/document-reader.js';
import { SESSION_OWNER } from '../document-tables.js';
import { assertion, commit, first, read, readSet, refusalCode, refused, write } from '../index.js';
import { jsonKeys } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * Repair of prompt page locators. A catch-up seeds one queue row for each live document holding a prompt whose page is
 * unknown (NULL) or recorded as held by none (-1), the prompts a document written before locators leaves. A repair
 * pass reads the document's page chunks from the row's cursor, records every prompt found on a page of its own turn's
 * owner, and, once the last chunk is read, records as -1 the prompts no such page held. Nothing lands unless the
 * chunks read are still the document's; a rebuilt session restarts the walk against its new generation.
 *
 * The publisher writes every prompt's page in the commit that lays its page out, so only the seeded documents need repair.
 */
const LOCATOR_PROJECTION = 'document_locators';
export const LOCATOR_PHASE = 'documentLocators';

const LOCATOR_PHASE_SOURCE = { table: 'session_prompts INDEXED BY idx_session_prompts_locator_repair',
  columns: ['project_id', 'session_id', 'generation', 'prompt_id'], where: '(page IS NULL OR page=-1)', startKey: ['', '', -1, ''], unique: true } as const;

const pageRows = write<[keys: string]>({ name: 'documentLocator.pageRows', sql: `INSERT INTO document_locator_repair(project_id,session_id,generation,locate_after,due_at)
  SELECT DISTINCT d.project_id,d.session_id,d.generation,NULL,0 FROM (${jsonKeys(['project_id', 'session_id', 'generation'])}) j
  CROSS JOIN session_documents d ON d.project_id=j.project_id AND d.session_id=j.session_id AND d.generation=j.generation AND d.state='live'
  WHERE true ON CONFLICT DO NOTHING` });
const LOCATOR_RECONCILE = [pageRows];

export const LOCATOR_CATCHUP = {
  projection: LOCATOR_PROJECTION,
  phases: { [LOCATOR_PHASE]: { source: LOCATOR_PHASE_SOURCE, reconcile: LOCATOR_RECONCILE } },
} as const satisfies CatchupFamily;

/** Retry delay for a document with no live generation yet or whose chunks moved during its read. */
export const LOCATOR_RETRY_MS = 60_000;

interface LocatorRepair { project_id: string; session_id: string; generation: number; locate_after: number | null; due_at: number;
  live_generation: number | null; publication_input_revision: number | null; rollup_due: number | null }

const CHUNKS_CHANGED = refusalCode('locator_chunks_changed');

const next = read<[due: number], LocatorRepair>({ name: 'documentLocator.next', sql: `
  SELECT q.project_id,q.session_id,q.generation,q.locate_after,q.due_at,d.generation AS live_generation,d.publication_input_revision,d.rollup_due
  FROM document_locator_repair q INDEXED BY idx_document_locator_repair_due
  LEFT JOIN session_documents d ON d.project_id=q.project_id AND d.session_id=q.session_id AND d.state='live'
  WHERE q.due_at<=?1 ORDER BY q.due_at,q.project_id,q.session_id LIMIT 1` });

const pageChunks = read<[project: string, session: string, generation: number, after: number, limit: number], ChunkRow>({ name: 'documentLocator.pageChunks', sql: `
  SELECT c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key
  FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.kind='page' AND c.chunk_no>?4
  ORDER BY c.chunk_no LIMIT ?5` });

/**
 * The page chunks the pass read are still the document's: same live generation and queue cursor, every chunk read still at the
 * version read, no page chunk added among them and, when the pass saw the last one, none after it.
 */
const chunksUnchanged = assertion<[project: string, session: string, generation: number, after: number | null, observed: string, through: number]>({
  name: 'documentLocator.chunksUnchanged', refusal: CHUNKS_CHANGED, when: `EXISTS (SELECT 1 FROM document_locator_repair WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND locate_after IS ?4)
    AND EXISTS (SELECT 1 FROM session_documents WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND state='live')
    AND NOT EXISTS (SELECT 1 FROM json_each(?5) j LEFT JOIN session_chunks c ON c.project_id=?1 AND c.session_id=?2 AND c.generation=?3
      AND c.chunk_no=json_extract(j.value,'$[0]') AND c.kind='page' WHERE c.source_id IS NOT json_extract(j.value,'$[1]'))
    AND (SELECT COUNT(*) FROM session_chunks WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND kind='page'
      AND chunk_no>COALESCE(?4,-1) AND chunk_no<=?6)=json_array_length(?5)` });

const place = write<[placed: string, project: string, session: string, generation: number, sessionOwner: string], { prompt_id: string }>({ name: 'documentLocator.place', sql: `
  WITH j(id,owner,page) AS MATERIALIZED (SELECT json_extract(value,'$.id'),json_extract(value,'$.owner'),json_extract(value,'$.page') FROM json_each(?1))
  UPDATE session_prompts SET page=j.page FROM j
  WHERE session_prompts.project_id=?2 AND session_prompts.session_id=?3 AND session_prompts.generation=?4 AND session_prompts.prompt_id=j.id AND session_prompts.prompt_id IN (SELECT id FROM j)
    AND j.owner=COALESCE(session_prompts.turn_key,?5) AND COALESCE(session_prompts.page,-1)=-1
  RETURNING prompt_id` });

const unplaced = write<[project: string, session: string, generation: number]>({ name: 'documentLocator.unplaced', sql:
  `UPDATE session_prompts INDEXED BY idx_session_prompts_locator_repair SET page=-1 WHERE project_id=? AND session_id=? AND generation=? AND (page IS NULL OR page=-1) AND page IS NULL` });

const advance = write<[after: number | null, project: string, session: string, generation: number, expected: number | null]>({ name: 'documentLocator.advance', sql:
  `UPDATE document_locator_repair SET locate_after=?1 WHERE project_id=?2 AND session_id=?3 AND generation=?4 AND locate_after IS ?5` });
const finish = write<[project: string, session: string, generation: number, expected: number | null]>({ name: 'documentLocator.finish', sql:
  `DELETE FROM document_locator_repair WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND locate_after IS ?4` });
const postpone = write<[next: number, project: string, session: string, due: number]>({ name: 'documentLocator.postpone', sql:
  `UPDATE document_locator_repair SET due_at=?1 WHERE project_id=?2 AND session_id=?3 AND due_at=?4` });
const rebind = write<[live: number, project: string, session: string, generation: number]>({ name: 'documentLocator.rebind', sql:
  `UPDATE document_locator_repair SET generation=?1,locate_after=NULL WHERE project_id=?2 AND session_id=?3 AND generation=?4` });

const pending = read<[project: string, session: string], { pending: number }>({ name: 'documentLocator.pending', sql: `SELECT EXISTS(SELECT 1 FROM document_locator_repair r WHERE r.project_id=?1 AND r.session_id=?2
    AND NOT EXISTS(SELECT 1 FROM session_documents d WHERE d.project_id=r.project_id AND d.session_id=r.session_id AND d.rollup_failure IS NOT NULL))
  OR EXISTS(SELECT 1 FROM projection_catchup WHERE projection='${LOCATOR_PROJECTION}' AND phase='${LOCATOR_PHASE}' AND done=0) AS pending` });

/** The queue row due first, with its document's live state; the selection every repair pass and its work answer share. */
export async function nextLocatorRepair(db: RelationalStore, due: number): Promise<LocatorRepair | null> {
  const [rows] = await readSet(db, next.bind(due));
  return rows[0] ?? null;
}

/** Up to `limit` page chunks after the repair's cursor, in chunk order. */
export async function locatorPageChunks(db: RelationalStore, repair: LocatorRepair, limit: number): Promise<ChunkRow[]> {
  const [rows] = await readSet(db, pageChunks.bind(repair.project_id, repair.session_id, repair.generation, repair.locate_after ?? -1, limit));
  return rows;
}

/** A repair that cannot run yet moves to its next attempt. */
export async function postponeLocatorRepair(db: RelationalStore, repair: LocatorRepair, nextAttempt: number): Promise<void> {
  await first(db, postpone.bind(nextAttempt, repair.project_id, repair.session_id, repair.due_at));
}

/** A rebuilt session restarts its walk on the live generation. */
export async function rebindLocatorRepair(db: RelationalStore, repair: LocatorRepair): Promise<void> {
  await first(db, rebind.bind(repair.live_generation!, repair.project_id, repair.session_id, repair.generation));
}

/** A prompt not found on its pages while its session's locators are still being repaired: not yet absent. */
export class TurnLocatorBuilding extends Error {
  constructor() { super('This turn is still being located in its session; try again shortly.'); }
}

/** Whether this session's locators may still be repaired, so a record not found on its pages is not yet absent. */
export async function locatorRepairPending(db: RelationalStore, project: string, session: string): Promise<boolean> {
  const [rows] = await readSet(db, pending.bind(project, session));
  return rows[0]!.pending === 1;
}

/**
 * Records the pages of the prompts the chunks hold, each under the page owner holding it, and moves the cursor past the chunks.
 * Once `finished`, a prompt no page of its owner holds is -1 and the queue row is settled. All of it lands only while
 * those chunks are still the document's; null when a concurrent write changed them, so nothing is recorded from a stale view.
 */
export async function commitLocated(db: RelationalStore, repair: LocatorRepair,
  { chunks: read, placed, finished }: { chunks: readonly ChunkRow[]; placed: readonly { id: string; owner: string; page: number }[]; finished: boolean }): Promise<number | null> {
  const key = [repair.project_id, repair.session_id, repair.generation] as const;
  const through = finished ? Number.MAX_SAFE_INTEGER : read.at(-1)?.chunk_no ?? repair.locate_after ?? -1;
  try {
    const [, located] = await commit(db,
      chunksUnchanged.bind(...key, repair.locate_after, JSON.stringify(read.map(row => [row.chunk_no, row.source_id])), through),
      place.bind(JSON.stringify(placed), ...key, SESSION_OWNER),
      ...(finished ? [unplaced.bind(...key), finish.bind(...key, repair.locate_after)] as const
        : [advance.bind(read.at(-1)?.chunk_no ?? repair.locate_after, ...key, repair.locate_after)] as const));
    return located.results.length;
  } catch (error) {
    if (refused(error, CHUNKS_CHANGED)) return null;
    throw error;
  }
}
