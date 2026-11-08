import type { RelationalStore } from '../../core/adapters.js';
import { HUBNESS_MEMBER as MEMBER } from '../../core/embedding/receipt-state.js';
import { commit, read, readSet, write } from '../index.js';
import { objectJournalSql } from '../storage/object-journal.js';

/** The members one stored page holds, and the most settled members left holding their bytes in the database. */
export const VECTOR_PAGE_MEMBERS = 50;
/** Pages one step hands to the release owner. */
const RECLAIM_PAGE = 16;

/** A page whose object is still being written and verified, and one members may name. */
export const VECTOR_PAGE = { writing: 0, sealed: 1 } as const;

/**
 * Stored pages of calibration member vectors. A member names its page and where its frame lies; `live` counts the members
 * naming a page, kept by triggers, so an unreferenced page is one index seek. A page with no live member is released,
 * and a page still being written is released once its write can no longer be in flight. A page id is never taken again,
 * so a member's locator, a live count or a late write naming an id can only ever mean the one page that holds that id.
 */
export function vectorPageSchema(projectIdCheck: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS embedding_vector_pages(page_id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL CHECK (${projectIdCheck}),model_key TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,size INTEGER NOT NULL,state INTEGER NOT NULL DEFAULT ${VECTOR_PAGE.writing} CHECK (state IN (${VECTOR_PAGE.writing},${VECTOR_PAGE.sealed})),
      live INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,missing_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS idx_embedding_vector_pages_unreferenced ON embedding_vector_pages(project_id,page_id) WHERE live=0',
    'ALTER TABLE embedding_hubness_members ADD COLUMN page_id INTEGER',
    'ALTER TABLE embedding_hubness_members ADD COLUMN page_offset INTEGER',
    'ALTER TABLE embedding_hubness_members ADD COLUMN page_length INTEGER',
    `CREATE INDEX IF NOT EXISTS idx_embedding_hubness_members_inline ON embedding_hubness_members(project_id,model_key,id) WHERE state=${MEMBER.settled} AND page_id IS NULL`,
  ];
}

/** Each member moving onto or off a page moves that page's live count. */
export function vectorPageTriggers(): Array<{ name: string; table: string; sql: string }> {
  return [
    { name: 'embedding_vector_page_member_update', table: 'embedding_hubness_members',
      sql: `CREATE TRIGGER IF NOT EXISTS embedding_vector_page_member_update AFTER UPDATE OF page_id ON embedding_hubness_members WHEN OLD.page_id IS NOT NEW.page_id BEGIN
        UPDATE embedding_vector_pages SET live=live-1 WHERE page_id=OLD.page_id; UPDATE embedding_vector_pages SET live=live+1 WHERE page_id=NEW.page_id; END` },
    { name: 'embedding_vector_page_member_delete', table: 'embedding_hubness_members',
      sql: `CREATE TRIGGER IF NOT EXISTS embedding_vector_page_member_delete AFTER DELETE ON embedding_hubness_members WHEN OLD.page_id IS NOT NULL BEGIN
        UPDATE embedding_vector_pages SET live=live-1 WHERE page_id=OLD.page_id; END` },
  ];
}

/** A settled member still holding its vector in the database. */
export interface InlineVector { id: string; vector: string }
const inlinePage = read<[string, string, number], InlineVector>({ name: 'vectorPages.inlineMembers',
  sql: `SELECT m.id AS id,m.vector AS vector FROM embedding_hubness_members m INDEXED BY idx_embedding_hubness_members_inline
    WHERE m.project_id=?1 AND m.model_key=?2 AND m.state=${MEMBER.settled} AND m.page_id IS NULL ORDER BY m.id LIMIT ?3` });
/** The settled members still holding their bytes, in id order, at most `limit`. */
export async function inlineVectors(db: RelationalStore, projectId: string, model: string, limit: number): Promise<InlineVector[]> {
  const [rows] = await readSet(db, inlinePage.bind(projectId, model, limit));
  return rows;
}

const begin = write<[string, string, string, number, number], { page_id: number }>({ name: 'vectorPages.begin',
  sql: `INSERT INTO embedding_vector_pages(project_id,model_key,object_key,size,created_at) VALUES(?1,?2,?3,?4,?5) RETURNING page_id` });
/** Record that an object is about to be written, so a write that never commits is released rather than forgotten. */
export async function beginVectorPage(db: RelationalStore, projectId: string, model: string, objectKey: string, size: number, now: number): Promise<number> {
  const [result] = await commit(db, begin.bind(projectId, model, objectKey, size, now));
  return result.results[0]!.page_id;
}

const releaseWrite = write<[string, number]>({ name: 'vectorPages.releaseUnsealed',
  sql: objectJournalSql(`SELECT ?1,'upload',?2 WHERE NOT EXISTS (SELECT 1 FROM embedding_vector_pages WHERE object_key=?1)`) });
