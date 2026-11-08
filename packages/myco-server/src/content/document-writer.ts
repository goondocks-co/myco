import { jsonPages } from '../db/json-pages.js';
import { PublicationOwnershipBuilding, type KeyOwner, type MetadataShard } from '../db/documents/ownership.js';
/**
 * Changes to one generation of a session document, held in memory until they are written as new chunk versions.
 *
 * Records are placed by owner: a new record goes on its owner's last page while it fits, else on a new page. A record
 * arriving under an id its owner already holds is merged in place, and when the page it sits on no longer fits, that
 * record moves to the owner's last page. Every chunk holding a changed page is rewritten whole; pages that no longer
 * fit their chunk, and new pages, fill the session's last page chunk and then new chunks. Continuations and immutable
 * ownership claims have separate metadata chunks, addressed by their keyed catalog.
 *
 * What a placement reads is bounded by the owner's open pages. A commit seals the older pages of an owner whose open
 * pages span more than `OWNER_OPEN_CHUNKS` chunks: their record ids go to `session_sealed_records`, so a record is
 * looked for on the owner's open pages and on the one sealed page, if any, that catalog names for it. An owner's last
 * page is never sealed.
 */
import {
  DOCUMENT_CHUNK_BYTES, DOCUMENT_PAGE_BYTES, fitRecord, pageBytes, pageHeaderBytes, recordBytes, SESSION_OWNER,
  type BodyRef, type DecodedChunk, type DocRecord, type Page,
} from './document.js';
import { mergeRecord } from './document-records.js';
import type { ChunkRow } from './document-reader.js';
import type { PublicationDirectory } from '../db/documents/directory.js';
import { TURN_PAGES } from './session-pages.js';

export interface PageChunkWrite { metadata?: number; chunkNo: number; chunk: DecodedChunk; previous: ChunkRow | undefined }
export interface BodyChunkWrite { chunkNo: number; text: string; ref: BodyRef }
export interface PageWrite { owner: string; page: number; chunkNo: number; records: number; bytes: number }
export interface DocumentLayout { pageChunks: PageChunkWrite[]; bodyChunks: BodyChunkWrite[]; pages: PageWrite[] }

export type Upsert = { outcome: 'inserted'; owner: string; record: DocRecord } | { outcome: 'merged'; owner: string; record: DocRecord; held: DocRecord } | { outcome: 'unchanged' };

/** The writer's changes as they stood at a mark, restored by `undo`. */
export interface WriterMark {
  pages: Map<Page, DocRecord[]>; dirty: Set<number>; touched: Set<string>; plans: Set<string>; fresh: number; bodies: number; nextChunk: number; moved: number;
}

/** Chunks an owner's open pages may span before a commit seals the oldest of them. */
export const OWNER_OPEN_CHUNKS = 6;
/** Chunks at the end of an owner whose pages stay open when it seals. */
export const OWNER_TAIL_CHUNKS = 2;
/** Leading pages read to settle a turn whose pages are not all held; its last page is read with them. */
export const TURN_HEAD_PAGES = TURN_PAGES - 1;

const pageKey = (owner: string, page: number): string => `${owner}\u0000${page}`;
const sealedKey = (owner: string, kind: string, id: string): string => `${owner}\u0000${kind}\u0000${id}`;

/** A row of `session_sealed_records`, named by the writer that sealed or moved its record. */
export interface SealedRecord { o: string; k: string; i: string }

class WriterMap<K,V> extends Map<K,V> {
  constructor(private readonly changed:()=>void) { super(); }
  override set(key:K,value:V):this { this.changed();return super.set(key,value); }
  override delete(key:K):boolean { const deleted=super.delete(key);if(deleted)this.changed();return deleted; }
  override clear():void { if(this.size)this.changed();super.clear(); }
}
class WriterSet<T> extends Set<T> {
  constructor(private readonly changed:()=>void) { super(); }
  override add(value:T):this { if(!this.has(value))this.changed();return super.add(value); }
  override delete(value:T):boolean { const deleted=super.delete(value);if(deleted)this.changed();return deleted; }
  override clear():void { if(this.size)this.changed();super.clear(); }
}

