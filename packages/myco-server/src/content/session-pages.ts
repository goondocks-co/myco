import { recordMycoFields } from './tool-rollup.js';
import { promptEnvelope } from '@goondocks/myco-shared/capture-rules';
/**
 * Request-time reads of a session's live document. Every read names the pages or chunks it wants through bounded
 * directory statements, so a request costs a fixed number of catalog rows and blob GETs whatever the session's size. A chunk
 * read once in a request is not read again.
 */
import type { ContentStore } from '../core/adapters.js';
import { toolInputPreview } from '../core/tool-input.js';
import type { DocRecord, Page } from './document.js';
import { liveChunk, liveDocumentGeneration, ownerLastPage, ownerPageRows, pageChunksAfter, pageChunksBefore } from '../db/documents/live-document.js';
import { readBodyChunk, readPageChunk, type ChunkRow } from './document-reader.js';
import { readStoredRange } from '../core/stored-object.js';

/** Pages of one turn a turn read opens at most. */
export const TURN_PAGES = 4;

/** Where a record sits: its owner's page, in the live generation. */
export interface PageLocator { generation: number; owner: string; page: number; revision?: string }

/** A page and the immutable chunk version that published its location. */
export interface LocatedPage extends Page { revision: string }

export class DocumentBodyUnavailable extends Error {
  constructor(readonly reason: string) { super(`document_body_${reason}`); }
}

export class SessionDocument {
  /** Blob GETs this request made. */
  gets = 0;
  private readonly chunks = new Map<number, Promise<LocatedPage[]>>();

  private constructor(private readonly env: ContentStore, readonly projectId: string, readonly sessionId: string, readonly generation: number) {}

  private get ref() { return { project: this.projectId, session: this.sessionId, generation: this.generation }; }

  /** The live document of a session, or null while it has none. */
  static async open(env: ContentStore, projectId: string, sessionId: string): Promise<SessionDocument | null> {
    const generation = await liveDocumentGeneration(env.db, projectId, sessionId);
    return generation === null ? null : new SessionDocument(env, projectId, sessionId, generation);
  }

  private pagesIn(row: ChunkRow): Promise<LocatedPage[]> {
    let held = this.chunks.get(row.chunk_no);
    if (held === undefined) {
      this.gets += 1;
      held = readPageChunk(this.env, row).then((chunk) => chunk.pages.map(page => ({ ...page, revision: row.source_id })));
      this.chunks.set(row.chunk_no, held);
    }
    return held;
  }

  /** The number of an owner's last page, or null when it holds none. */
  async lastPage(owner: string): Promise<number | null> {
    return ownerLastPage(this.env.db, this.ref, owner);
  }

  /** An owner's pages from `from` on, at most `limit`, each with its records; `more` says whether pages remain. */
  async ownerPages(owner: string, from: number, limit: number): Promise<{ pages: LocatedPage[]; more: boolean }> {
    const rows = await ownerPageRows(this.env.db, this.ref, { owner, from, limit: limit + 1 });
    const pages: LocatedPage[] = [];
    for (const row of rows.slice(0, limit)) {
      const page = (await this.pagesIn(row)).find((held) => held.owner === owner && held.page === row.page);
      if (page === undefined) throw new Error('document_page_missing');
      pages.push(page);
    }
    return { pages, more: rows.length > limit };
  }

  /** The page chunks after `after`, in chunk order, at most `limit`, each with its pages. */
  async chunksAfter(after: number, limit: number): Promise<{ chunks: { chunkNo: number; pages: LocatedPage[] }[]; more: boolean }> {
    const rows = await pageChunksAfter(this.env.db, this.ref, { after, limit: limit + 1 });
    const chunks = [];
    for (const row of rows.slice(0, limit)) chunks.push({ chunkNo: row.chunk_no, pages: await this.pagesIn(row) });
    return { chunks, more: rows.length > limit };
  }

  /** The page chunks before `before`, newest first, at most `limit`, each with its pages. */
  async chunksBefore(before: number, limit: number): Promise<{ chunks: { chunkNo: number; pages: LocatedPage[] }[]; more: boolean }> {
    const rows = await pageChunksBefore(this.env.db, this.ref, { before, limit: limit + 1 });
    const chunks = [];
    for (const row of rows.slice(0, limit)) chunks.push({ chunkNo: row.chunk_no, pages: await this.pagesIn(row) });
    return { chunks, more: rows.length > limit };
  }

  /** The complete text of a record's body field: inline, or read from its body chunk. */
  async body(record: DocRecord, field: string): Promise<string | null> {
    const ref = record.bodies?.[field];
    if (ref === undefined) return typeof record[field] === 'string' ? (record[field] as string) : null;
    const row = await liveChunk(this.env.db, this.ref, ref.chunk);
    if (row === null) throw new Error('document_object_missing');
    this.gets += 1;
    return readBodyChunk(this.env, row);
  }

