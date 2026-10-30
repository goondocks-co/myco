/**
 * The session document format.
 *
 * A document is a set of immutable chunks. A page chunk is one gzip stream of NDJSON: page headers
 * (`{k:"page",owner,page}`) each followed by that page's records, and, in the session's last page chunk only, the
 * publisher's continuation (`{k:"state"}` per transcript, one `{k:"owners"}` and one `{k:"plans"}`). A page holds records of one owner,
 * a turn key or `''` for the session, at most `DOCUMENT_PAGE_BYTES` encoded, and never spans chunks. A body chunk
 * holds one body, uncompressed, for a record that would not fit an empty page.
 */
import { utf8, utf8Preview } from '../hash.js';

export const DOCUMENT_FORMAT = 1;
/** Encoded bytes one page holds, its header included. */
export const DOCUMENT_PAGE_BYTES = 262_144;
/** Uncompressed bytes one page chunk holds. */
export const DOCUMENT_CHUNK_BYTES = 1_048_576;
/** Bytes a record keeps of a body that moved to a body chunk, and of a tool's output. */
export const DOCUMENT_PREVIEW_BYTES = 4_096;
/** The owner of records no turn resolves. */
export const SESSION_OWNER = '';

export const PAGE_ENCODING = 'gzip-ndjson';
export const BODY_ENCODING = 'identity';

export type RecordKind = 'prompt' | 'reply' | 'tool' | 'plan';

/** Where a body that left its record is held: a body chunk of the record's own generation. */
export interface BodyRef { chunk: number; bytes: number; digest: string }

/** One record. Fields are the material columns; `src` is `[transcript, offset, end]`, `ev` a member event id. */
export interface DocRecord {
  k: RecordKind;
  id: string;
  prompt_id: string | null;
  created_at: number;
  src?: readonly [string, number, number];
  ev?: string;
  bodies?: Record<string, BodyRef>;
  [field: string]: unknown;
}

export interface Page { owner: string; page: number; records: DocRecord[] }

export interface DecodedChunk {
  pages: Page[];
  /** The parser continuation of each transcript, by transcript id. */
  states: Map<string, Record<string, unknown>>;
  /** The session's harness key owners, as `[key, {thread, record}]`. */
  owners: [string, { thread: string; record: string }][] | null;
  /** The canonical plan keys the document holds an appearance of. */
  plans?: string[];
}

/** The body field of each record kind, the one field that may leave its record. */
export const BODY_FIELDS: Readonly<Record<RecordKind, readonly string[]>> = {
  prompt: ['text'],
  reply: ['text'],
  tool: ['input'],
  plan: ['content'],
};

const lineBytes = (value: unknown): number => utf8(JSON.stringify(value)).byteLength + 1;
export const recordBytes = lineBytes;
export const pageHeaderBytes = (owner: string, page: number): number => lineBytes({ k: 'page', owner, page });
export const pageBytes = (page: Page): number =>
  pageHeaderBytes(page.owner, page.page) + page.records.reduce((sum, record) => sum + recordBytes(record), 0);

/** A record's own bytes leave room on an empty page for its header at the largest page number a session reaches. */
const RECORD_ROOM = DOCUMENT_PAGE_BYTES - pageHeaderBytes('x'.repeat(256), Number.MAX_SAFE_INTEGER);

/** A body that must move out of its record: its field and complete text. */
export interface ExtractedBody { field: string; text: string }

/**
 * The record as a page holds it. While the whole encoded record exceeds an empty page, its largest inline body moves
 * out, leaving a bounded preview; `place` names the body chunk that will hold each moved body.
 */
export function fitRecord(record: DocRecord, place: (body: ExtractedBody) => BodyRef): DocRecord {
  let fitted = record;
  while (recordBytes(fitted) > RECORD_ROOM) {
    const field = BODY_FIELDS[fitted.k]
      .filter((name) => typeof fitted[name] === 'string' && fitted.bodies?.[name] === undefined)
      .sort((a, b) => utf8(String(fitted[b])).byteLength - utf8(String(fitted[a])).byteLength)[0];
    if (field === undefined) throw new Error('document_record_too_large');
    const text = String(fitted[field]);
    fitted = {
      ...fitted,
      [field]: utf8Preview(text, DOCUMENT_PREVIEW_BYTES).preview,
      bodies: { ...fitted.bodies, [field]: place({ field, text }) },
    };
  }
  return fitted;
}

/** Bytes of a page chunk before compression. */
export function chunkBytes(pages: readonly Page[], states: ReadonlyMap<string, Record<string, unknown>>, owners: DecodedChunk['owners']): number {
  return pages.reduce((sum, page) => sum + pageBytes(page), 0)
    + [...states].reduce((sum, [t, c]) => sum + lineBytes({ k: 'state', t, c }), 0)
    + (owners === null ? 0 : lineBytes({ k: 'owners', owners }));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A page chunk's stored bytes. */
export async function encodePageChunk(chunk: DecodedChunk): Promise<Uint8Array> {
  const lines: string[] = [JSON.stringify({ k: 'chunk', format: DOCUMENT_FORMAT })];
  for (const page of chunk.pages) {
    lines.push(JSON.stringify({ k: 'page', owner: page.owner, page: page.page }));
    for (const record of page.records) lines.push(JSON.stringify(record));
  }
  for (const [t, c] of chunk.states) lines.push(JSON.stringify({ k: 'state', t, c }));
  if (chunk.owners !== null) lines.push(JSON.stringify({ k: 'owners', owners: chunk.owners }));
  if (chunk.plans !== undefined) lines.push(JSON.stringify({ k: 'plans', keys: chunk.plans }));
  const text = utf8(`${lines.join('\n')}\n`);
  return collect(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')));
}

/** A page chunk read back from its stored bytes. */
export async function decodePageChunk(body: ReadableStream<Uint8Array>): Promise<DecodedChunk> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await collect((body as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream('gzip'))));
  const chunk: DecodedChunk = { pages: [], states: new Map(), owners: null };
  let open: Page | null = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const value = JSON.parse(line) as { k: string } & Record<string, unknown>;
    if (value.k === 'chunk') {
      if (value.format !== DOCUMENT_FORMAT) throw new Error('document_format_unknown');
    } else if (value.k === 'page') {
      open = { owner: String(value.owner), page: Number(value.page), records: [] };
      chunk.pages.push(open);
    } else if (value.k === 'state') chunk.states.set(String(value.t), value.c as Record<string, unknown>);
    else if (value.k === 'owners') chunk.owners = value.owners as DecodedChunk['owners'];
    else if (value.k === 'plans') chunk.plans = value.keys as string[];
    else if (open === null) throw new Error('document_record_without_page');
    else open.records.push(value as unknown as DocRecord);
  }
  return chunk;
}
