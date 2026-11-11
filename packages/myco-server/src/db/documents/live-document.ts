import type { RelationalStore } from '../../core/adapters.js';
import type { ChunkRow, PageRow } from '../../content/document-reader.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import { read, readSet } from '../index.js';

const CHUNK_COLUMNS = `c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key`;
const DIRECTORY_CHUNK_COLUMNS = `c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,c.metadata,
  ${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key`;
const LIVE = `FROM session_documents d JOIN session_chunks c ON c.project_id=d.project_id AND c.session_id=d.session_id AND c.generation=d.generation`;

const generation = read<[project: string, session: string], { generation: number | null }>({ name: 'liveDocument.generation', sql:
  `SELECT generation FROM session_documents WHERE project_id=?1 AND session_id=?2 AND state='live'` });
const directoryChunks = read<[project: string, session: string, generation: number], ChunkRow>({ name: 'liveDocument.directoryChunks', sql:
  `SELECT ${DIRECTORY_CHUNK_COLUMNS} FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 ORDER BY c.chunk_no` });
const directoryPages = read<[project: string, session: string, generation: number], PageRow>({ name: 'liveDocument.directoryPages', sql:
  `SELECT owner,page,chunk_no,records,bytes,sealed FROM session_pages
    WHERE project_id=?1 AND session_id=?2 AND generation=?3 ORDER BY owner,page` });
const pageChunk = read<[project: string, session: string, owner: string, page: number], ChunkRow>({ name: 'liveDocument.pageChunk', sql:
  `SELECT ${DIRECTORY_CHUNK_COLUMNS}
    FROM session_documents d JOIN session_pages p ON p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation
    JOIN session_chunks c ON c.project_id=p.project_id AND c.session_id=p.session_id AND c.generation=p.generation AND c.chunk_no=p.chunk_no
    WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND p.owner=?3 AND p.page=?4` });
const lastPage = read<[project: string, session: string, generation: number, owner: string], { page: number | null }>({ name: 'liveDocument.lastPage', sql:
  `SELECT MAX(page) AS page FROM session_pages WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND owner=?4` });
const ownerPageChunks = read<[project: string, session: string, generation: number, owner: string, from: number, limit: number], ChunkRow & { page: number }>({ name: 'liveDocument.ownerPageChunks', sql:
  `SELECT p.page,${CHUNK_COLUMNS} ${LIVE}
      JOIN session_pages p ON p.project_id=c.project_id AND p.session_id=c.session_id AND p.generation=c.generation AND p.chunk_no=c.chunk_no
    WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND d.generation=?3 AND p.owner=?4 AND p.page>=?5 ORDER BY p.page LIMIT ?6` });
const chunksAfter = read<[project: string, session: string, generation: number, after: number, limit: number], ChunkRow>({ name: 'liveDocument.chunksAfter', sql:
  `SELECT ${CHUNK_COLUMNS} ${LIVE}
    WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND d.generation=?3 AND c.kind='page' AND c.chunk_no>?4 ORDER BY c.chunk_no LIMIT ?5` });
const chunksBefore = read<[project: string, session: string, generation: number, before: number, limit: number], ChunkRow>({ name: 'liveDocument.chunksBefore', sql:
  `SELECT ${CHUNK_COLUMNS} ${LIVE}
    WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND d.generation=?3 AND c.kind='page' AND c.chunk_no<?4 ORDER BY c.chunk_no DESC LIMIT ?5` });
const chunkAt = read<[project: string, session: string, generation: number, chunk: number], ChunkRow>({ name: 'liveDocument.chunkAt', sql:
  `SELECT ${CHUNK_COLUMNS} ${LIVE}
    WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND d.generation=?3 AND c.chunk_no=?4` });

/** One generation of one session's document. */
export interface DocumentGeneration { project: string; session: string; generation: number }

/** The generation of a session's live document, or null while it has none. */
export async function liveDocumentGeneration(db: RelationalStore, project: string, session: string): Promise<number | null> {
  const [[row]] = await readSet(db, generation.bind(project, session));
  return row?.generation ?? null;
}

/** Every chunk row and page row of one generation, in directory order. */
export async function generationDirectory(db: RelationalStore, doc: DocumentGeneration): Promise<{ chunks: ChunkRow[]; pages: PageRow[] }> {
  const [chunks, pages] = await readSet(db, directoryChunks.bind(doc.project, doc.session, doc.generation), directoryPages.bind(doc.project, doc.session, doc.generation));
  return { chunks, pages };
}

/** The chunk of the live document that holds an owner's page, or null. */
export async function livePageChunk(db: RelationalStore, project: string, session: string, at: { owner: string; page: number }): Promise<ChunkRow | null> {
  const [[row]] = await readSet(db, pageChunk.bind(project, session, at.owner, at.page));
  return row ?? null;
}

/** The number of an owner's last page in the generation, or null when it holds none. */
export async function ownerLastPage(db: RelationalStore, doc: DocumentGeneration, owner: string): Promise<number | null> {
  const [[row]] = await readSet(db, lastPage.bind(doc.project, doc.session, doc.generation, owner));
  return row?.page ?? null;
}

/** Up to `limit` of an owner's pages from `from` on, each with the chunk that holds it. */
export async function ownerPageRows(db: RelationalStore, doc: DocumentGeneration, request: { owner: string; from: number; limit: number }): Promise<(ChunkRow & { page: number })[]> {
  const [rows] = await readSet(db, ownerPageChunks.bind(doc.project, doc.session, doc.generation, request.owner, request.from, request.limit));
  return rows;
}

/** Up to `limit` page chunks after chunk `after`, in chunk order. */
export async function pageChunksAfter(db: RelationalStore, doc: DocumentGeneration, request: { after: number; limit: number }): Promise<ChunkRow[]> {
  const [rows] = await readSet(db, chunksAfter.bind(doc.project, doc.session, doc.generation, request.after, request.limit));
  return rows;
}

/** Up to `limit` page chunks before chunk `before`, newest first. */
export async function pageChunksBefore(db: RelationalStore, doc: DocumentGeneration, request: { before: number; limit: number }): Promise<ChunkRow[]> {
  const [rows] = await readSet(db, chunksBefore.bind(doc.project, doc.session, doc.generation, request.before, request.limit));
  return rows;
}

/** The chunk numbered `chunk` in the live generation, or null. */
export async function liveChunk(db: RelationalStore, doc: DocumentGeneration, chunk: number): Promise<ChunkRow | null> {
  const [[row]] = await readSet(db, chunkAt.bind(doc.project, doc.session, doc.generation, chunk));
  return row ?? null;
}
