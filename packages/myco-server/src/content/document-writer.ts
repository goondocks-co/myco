/**
 * Changes to one generation of a session document, held in memory until they are written as new chunk versions.
 *
 * Records are placed by owner: a new record goes on its owner's last page while it fits, else on a new page. A record
 * arriving under an id its owner already holds is merged in place, and when the page it sits on no longer fits, the
 * owner's pages from that page on are refilled by encoded size. Every chunk holding a changed page is rewritten whole;
 * pages that no longer fit their chunk, and new pages, fill the session's last page chunk and then new chunks. The
 * last page chunk written carries the continuation.
 */
import {
  DOCUMENT_CHUNK_BYTES, DOCUMENT_PAGE_BYTES, fitRecord, pageBytes, pageHeaderBytes, recordBytes, SESSION_OWNER,
  type BodyRef, type DecodedChunk, type DocRecord, type Page,
} from './document.js';
import { mergeRecord } from './document-records.js';
import type { ChunkRow, Directory } from './document-reader.js';

export interface PageChunkWrite { chunkNo: number; chunk: DecodedChunk; previous: ChunkRow | undefined }
export interface BodyChunkWrite { chunkNo: number; text: string; ref: BodyRef }
export interface PageWrite { owner: string; page: number; chunkNo: number; records: number; bytes: number }
export interface DocumentLayout { pageChunks: PageChunkWrite[]; bodyChunks: BodyChunkWrite[]; pages: PageWrite[] }

export type Upsert = { outcome: 'inserted'; record: DocRecord } | { outcome: 'merged'; record: DocRecord; held: DocRecord } | { outcome: 'unchanged' };

/** The writer's changes as they stood at a mark, restored by `undo`. */
export interface WriterMark {
  pages: Map<Page, DocRecord[]>; dirty: Set<number>; touched: Set<string>; plans: Set<string>; fresh: number; bodies: number; nextChunk: number;
}

const pageKey = (owner: string, page: number): string => `${owner}\u0000${page}`;

export class DocumentWriter {
  /** Each transcript's parser continuation, written to the last page chunk. */
  states = new Map<string, Record<string, unknown>>();
  /** The session's harness key owners, written to the last page chunk. */
  owners = new Map<string, { thread: string; record: string }>();
  /** The canonical plan keys the document holds an appearance of, written to the last page chunk. */
  plans = new Set<string>();
  /** Owners whose pages changed. */
  readonly touched = new Set<string>();
  /** Blob store reads this writer made. */
  reads = 0;
  private readonly rows = new Map<string, number[]>();
  private readonly loaded = new Map<number, DecodedChunk>();
  private readonly located = new Map<string, { page: Page; chunk: number | null }>();
  private readonly dirty = new Set<number>();
  private readonly fresh: Page[] = [];
  private readonly bodies: BodyChunkWrite[] = [];
  private lastPageChunk: number | null;
  private marked: WriterMark | null = null;
  /** Every change to what `layout()` writes, which `versions` is held against. */
  private revision = 0;
  private counted: { revision: number; versions: number } | null = null;
  private readonly sizes = new WeakMap<DocRecord, number>();

  constructor(
    readonly directory: Directory,
    public nextChunk: number,
    private readonly load: (row: ChunkRow) => Promise<DecodedChunk>,
  ) {
    for (const row of directory.pages) {
      const pages = this.rows.get(row.owner) ?? [];
      pages[row.page] = row.chunk_no;
      this.rows.set(row.owner, pages);
    }
    const pageChunks = [...directory.chunks.values()].filter((row) => row.kind === 'page').map((row) => row.chunk_no);
    this.lastPageChunk = pageChunks.length === 0 ? null : Math.max(...pageChunks);
  }

  /** Reads the last page chunk and its continuation. */
  async open(): Promise<void> {
    if (this.lastPageChunk === null) return;
    const last = await this.chunk(this.lastPageChunk);
    this.states = new Map(last.states);
    this.owners = new Map(last.owners ?? []);
    this.plans = new Set(last.plans ?? []);
  }

  private async chunk(chunkNo: number): Promise<DecodedChunk> {
    const held = this.loaded.get(chunkNo);
    if (held !== undefined) return held;
    const row = this.directory.chunks.get(chunkNo);
    if (row === undefined) throw new Error('document_chunk_missing');
    const decoded = await this.load(row);
    this.reads += 1;
    this.loaded.set(chunkNo, decoded);
    for (const page of decoded.pages) this.located.set(pageKey(page.owner, page.page), { page, chunk: chunkNo });
    return decoded;
  }