export class DocumentWriter {
  private revision = 0;
  private counted: {revision:number;versions:number}|null = null;
  private mutate = () => { this.revision += 1; };
  metadataReady = false;
  private metadataSeparated = false;
  private legacyMetadata: { number: number; chunk: DecodedChunk } | null = null;
  private readonly originalStates = new Map<string, string>();
  private readonly originalOwners = new Map<string, KeyOwner>();
  private readonly originalPlans = new Set<string>();
  private readonly stateChunks = new Map<string, number>();
  private readonly readStates = new Set<string>();
  /** Parser continuations loaded for the transcripts this pass visits. */
  readonly states = new WriterMap<string, Record<string, unknown>>(this.mutate);
  /** Key owners loaded or claimed by this pass. */
  readonly owners = new WriterMap<string, KeyOwner>(this.mutate);
  /** Canonical plan keys loaded or placed by this pass. */
  readonly plans = new WriterSet<string>(this.mutate);
  /** Owners whose pages changed. */
  readonly touched = new Set<string>();
  /** Blob store reads this writer made. */
  reads = 0;
  /** Records that left a sealed page, whose catalog rows the commit removes. */
  readonly moved: SealedRecord[] = [];
  private readonly rows = new Map<string, number[]>();
  private readonly sealedPages = new Map<string, Set<number>>();
  private readonly sealedRecords = new Map<string, number>();
  private readonly loaded = new Map<number, DecodedChunk>();
  private readonly located = new Map<string, { page: Page; chunk: number | null }>();
  private readonly dirty = new Set<number>();
  private readonly fresh: Page[] = [];
  private readonly bodies: BodyChunkWrite[] = [];
  private lastPageChunk: number | null = null;
  private readonly initialized = new Set<string>();
  private readonly sealedOwners = new Set<string>();
  private marked: WriterMark | null = null;
  private readonly sizes = new WeakMap<DocRecord, number>();

  constructor(
    readonly directory: PublicationDirectory,
    public nextChunk: number,
    private readonly load: (row: ChunkRow) => Promise<DecodedChunk>,
  ) {}

  async prepareOwners(owners: readonly string[]): Promise<void> {
    if (owners.length > 0 && this.lastPageChunk !== null) await this.chunk(this.lastPageChunk);
    const missing = [...new Set(owners)].filter(owner => !this.initialized.has(owner));
    if (missing.length === 0) return;
    const held = await this.directory.owners(missing);
    for (const owner of missing) this.rows.set(owner, []);
    for (const row of held.pages) this.rows.get(row.owner)![row.page] = row.chunk_no;
    for (const owner of held.sealed) this.sealedOwners.add(owner);
    for (const owner of missing) this.initialized.add(owner);
  }

  private async owner(owner: string): Promise<void> { await this.prepareOwners([owner]); }

  private async page(owner: string, number: number): Promise<number | undefined> {
    await this.owner(owner);
    const rows = this.rows.get(owner)!;
    if (rows[number] !== undefined) return rows[number];
    if (number >= rows.length) return undefined;
    const row = await this.directory.page(owner, number);
    if (row === undefined) return undefined;
    rows[number] = row.chunk_no;
    if (row.sealed === 1) this.sealedPages.set(owner, (this.sealedPages.get(owner) ?? new Set()).add(number));
    return row.chunk_no;
  }

  /** Opens the active page tail and admits existing metadata before any new ownership claim. */
  async open(): Promise<void> {
    const metadata = await this.directory.ownership.ready();
    this.metadataReady = metadata.ready;
    this.metadataSeparated = metadata.separated;
    if (!metadata.ready && this.nextChunk > 0) throw new PublicationOwnershipBuilding(metadata.failure);
    this.lastPageChunk = await this.directory.tail();
    if (this.lastPageChunk === null || metadata.separated) return;
    const last = await this.chunk(this.lastPageChunk);
    if (last.states.size > 0 || last.owners !== null || last.plans !== undefined) {
      this.legacyMetadata = { number: this.lastPageChunk, chunk: last };
    }
  }

  async readState(transcript: string): Promise<void> {
    if (this.readStates.has(transcript)) return;
    const number = this.metadataReady ? await this.directory.ownership.state(transcript)
      : this.legacyMetadata?.chunk.states.has(transcript) ? this.legacyMetadata.number : null;
    if (number !== null) {
      const chunk = await this.chunk(number);
      const held = chunk.states.get(transcript);
      if (held !== undefined) {
        this.states.set(transcript, held);
        this.originalStates.set(transcript, JSON.stringify(held));
        if (this.directory.chunks.get(number)?.metadata === 1 && chunk.states.size === 1
          && (chunk.owners?.length ?? 0) === 0 && (chunk.plans?.length ?? 0) === 0) this.stateChunks.set(transcript, number);
      }
    }
    this.readStates.add(transcript);
  }

