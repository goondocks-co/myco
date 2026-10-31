/**
 * Request-time reads of a session's live document. Every read names the pages or chunks it wants through bounded
 * directory statements, so a request costs a fixed number of catalog rows and blob GETs whatever the session's size. A chunk
 * read once in a request is not read again.
 */
import type { ContentStore } from '../core/adapters.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { toolInputPreview } from '../core/tool-input.js';
import type { DocRecord, Page } from './document.js';
import { readBodyChunk, readPageChunk, type ChunkRow } from './document-reader.js';

/** Page chunks one request reads at most. */
export const REQUEST_CHUNKS = 8;
/** Pages of one turn a turn read opens at most. */
export const TURN_PAGES = 4;

const CHUNK_COLUMNS = `c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key`;
const LIVE = `FROM session_documents d JOIN session_chunks c ON c.project_id=d.project_id AND c.session_id=d.session_id AND c.generation=d.generation`;

/** Where a record sits: its owner's page, in the live generation. */
export interface PageLocator { generation: number; owner: string; page: number }

export class SessionDocument {
  /** Blob GETs this request made. */
  gets = 0;
  private readonly chunks = new Map<number, Promise<Page[]>>();

  private constructor(private readonly env: ContentStore, readonly projectId: string, readonly sessionId: string, readonly generation: number) {}

  /** The live document of a session, or null while it has none. */
  static async open(env: ContentStore, projectId: string, sessionId: string): Promise<SessionDocument | null> {
    const row = await env.db.prepare(`SELECT generation FROM session_documents WHERE project_id=? AND session_id=? AND state='live'`)
      .bind(projectId, sessionId).first<{ generation: number | null }>();
    return row?.generation == null ? null : new SessionDocument(env, projectId, sessionId, row.generation);
  }

  private pagesIn(row: ChunkRow): Promise<Page[]> {
    let held = this.chunks.get(row.chunk_no);
    if (held === undefined) {
      this.gets += 1;
      held = readPageChunk(this.env, row).then((chunk) => chunk.pages);
      this.chunks.set(row.chunk_no, held);
    }
    return held;
  }

  /** An owner's pages from `from` on, at most `limit`, each with its records; `more` says whether pages remain. */
  async ownerPages(owner: string, from: number, limit: number): Promise<{ pages: Page[]; more: boolean }> {
    const rows = (await this.env.db.prepare(`SELECT p.page,${CHUNK_COLUMNS} ${LIVE}
        JOIN session_pages p ON p.project_id=c.project_id AND p.session_id=c.session_id AND p.generation=c.generation AND p.chunk_no=c.chunk_no
      WHERE d.project_id=? AND d.session_id=? AND d.state='live' AND d.generation=? AND p.owner=? AND p.page>=? ORDER BY p.page LIMIT ?`)
      .bind(this.projectId, this.sessionId, this.generation, owner, from, limit + 1).all<ChunkRow & { page: number }>()).results;
    const pages: Page[] = [];
    for (const row of rows.slice(0, limit)) {
      const page = (await this.pagesIn(row)).find((held) => held.owner === owner && held.page === row.page);
      if (page === undefined) throw new Error('document_page_missing');
      pages.push(page);
    }
    return { pages, more: rows.length > limit };
  }

  /** The page chunks after `after`, in chunk order, at most `limit`, each with its pages. */
  async chunksAfter(after: number, limit: number): Promise<{ chunks: { chunkNo: number; pages: Page[] }[]; more: boolean }> {
    const rows = (await this.env.db.prepare(`SELECT ${CHUNK_COLUMNS} ${LIVE}
      WHERE d.project_id=? AND d.session_id=? AND d.state='live' AND d.generation=? AND c.kind='page' AND c.chunk_no>? ORDER BY c.chunk_no LIMIT ?`)
      .bind(this.projectId, this.sessionId, this.generation, after, limit + 1).all<ChunkRow>()).results;
    const chunks = [];
    for (const row of rows.slice(0, limit)) chunks.push({ chunkNo: row.chunk_no, pages: await this.pagesIn(row) });
    return { chunks, more: rows.length > limit };
  }

  /** The page chunks before `before`, newest first, at most `limit`, each with its pages. */
  async chunksBefore(before: number, limit: number): Promise<{ chunks: { chunkNo: number; pages: Page[] }[]; more: boolean }> {
    const rows = (await this.env.db.prepare(`SELECT ${CHUNK_COLUMNS} ${LIVE}
      WHERE d.project_id=? AND d.session_id=? AND d.state='live' AND d.generation=? AND c.kind='page' AND c.chunk_no<? ORDER BY c.chunk_no DESC LIMIT ?`)
      .bind(this.projectId, this.sessionId, this.generation, before, limit + 1).all<ChunkRow>()).results;
    const chunks = [];
    for (const row of rows.slice(0, limit)) chunks.push({ chunkNo: row.chunk_no, pages: await this.pagesIn(row) });
    return { chunks, more: rows.length > limit };
  }

