/**
 * Reading a session document: the live generation's directory from the catalog, and its chunks from the blob store.
 * Each object is read through its registered key, and a chunk the catalog names but the store lacks is corruption,
 * never an empty result.
 */
import type { ContentStore, RelationalStore } from '../core/adapters.js';
import { generationDirectory, liveDocumentGeneration, livePageChunk } from '../db/documents/live-document.js';
import { decodePageChunk, type DecodedChunk, type DocRecord } from './document.js';

export interface ChunkRow {
  metadata?: number;
  chunk_no: number;
  blob_key: string;
  kind: 'page' | 'body';
  bytes: number;
  source_id: string;
  object_key: string | null;
}
export interface PageRow { owner: string; page: number; chunk_no: number; records: number; bytes: number; sealed?: number }
interface Directory { generation: number; chunks: Map<number, ChunkRow>; pages: PageRow[] }

function directoryOf(generation: number, chunks: readonly ChunkRow[], pages: readonly PageRow[]): Directory {
  return { generation, chunks: new Map(chunks.map((row) => [row.chunk_no, row])), pages: [...pages] };
}

/** The live generation's directory of a session, or null while it has no live document. */
export async function readDirectory(db: RelationalStore, projectId: string, sessionId: string): Promise<Directory | null> {
  const generation = await liveDocumentGeneration(db, projectId, sessionId);
  if (generation === null) return null;
  const { chunks, pages } = await generationDirectory(db, { project: projectId, session: sessionId, generation });
  return directoryOf(generation, chunks, pages);
}

async function opened(env: Pick<ContentStore, 'blobs'>, row: ChunkRow) {
  if (row.object_key === null) throw new Error('document_object_missing');
  const object = await env.blobs.get(row.object_key);
  if (object === null) throw new Error('document_object_missing');
  return object;
}

/** A page chunk's pages and continuation. */
export async function readPageChunk(env: Pick<ContentStore, 'blobs'>, row: ChunkRow): Promise<DecodedChunk> {
  if (row.kind !== 'page' && row.metadata !== 1) throw new Error('document_chunk_kind');
  const chunk = await decodePageChunk((await opened(env, row)).body);
  return row.metadata === 1 ? { ...chunk, pages: [] } : chunk;
}

/** A body chunk's complete text. */
export async function readBodyChunk(env: Pick<ContentStore, 'blobs'>, row: ChunkRow): Promise<string> {
  if (row.kind !== 'body') throw new Error('document_chunk_kind');
  return new Response((await opened(env, row)).body).text();
}

/** One page's records from the live generation, or null when the session has no such page. */
export async function readPage(env: ContentStore, projectId: string, sessionId: string, owner: string, page: number): Promise<DocRecord[] | null> {
  const row = await livePageChunk(env.db, projectId, sessionId, { owner, page });
  if (row === null) return null;
  const held = (await readPageChunk(env, row)).pages.find((p) => p.owner === owner && p.page === page);
  if (held === undefined) throw new Error('document_page_missing');
  return held.records;
}