  async readOwners(keys: readonly string[]): Promise<void> {
    const held = this.metadataReady ? await this.directory.ownership.owners(keys.filter(key => !this.owners.has(key)))
      : new Map((this.legacyMetadata?.chunk.owners ?? []).filter(([key]) => keys.includes(key)));
    for (const [key, owner] of held) {
      this.owners.set(key, owner); this.originalOwners.set(key, owner);
    }
  }

  async readPlanKeys(keys: readonly string[]): Promise<void> {
    const held = this.metadataReady ? await this.directory.ownership.plans(keys.filter(key => !this.plans.has(key)))
      : (this.legacyMetadata?.chunk.plans ?? []).filter(key => keys.includes(key));
    for (const key of held) {
      this.plans.add(key); this.originalPlans.add(key);
    }
  }

  get metadataSource() { return this.legacyMetadata === null ? [] : [{n:this.legacyMetadata.number,k:this.directory.chunks.get(this.legacyMetadata.number)!.blob_key}]; }

  metadataStatements(layout: DocumentLayout | null) {
    const shards: MetadataShard[] = (layout?.pageChunks ?? []).filter(write => write.metadata === 1).map(write => ({
      chunkNo: write.chunkNo, states: [...write.chunk.states.keys()], owners: write.chunk.owners ?? [], plans: write.chunk.plans ?? [],
    }));
    return [...this.directory.ownership.statements(shards, !this.metadataSeparated),
      ...(layout !== null && this.legacyMetadata !== null ? [this.directory.ownership.retain(this.legacyMetadata.number)] : [])];
  }

  get metadataStatementCount(): number {
    const states=[...new Set([...this.originalStates.keys(),...this.states.keys()])]
      .filter(key=>this.originalStates.get(key)!==JSON.stringify(this.states.get(key)??{})).length;
    const owners=jsonPages([...this.owners].filter(([key])=>!this.originalOwners.has(key))).length;
    const plans=jsonPages([...this.plans].filter(key=>!this.originalPlans.has(key))).length;
    return states+owners*2+plans+Number(!this.metadataSeparated)+Number(this.legacyMetadata!==null);
  }

  private async chunk(chunkNo: number): Promise<DecodedChunk> {
    const held = this.loaded.get(chunkNo);
    if (held !== undefined) return held;
    const row = await this.directory.chunk(chunkNo);
    if (row === undefined) throw new Error('document_chunk_missing');
    const decoded = await this.load(row);
    this.reads += 1;
    this.loaded.set(chunkNo, decoded);
    for (const page of decoded.pages) this.located.set(pageKey(page.owner, page.page), { page, chunk: chunkNo });
    return decoded;
  }

  /** The chunks holding an owner's open pages, oldest page first. */
  private openChunks(owner: string): number[] {
    const sealed = this.sealedPages.get(owner);
    const chunks = new Set<number>();
    (this.rows.get(owner) ?? []).forEach((chunk, page) => { if (!sealed?.has(page)) chunks.add(chunk); });
    return [...chunks];
  }

  /** The pages of an owner read so far, in order. */
  heldPages(owner: string): Page[] {
    return [...this.located.values()].filter((held) => held.page.owner === owner).map((held) => held.page)
      .sort((a, b) => a.page - b.page);
  }

  /** An owner's open pages, and any other of its pages read so far, in order. */
  async pagesOf(owner: string): Promise<Page[]> {
    await this.owner(owner);
    for (const chunk of this.openChunks(owner)) await this.chunk(chunk);
    return this.heldPages(owner);
  }

  /** Whether any page of this owner is sealed, so a search for one of its records asks the catalog. */
  async hasSealed(owner: string): Promise<boolean> {
    await this.owner(owner);
    return this.sealedOwners.has(owner);
  }

  /** Records the sealed page the catalog names for a record of this owner. */
  noteSealed(owner: string, kind: string, id: string, page: number): void {
    this.sealedRecords.set(sealedKey(owner, kind, id), page);
  }

  /** Whether the catalog named a sealed page for this record of this owner. */
  sealedHolds(owner: string, kind: string, id: string): boolean {
    return this.sealedRecords.has(sealedKey(owner, kind, id));
  }