/** A write whose page row is already gone hands its object to the release owner: its object may land after the release owner has passed it. */
export async function releaseUnsealedObject(db: RelationalStore, objectKey: string, now: number): Promise<void> {
  await commit(db, releaseWrite.bind(objectKey, now));
}

/** Where a sealed page's bytes are held, and when a read first found them gone. */
export interface VectorPageRow { page_id: number; object_key: string; size: number; missing_at: number | null }
const sealedPages = read<[string], VectorPageRow>({ name: 'vectorPages.sealed',
  sql: `SELECT page_id,object_key,size,missing_at FROM embedding_vector_pages WHERE page_id IN (SELECT value FROM json_each(?1)) AND state=${VECTOR_PAGE.sealed}` });
export async function vectorPageRows(db: RelationalStore, pageIds: readonly number[]): Promise<VectorPageRow[]> {
  const [rows] = await readSet(db, sealedPages.bind(JSON.stringify(pageIds)));
  return rows;
}

const noteMissing = write<[number, number]>({ name: 'vectorPages.noteMissing', sql: 'UPDATE embedding_vector_pages SET missing_at=?2 WHERE page_id=?1 AND missing_at IS NULL' });
/** Remember when a read first found a page's bytes gone or damaged. */
export async function noteVectorPageMissing(db: RelationalStore, pageId: number, now: number): Promise<void> {
  await commit(db, noteMissing.bind(pageId, now));
}

const SEALED_MODELS = `SELECT project_id,model_key FROM embedding_vector_pages WHERE state=${VECTOR_PAGE.sealed}`;
const recoveredMembers = write<[]>({ name: 'vectorPages.recoveredMembers', sql: `DELETE FROM embedding_hubness_members WHERE (project_id,model_key) IN (${SEALED_MODELS})` });
const recoveredCursors = write<[]>({ name: 'vectorPages.recoveredCursors',
  sql: `UPDATE embedding_cursors SET hubness_cursor=NULL,hubness_count=NULL WHERE project_id IN (SELECT project_id FROM (${SEALED_MODELS}))` });
const recoveredPages = write<[]>({ name: 'vectorPages.recoveredPages', sql: 'DELETE FROM embedding_vector_pages' });
/**
 * A native recovery volume carries the page rows without the page objects. Every model with a sealed page loses its
 * memberships, which calibration takes again from the carried vectors, and no row names a page the volume does not hold.
 */
export async function discardRecoveredVectorPages(db: RelationalStore): Promise<void> {
  await commit(db, recoveredMembers.bind(), recoveredCursors.bind(), recoveredPages.bind());
}

const unreferenced = `SELECT page_id,object_key FROM embedding_vector_pages INDEXED BY idx_embedding_vector_pages_unreferenced
  WHERE project_id=?1 AND live=0 AND (state=${VECTOR_PAGE.sealed} OR created_at<=?2) ORDER BY page_id LIMIT ?3`;
const journal = write<[string, number, number, number]>({ name: 'vectorPages.journal',
  sql: objectJournalSql(`SELECT object_key,'upload',?4 FROM (${unreferenced}) WHERE true`) });
const forget = write<[string, number, number], { page_id: number }>({ name: 'vectorPages.forget',
  sql: `DELETE FROM embedding_vector_pages WHERE page_id IN (SELECT page_id FROM (${unreferenced})) RETURNING page_id` });
/**
 * Hand pages no member names to the release owner and forget them, in one transaction. Pages are never part of a
 * snapshot, so they are journaled as unregistered bytes. Answers how many went.
 */
export async function reclaimVectorPages(db: RelationalStore, projectId: string, abandonedBefore: number, now: number): Promise<number> {
  const [, forgotten] = await commit(db, journal.bind(projectId, abandonedBefore, RECLAIM_PAGE, now), forget.bind(projectId, abandonedBefore, RECLAIM_PAGE));
  return forgotten.results.length;
}

const reclaimHead = read<[string, number], { found: number }>({ name: 'vectorPages.reclaimDue',
  sql: `SELECT 1 AS found FROM embedding_vector_pages INDEXED BY idx_embedding_vector_pages_unreferenced
    WHERE project_id=?1 AND live=0 AND (state=${VECTOR_PAGE.sealed} OR created_at<=?2) LIMIT 1` });
const sealHead = read<[string, string], { found: number }>({ name: 'vectorPages.sealDue',
  sql: `SELECT 1 AS found FROM embedding_hubness_members INDEXED BY idx_embedding_hubness_members_inline
    WHERE project_id=?1 AND model_key=?2 AND state=${MEMBER.settled} AND page_id IS NULL ORDER BY id LIMIT 1 OFFSET ${VECTOR_PAGE_MEMBERS - 1}` });
/** A page no member names is waiting to be released. */
export const reclaimDue = (projectId: string, abandonedBefore: number) => reclaimHead.bind(projectId, abandonedBefore);
/** A full page of settled members still holds its bytes in the database. */
export const sealDue = (projectId: string, model: string) => sealHead.bind(projectId, model);