  /** An owner's pages in order, reading every chunk that holds one. */
  async pagesOf(owner: string): Promise<Page[]> {
    const chunks = new Set((this.rows.get(owner) ?? []).filter((chunk) => chunk !== undefined));
    for (const chunk of chunks) await this.chunk(chunk);
    return [...this.located.values()].filter((held) => held.page.owner === owner).map((held) => held.page)
      .sort((a, b) => a.page - b.page);
  }

  /** Starts recording changes so that `undo` can restore the writer as it stands now. */
  mark(): WriterMark {
    this.marked = {
      pages: new Map(), dirty: new Set(this.dirty), touched: new Set(this.touched), plans: new Set(this.plans),
      fresh: this.fresh.length, bodies: this.bodies.length, nextChunk: this.nextChunk,
    };
    return this.marked;
  }

  /** Restores the writer to `mark`; chunks read after it stay loaded. */
  undo(mark: WriterMark): void {
    this.revision += 1;
    for (const [page, records] of mark.pages) page.records = records;
    for (const page of this.fresh.splice(mark.fresh)) this.located.delete(pageKey(page.owner, page.page));
    this.bodies.splice(mark.bodies);
    this.nextChunk = mark.nextChunk;
    for (const [into, from] of [[this.dirty, mark.dirty], [this.touched, mark.touched], [this.plans, mark.plans]] as const) {
      (into as Set<unknown>).clear();
      for (const value of from) (into as Set<unknown>).add(value);
    }
    this.marked = null;
  }

  /** Keeps a page's records as the mark found them, before their first change. */
  private keep(page: Page): void {
    if (this.marked !== null && !this.marked.pages.has(page)) this.marked.pages.set(page, page.records.slice());
  }

  private markDirty(page: Page): void {
    this.revision += 1;
    const held = this.located.get(pageKey(page.owner, page.page));
    if (held?.chunk != null) this.dirty.add(held.chunk);
    this.touched.add(page.owner);
  }

  private addPage(owner: string, page: number, records: DocRecord[]): Page {
    this.revision += 1;
    const created: Page = { owner, page, records };
    this.fresh.push(created);
    this.located.set(pageKey(owner, page), { page: created, chunk: null });
    this.touched.add(owner);
    return created;
  }

  private fit(record: DocRecord): DocRecord {
    return fitRecord(record, ({ text }) => {
      this.revision += 1;
      const ref: BodyRef = { chunk: this.nextChunk++, bytes: new TextEncoder().encode(text).length, digest: '' };
      this.bodies.push({ chunkNo: ref.chunk, text, ref });
      return ref;
    });
  }

  /** Refills an owner's pages from `from` on by encoded size, in record order. */
  private reflow(pages: Page[], from: number): void {
    const records = pages.slice(from).flatMap((page) => page.records);
    let at = from;
    let page = pages[at]!;
    this.keep(page);
    page.records = [];
    for (const record of records) {
      if (page.records.length > 0 && pageBytes(page) + recordBytes(record) > DOCUMENT_PAGE_BYTES) {
        at += 1;
        page = pages[at] ?? this.addPage(page.owner, page.page + 1, []);
        this.keep(page);
        page.records = [];
      }
      page.records.push(record);
      this.markDirty(page);
    }
    for (const rest of pages.slice(at + 1)) {
      this.keep(rest);
      rest.records = [];
      this.markDirty(rest);
    }
  }

  /** Places a record on `owner`'s pages, or merges it into the version a page already holds under its id. */
  async upsert(record: DocRecord, owner: string): Promise<Upsert> {
    const searched = record.k === 'tool' && owner !== SESSION_OWNER ? [owner, SESSION_OWNER] : [owner];
    for (const candidate of searched) {
      const pages = await this.pagesOf(candidate);
      for (const [index, page] of pages.entries()) {
        const at = page.records.findIndex((held) => held.k === record.k && held.id === record.id);
        if (at < 0) continue;
        const held = page.records[at]!;
        const merged = mergeRecord(held, record);
        if (JSON.stringify(merged) === JSON.stringify(held)) return { outcome: 'unchanged' };
        this.keep(page);
        page.records[at] = this.fit(merged);
        this.markDirty(page);
        if (pageBytes(page) > DOCUMENT_PAGE_BYTES) this.reflow(pages, index);
        return { outcome: 'merged', record: page.records[at] ?? merged, held };
      }
    }
    const fitted = this.fit(record);
    const pages = await this.pagesOf(owner);
    const last = pages.at(-1);
    if (last !== undefined && pageBytes(last) + recordBytes(fitted) <= DOCUMENT_PAGE_BYTES) {
      this.keep(last);
      last.records.push(fitted);
      this.markDirty(last);
    } else this.addPage(owner, last === undefined ? 0 : last.page + 1, [fitted]);
    return { outcome: 'inserted', record: fitted };
  }