  /** Reads what settling a turn needs beyond its open pages: its leading pages. */
  async readTurnHead(owner: string): Promise<void> {
    for (let page = 0; page < TURN_HEAD_PAGES; page += 1) {
      const chunk = await this.page(owner, page);
      if (chunk === undefined) break;
      await this.chunk(chunk);
    }
  }

  /** The pages a turn settles from: every page once all are held, else its leading pages and its last, and which of the two. */
  async turnPages(owner: string): Promise<{ pages: Page[]; complete: boolean }> {
    await this.readTurnHead(owner);
    const pages = await this.pagesOf(owner);
    const rows = this.rows.get(owner) ?? [];
    if (Array.from({ length: rows.length }, (_, page) => rows[page]).every((chunk) => chunk !== undefined && this.loaded.has(chunk))) return { pages, complete: true };
    const last = pages.at(-1);
    return { pages: pages.filter((page) => page.page < TURN_HEAD_PAGES || page === last), complete: false };
  }

  /**
   * The pages a commit seals, each with its chunk: the read pages of every owner whose open pages span more than
   * `OWNER_OPEN_CHUNKS` chunks, oldest first, outside the owner's last `OWNER_TAIL_CHUNKS` chunks.
   */
  sealing(): { page: Page; chunk: number }[] {
    const sealing: { page: Page; chunk: number }[] = [];
    for (const [owner, rows] of this.rows) {
      if (this.openChunks(owner).length <= OWNER_OPEN_CHUNKS) continue;
      const sealed = this.sealedPages.get(owner);
      const tail = new Set<number>();
      for (let page = rows.length - 1; page >= 0 && tail.size < OWNER_TAIL_CHUNKS; page -= 1) if (rows[page] !== undefined) tail.add(rows[page]!);
      rows.forEach((chunk, page) => {
        const held = this.located.get(pageKey(owner, page));
        if (!sealed?.has(page) && !tail.has(chunk) && held?.chunk != null) sealing.push({ page: held.page, chunk: held.chunk });
      });
    }
    return sealing;
  }

  /** Starts recording changes so that `undo` can restore the writer as it stands now. */
  mark(): WriterMark {
    this.marked = {
      pages: new Map(), dirty: new Set(this.dirty), touched: new Set(this.touched), plans: new Set(this.plans),
      fresh: this.fresh.length, bodies: this.bodies.length, nextChunk: this.nextChunk, moved: this.moved.length,
    };
    return this.marked;
  }

  /** Restores the writer to `mark`; chunks read after it stay loaded. */
  undo(mark: WriterMark): void {
    this.mutate();
    for (const [page, records] of mark.pages) page.records = records;
    for (const page of this.fresh.splice(mark.fresh)) this.located.delete(pageKey(page.owner, page.page));
    this.bodies.splice(mark.bodies);
    this.moved.splice(mark.moved);
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
    this.mutate();
    const held = this.located.get(pageKey(page.owner, page.page));
    if (held?.chunk != null) this.dirty.add(held.chunk);
    this.touched.add(page.owner);
  }

  private addPage(owner: string, page: number, records: DocRecord[]): Page {
    this.mutate();
    const created: Page = { owner, page, records };
    this.fresh.push(created);
    this.located.set(pageKey(owner, page), { page: created, chunk: null });
    this.touched.add(owner);
    return created;
  }

  private fit(record: DocRecord): DocRecord {
    return fitRecord(record, ({ text }) => {
      this.mutate();
      const ref: BodyRef = { chunk: this.nextChunk++, bytes: new TextEncoder().encode(text).length, digest: '' };
      this.bodies.push({ chunkNo: ref.chunk, text, ref });
      return ref;
    });
  }

  /** Puts a record on the owner's last page while it fits, else on a new page. */
  private append(owner: string, pages: readonly Page[], record: DocRecord): void {
    const last = pages.at(-1);
    if (last !== undefined && pageBytes(last) + recordBytes(record) <= DOCUMENT_PAGE_BYTES) {
      this.keep(last);
      last.records.push(record);
      this.markDirty(last);
    } else this.addPage(owner, last === undefined ? 0 : last.page + 1, [record]);
  }

