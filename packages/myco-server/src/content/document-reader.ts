/**
 * Reading a session document: the live generation's directory from the catalog, and its chunks from the blob store.
 * Each object is read through its registered key, and a chunk the catalog names but the store lacks is corruption,
 * never an empty result.
 */
import type { ContentStore, RelationalStore } from '../core/adapters.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { decodePageChunk, type DecodedChunk, type DocRecord } from './document.js';

export interface ChunkRow {
  chunk_no: number;
  blob_key: string;
  kind: 'page' | 'body';
  bytes: number;
  source_id: string;
  object_key: string | null;
}
export interface PageRow { owner: string; page: number; chunk_no: number; records: number; bytes: number }
export interface Directory { generation: number; chunks: Map<number, ChunkRow>; pages: PageRow[] }

/** Chunk rows of one generation with the stored object each names; binds `?1` project and `?2` session. */
export const chunkRowsSql = (generation = '?3'): string => `SELECT c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,
  ${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key
  FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=${generation} ORDER BY c.chunk_no`;
/** Page rows of one generation; binds `?1` project and `?2` session. */
export const pageRowsSql = (generation = '?3'): string => `SELECT owner,page,chunk_no,records,bytes FROM session_pages
  WHERE project_id=?1 AND session_id=?2 AND generation=${generation} ORDER BY owner,page`;

export function directoryOf(generation: number, chunks: readonly ChunkRow[], pages: readonly PageRow[]): Directory {
  return { generation, chunks: new Map(chunks.map((row) => [row.chunk_no, row])), pages: [...pages] };
}

/** The live generation's directory of a session, or null while it has no live document. */
export async function readDirectory(db: RelationalStore, projectId: string, sessionId: string): Promise<Directory | null> {
  const doc = await db.prepare(`SELECT generation FROM session_documents WHERE project_id=? AND session_id=? AND state='live'`)
    .bind(projectId, sessionId).first<{ generation: number | null }>();
  if (doc?.generation == null) return null;
  const [chunks, pages] = await db.batch([
    db.prepare(chunkRowsSql()).bind(projectId, sessionId, doc.generation),
    db.prepare(pageRowsSql()).bind(projectId, sessionId, doc.generation),
  ]);
  return directoryOf(doc.generation, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
}

async function opened(env: Pick<ContentStore, 'blobs'>, row: ChunkRow) {
  if (row.object_key === null) throw new Error('document_object_missing');
  const object = await env.blobs.get(row.object_key);
  if (object === null) throw new Error('document_object_missing');
  return object;
}

/** A page chunk's pages and continuation. */
export async function readPageChunk(env: Pick<ContentStore, 'blobs'>, row: ChunkRow): Promise<DecodedChunk> {
  if (row.kind !== 'page') throw new Error('document_chunk_kind');
  return decodePageChunk((await opened(env, row)).body);
}

/** A body chunk's complete text. */
export async function readBodyChunk(env: Pick<ContentStore, 'blobs'>, row: ChunkRow): Promise<string> {
  if (row.kind !== 'body') throw new Error('document_chunk_kind');
  return new Response((await opened(env, row)).body).text();
}

/** One page's records from the live generation, or null when the session has no such page. */
export async function readPage(env: ContentStore, projectId: string, sessionId: string, owner: string, page: number): Promise<DocRecord[] | null> {
  const row = await env.db.prepare(`SELECT c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,
      ${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key
    FROM session_documents d JOIN session_pages p ON p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation
    JOIN session_chunks c ON c.project_id=p.project_id AND c.session_id=p.session_id AND c.generation=p.generation AND c.chunk_no=p.chunk_no
    WHERE d.project_id=? AND d.session_id=? AND d.state='live' AND p.owner=? AND p.page=?`)
    .bind(projectId, sessionId, owner, page).first<ChunkRow>();
  if (row === null) return null;
  const held = (await readPageChunk(env, row)).pages.find((p) => p.owner === owner && p.page === page);
  if (held === undefined) throw new Error('document_page_missing');
  return held.records;
}