  /** Whether anything changed that must be written. */
  get changed(): boolean {
    return this.dirty.size > 0 || this.fresh.length > 0 || this.bodies.length > 0;
  }

  /** At least the number of chunk versions `layout()` would write now. */
  get pendingVersions(): number {
    const fresh = this.fresh.reduce((sum, page) => sum + pageBytes(page), 0);
    return 2 * this.dirty.size + 2 + Math.ceil(fresh / DOCUMENT_CHUNK_BYTES) + this.bodies.length;
  }

  /** The number of chunk versions `layout()` writes now: the versions a commit registers. */
  get versions(): number {
    if (this.counted?.revision === this.revision) return this.counted.versions;
    const nextChunk = this.nextChunk;
    try {
      const layout = this.layout();
      this.counted = { revision: this.revision, versions: layout.pageChunks.length + layout.bodyChunks.length };
      return this.counted.versions;
    } finally {
      this.nextChunk = nextChunk;
    }
  }

  /** A page's encoded size, each record measured once. */
  private sizeOf(page: Page): number {
    let bytes = pageHeaderBytes(page.owner, page.page);
    for (const record of page.records) {
      let held = this.sizes.get(record);
      if (held === undefined) this.sizes.set(record, held = recordBytes(record));
      bytes += held;
    }
    return bytes;
  }

  private bytesOf(pages: readonly Page[]): number {
    return pages.reduce((sum, page) => sum + this.sizeOf(page), 0);
  }

  /**
   * The chunk versions to write. Changed chunks keep their numbers; pages that no longer fit one move on, and with new
   * pages they fill the last page chunk and then new chunks. The last one carries the continuation.
   */
  layout(): DocumentLayout {
    const pageChunks: PageChunkWrite[] = [];
    const queue: Page[] = [];
    const empty = new Map<string, Record<string, unknown>>();
    const rewrite = new Set(this.dirty);
    if (this.lastPageChunk !== null) rewrite.add(this.lastPageChunk);
    for (const chunkNo of [...rewrite].sort((a, b) => a - b)) {
      const decoded = this.loaded.get(chunkNo)!;
      const pages = [...decoded.pages];
      while (pages.length > 1 && this.bytesOf(pages) > DOCUMENT_CHUNK_BYTES) queue.unshift(pages.pop()!);
      pageChunks.push({ chunkNo, chunk: { pages, states: empty, owners: null }, previous: this.directory.chunks.get(chunkNo) });
    }
    queue.push(...this.fresh.filter((page) => page.records.length > 0).sort((a, b) =>
      a.owner === b.owner ? a.page - b.page : 0));
    let target = pageChunks.find((write) => write.chunkNo === this.lastPageChunk);
    for (const page of queue) {
      if (target === undefined || this.bytesOf(target.chunk.pages) + this.sizeOf(page) > DOCUMENT_CHUNK_BYTES) {
        target = { chunkNo: this.nextChunk++, chunk: { pages: [], states: empty, owners: null }, previous: undefined };
        pageChunks.push(target);
      }
      target.chunk.pages.push(page);
    }
    if (target === undefined) {
      target = { chunkNo: this.nextChunk++, chunk: { pages: [], states: empty, owners: null }, previous: undefined };
      pageChunks.push(target);
    }
    target.chunk = { ...target.chunk, states: this.states, owners: [...this.owners], plans: [...this.plans] };
    const pages = pageChunks.flatMap((write) => write.chunk.pages.map((page) => ({
      owner: page.owner, page: page.page, chunkNo: write.chunkNo, records: page.records.length, bytes: pageBytes(page),
    })));
    return { pageChunks, bodyChunks: this.bodies, pages };
  }
}