  /** Places a record on `owner`'s pages, or merges it into the version a page already holds under its id. */
  async upsert(record: DocRecord, owner: string): Promise<Upsert> {
    const searched = record.k === 'tool' && owner !== SESSION_OWNER ? [owner, SESSION_OWNER] : [owner];
    for (const candidate of searched) {
      const named = this.sealedRecords.get(sealedKey(candidate, record.k, record.id));
      const namedChunk = named === undefined ? undefined : await this.page(candidate, named);
      if (namedChunk !== undefined) await this.chunk(namedChunk);
      const pages = await this.pagesOf(candidate);
      for (const page of pages) {
        const at = page.records.findIndex((held) => held.k === record.k && held.id === record.id);
        if (at < 0) continue;
        const held = page.records[at]!;
        const merged = mergeRecord(held, record);
        if (JSON.stringify(merged) === JSON.stringify(held)) return { outcome: 'unchanged' };
        this.keep(page);
        const fitted = this.fit(merged);
        page.records[at] = fitted;
        this.markDirty(page);
        if (pageBytes(page) > DOCUMENT_PAGE_BYTES) {
          page.records.splice(at, 1);
          if (this.sealedPages.get(candidate)?.has(page.page)) this.moved.push({ o: candidate, k: record.k, i: record.id });
          this.append(candidate, pages, fitted);
        }
        return { outcome: 'merged', owner: candidate, record: fitted, held };
      }
    }
    const fitted = this.fit(record);
    this.append(owner, await this.pagesOf(owner), fitted);
    return { outcome: 'inserted', owner, record: fitted };
  }

  /** Whether anything changed that must be written. */
  get changed(): boolean {
    return this.legacyMetadata !== null || this.dirty.size > 0 || this.fresh.length > 0 || this.bodies.length > 0
      || [...new Set([...this.originalStates.keys(),...this.states.keys()])].some(key=>this.originalStates.get(key)!==JSON.stringify(this.states.get(key)??{}))
      || [...this.owners.keys()].some(key=>!this.originalOwners.has(key))
      || [...this.plans].some(key=>!this.originalPlans.has(key));
  }

  /** At least the number of chunk versions `layout()` would write now. */
  get pendingVersions(): number {
    const fresh = this.fresh.reduce((sum, page) => sum + pageBytes(page), 0);
    return 2 * this.dirty.size + 2 + Math.ceil(fresh / DOCUMENT_CHUNK_BYTES) + this.bodies.length;
  }

  /** The number of chunk versions `layout()` writes now: the versions a commit registers. */
  get versions(): number {
    if(this.counted?.revision===this.revision)return this.counted.versions;
    const nextChunk = this.nextChunk;
    try {
      const layout = this.layout();
      this.counted={revision:this.revision,versions:layout.pageChunks.length+layout.bodyChunks.length};
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
   * pages they fill the last page chunk and then new chunks. Metadata writes name only changed keys.
   */
  layout(): DocumentLayout {
    const pageChunks: PageChunkWrite[] = [];
    const queue: Page[] = [];
    const empty = new Map<string, Record<string, unknown>>();
    const rewrite = new Set(this.dirty);
    if (this.lastPageChunk !== null && (this.dirty.size > 0 || this.fresh.length > 0 || this.legacyMetadata !== null)) rewrite.add(this.lastPageChunk);
    if (this.legacyMetadata !== null) {
      rewrite.delete(this.legacyMetadata.number);
      queue.push(...this.legacyMetadata.chunk.pages);
    }
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
    for (const transcript of new Set([...this.originalStates.keys(), ...this.states.keys()])) {
      const state = this.states.get(transcript) ?? {};
      if (this.originalStates.get(transcript) === JSON.stringify(state)) continue;
      const number = this.stateChunks.get(transcript) ?? this.nextChunk++;
      pageChunks.push({chunkNo:number, metadata:1, chunk:{pages:[],states:new Map([[transcript,state]]),owners:null},previous:this.directory.chunks.get(number)});
    }
    for (const owners of jsonPages([...this.owners].filter(([key]) => !this.originalOwners.has(key))))
      pageChunks.push({chunkNo:this.nextChunk++,metadata:1,chunk:{pages:[],states:empty,owners},previous:undefined});
    for (const plans of jsonPages([...this.plans].filter(key => !this.originalPlans.has(key))))
      pageChunks.push({chunkNo:this.nextChunk++,metadata:1,chunk:{pages:[],states:empty,owners:null,plans},previous:undefined});
    const pages = pageChunks.flatMap((write) => write.chunk.pages.map((page) => ({
      owner: page.owner, page: page.page, chunkNo: write.chunkNo, records: page.records.length, bytes: pageBytes(page),
    })));
    return { pageChunks, bodyChunks: this.bodies, pages };
  }
}