  async assertBodyAvailable(record: DocRecord, field: string): Promise<void> {
    const ref = record.bodies?.[field];
    if (ref === undefined) return;
    const row = await liveChunk(this.env.db, this.ref, ref.chunk);
    if (row?.object_key == null) throw new DocumentBodyUnavailable('absent');
    const object = await this.env.blobs.head(row.object_key);
    if (object === null) throw new DocumentBodyUnavailable('absent');
    if (object.size !== ref.bytes) throw new DocumentBodyUnavailable('size_mismatch');
  }

  /** A UTF-8 aligned prefix of a stored body's byte range; the next offset follows the returned text's bytes. */
  async bodyWindow(record: DocRecord, field: string, offset: number, limit: number): Promise<string> {
    const ref = record.bodies?.[field];
    if (ref === undefined) throw new Error('document_body_reference_missing');
    const row = await liveChunk(this.env.db, this.ref, ref.chunk);
    if (row?.object_key == null) throw new DocumentBodyUnavailable('absent');
    if (row.kind !== 'body') throw new Error('document_chunk_kind');
    const length = Math.min(limit, ref.bytes - offset);
    this.gets += 1;
    const held = await readStoredRange(this.env.blobs, row.object_key, ref.bytes, offset, length);
    if (held.kind !== 'read') throw new DocumentBodyUnavailable(held.kind);
    return new TextDecoder('utf-8', { fatal: true }).decode(held.bytes, { stream: offset + length < ref.bytes });
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
const locatorOf = (at: PageLocator) => ({ generation: at.generation, owner: at.owner, page: at.page, revision: at.revision });

/** A prompt record as the wire carries it; `blobKey` names a body held in its own chunk. */
export function promptRow(record: DocRecord, at: PageLocator) {
  const display = record.envelope === undefined && typeof record.text === 'string' && record.bodies?.text === undefined ? promptEnvelope(record.text) : null;
  return {
    promptId: record.id, text: display?.text ?? str(record.text), envelope: record.envelope ?? display?.envelope ?? null,
    blobKey: record.bodies?.text?.digest ?? null, origin: str(record.origin) ?? 'user',
    originSessionId: str(record.origin_session_id),
    claim: str(record.claim), promptKind: str(record.prompt_kind), parentPromptId: str(record.parent_prompt_id), threadLabel: str(record.thread_label),
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
    toolCallId: record.id, nested: record.nested === true, promptId: record.prompt_id, toolName: str(record.tool_name) ?? 'unknown', mycoTool: recordMycoFields(record).tool,
    mycoOp: recordMycoFields(record).op, inputPreview: input?.preview ?? null,
    inputBytes: typeof record.input_bytes === 'number' ? record.input_bytes : null,
    inputTruncated: (input?.truncated ?? false) || record.bodies?.input !== undefined, inputBlobKey: record.bodies?.input?.digest ?? null,
    outputPreview: str(record.output_preview), outputBlobKey: null, success: record.success !== 0, errorMessage: str(record.error_message),
    resultReason: str(record.result_reason),
    durationMs: typeof record.duration_ms === 'number' ? record.duration_ms : null,
    filesAffected: files.length === 0 ? null : JSON.stringify(files), createdAt: record.created_at, orderedAt: record.created_at,
    locator: locatorOf(at),
  };
}

export type PromptWireRow = ReturnType<typeof promptRow> & { invocation?: import('../read/session-invocations.js').SessionInvocation };
export type ResponseWireRow = ReturnType<typeof responseRow>;
export type ToolCallWireRow = ReturnType<typeof toolCallRow>;

const BODY_FIELD = { prompt: ['prompt', 'text'], response: ['reply', 'text'], 'tool-input': ['tool', 'input'], 'tool-output': ['tool', 'output_preview'] } as const;
type DocumentBodyKind = keyof typeof BODY_FIELD;
export const isDocumentBodyKind = (kind: string): kind is DocumentBodyKind => Object.hasOwn(BODY_FIELD, kind);

/**
 * The complete body of one record the session's live document holds, found on the page its locator names: a prompt's
 * or reply's text, or a tool's input. A tool's output is its kept preview. Null when no live document or current revision holds the record;
 * `stale` when the locator's generation or location revision is no longer live.
 */
export async function documentBody(env: ContentStore, projectId: string, sessionId: string, kind: DocumentBodyKind, id: string,
  at: PageLocator): Promise<string | null | 'stale'> {
  const doc = await SessionDocument.open(env, projectId, sessionId);
  if (doc === null) return null;
  if (doc.generation !== at.generation) return 'stale';
  const [recordKind, field] = BODY_FIELD[kind];
  const read = await doc.ownerPages(at.owner, at.page, 1);
  const page = read.pages.find(page => page.page === at.page);
  const record = page?.records.find((held) => held.k === recordKind && held.id === id);
  if (record !== undefined) return doc.body(record, field);
  return at.revision === undefined || page?.revision !== at.revision ? 'stale' : null;
}