  /** The complete text of a record's body field: inline, or read from its body chunk. */
  async body(record: DocRecord, field: string): Promise<string | null> {
    const ref = record.bodies?.[field];
    if (ref === undefined) return typeof record[field] === 'string' ? (record[field] as string) : null;
    const row = await this.env.db.prepare(`SELECT ${CHUNK_COLUMNS} ${LIVE}
      WHERE d.project_id=? AND d.session_id=? AND d.state='live' AND d.generation=? AND c.chunk_no=?`)
      .bind(this.projectId, this.sessionId, this.generation, ref.chunk).first<ChunkRow>();
    if (row === null) throw new Error('document_object_missing');
    this.gets += 1;
    return readBodyChunk(this.env, row);
  }
}

/** A cursor over a session's pages or chunks, valid only while its generation is live. */
export function pageCursor(generation: number, at: number): string {
  return `${generation}:${at}`;
}

/** The position a cursor names, or null when it is malformed; `stale` when its generation is no longer live. */
export function readPageCursor(cursor: string | undefined, generation: number): { at: number } | 'stale' | null {
  if (cursor === undefined) return { at: -1 };
  const match = /^([0-9]+):(-?[0-9]+)$/.exec(cursor);
  if (match === null) return null;
  return Number(match[1]) === generation ? { at: Number(match[2]) } : 'stale';
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const locatorOf = (at: PageLocator) => ({ generation: at.generation, owner: at.owner, page: at.page });

/** A prompt record as the wire carries it; `blobKey` names a body held in its own chunk. */
export function promptRow(record: DocRecord, at: PageLocator) {
  return {
    promptId: record.id, text: str(record.text), blobKey: record.bodies?.text?.digest ?? null, origin: str(record.origin) ?? 'user',
    promptKind: str(record.prompt_kind), parentPromptId: str(record.parent_prompt_id), threadLabel: str(record.thread_label),
    createdAt: record.created_at, orderedAt: record.created_at, locator: locatorOf(at),
  };
}

export function responseRow(record: DocRecord, at: PageLocator) {
  return {
    responseId: record.id, promptId: record.prompt_id, text: str(record.text), blobKey: record.bodies?.text?.digest ?? null,
    createdAt: record.created_at, orderedAt: record.created_at, locator: locatorOf(at),
  };
}

/** A tool record as the wire carries it: an input preview, the output preview only, and the files it named. */
export function toolCallRow(record: DocRecord, at: PageLocator) {
  const input = typeof record.input === 'string' ? toolInputPreview(record.input) : null;
  const files = Array.isArray(record.files_affected) ? record.files_affected.filter((path): path is string => typeof path === 'string') : [];
  return {
    toolCallId: record.id, promptId: record.prompt_id, toolName: str(record.tool_name) ?? 'unknown', mycoTool: str(record.myco_tool),
    mycoOp: str(record.myco_op), inputPreview: input?.preview ?? null,
    inputBytes: typeof record.input_bytes === 'number' ? record.input_bytes : null,
    inputTruncated: (input?.truncated ?? false) || record.bodies?.input !== undefined, inputBlobKey: record.bodies?.input?.digest ?? null,
    outputPreview: str(record.output_preview), outputBlobKey: null, success: record.success !== 0, errorMessage: str(record.error_message),
    durationMs: typeof record.duration_ms === 'number' ? record.duration_ms : null,
    filesAffected: files.length === 0 ? null : JSON.stringify(files), createdAt: record.created_at, orderedAt: record.created_at,
    locator: locatorOf(at),
  };
}

export type PromptWireRow = ReturnType<typeof promptRow>;
export type ResponseWireRow = ReturnType<typeof responseRow>;
export type ToolCallWireRow = ReturnType<typeof toolCallRow>;

const BODY_FIELD = { prompt: ['prompt', 'text'], response: ['reply', 'text'], 'tool-input': ['tool', 'input'], 'tool-output': ['tool', 'output_preview'] } as const;
export type DocumentBodyKind = keyof typeof BODY_FIELD;
export const isDocumentBodyKind = (kind: string): kind is DocumentBodyKind => Object.hasOwn(BODY_FIELD, kind);

/**
 * The complete body of one record the session's live document holds, found on the page its locator names: a prompt's
 * or reply's text, or a tool's input. A tool's output is its kept preview. Null when the page holds no such record;
 * `stale` when the locator names a generation no longer live.
 */
export async function documentBody(env: ContentStore, projectId: string, sessionId: string, kind: DocumentBodyKind, id: string,
  at: PageLocator): Promise<string | null | 'stale'> {
  const doc = await SessionDocument.open(env, projectId, sessionId);
  if (doc === null) return null;
  if (doc.generation !== at.generation) return 'stale';
  const [recordKind, field] = BODY_FIELD[kind];
  const read = await doc.ownerPages(at.owner, at.page, 1);
  const record = read.pages[0]?.records.find((held) => held.k === recordKind && held.id === id);
  return record === undefined ? null : doc.body(record, field);
}
