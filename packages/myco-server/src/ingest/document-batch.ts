/**
 * One write to a session document: records placed by owner in memory, the turns they changed settled from their
 * pages, every new chunk version registered, and the catalog statements that describe them. The publisher and the
 * conversion each add their own guard and frontier statements and commit the whole as one batch.
 */
import type { PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import { contentAssertion, prepareDerivedStream, type ContentPublicationGuard, type DerivedContentSource } from '../core/registered-content.js';
import { CONTENT_WAKE_JOB_RESERVE, remainingInvocationBudget } from '../core/content-budget.js';
import { registeredBlobsGuard, releaseBlobs } from '../core/object-release.js';
import { trimTurn, type TurnInput } from '../core/turn-card-rules.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';
import { DOCUMENT_PREVIEW_CHARS } from '../db/document-tables.js';
import { BODY_ENCODING, encodePageChunk, PAGE_ENCODING, SESSION_OWNER, type DocRecord } from '../content/document.js';
import { chunkRowsSql, directoryOf, pageRowsSql, readPageChunk, type ChunkRow, type PageRow } from '../content/document-reader.js';
import { DocumentWriter, type DocumentLayout, type WriterMark } from '../content/document-writer.js';
import { PARSER_VERSION } from '../constants.js';
import { isPromptIdScheme, type PromptIdScheme } from '@goondocks/myco-shared/prompt-identity';

/** Distinct paths a session's tools touched that the catalog keeps. */
export const SESSION_PATHS_LIMIT = 500;
/** Statements and blob calls a pass keeps for its registration and commit, above the wake's reserve for later jobs. */
export const PASS_CLOSING_STATEMENTS = 64;
export const PASS_CLOSING_BLOB_CALLS = 12;

/** Statements one chunk version's registration may spend, and its blob calls: a store or durability check, then its verifying read. */
export const VERSION_STATEMENTS = 12;
export const VERSION_BLOB_CALLS = 2;

/** Whether the invocation can no longer pay for `statements` more without spending the wake's reserve. */
export function reserveReached(db: RelationalStore, statements: number, blobCalls: number): boolean {
  const remaining = remainingInvocationBudget(db);
  return remaining !== null && (remaining.statements < CONTENT_WAKE_JOB_RESERVE + statements || remaining.blobCalls < blobCalls);
}

/**
 * Whether the invocation can still commit `versions` chunk versions after spending `statements` and `blobCalls` more.
 * A commit's only blob calls are its versions' registrations.
 */
export function commitAdmitted(db: RelationalStore, versions: number, statements = 0, blobCalls = 0): boolean {
  return !reserveReached(db, PASS_CLOSING_STATEMENTS + versions * VERSION_STATEMENTS + statements, versions * VERSION_BLOB_CALLS + blobCalls);
}

/** A placement the batch refused: its commit could no longer be paid, and the batch holds what it held before it. */
export class DocumentPassFull extends Error {
  constructor() { super('document_pass_full'); }
}

/** A row of `retired_objects`: a chunk version's holder until a live directory row adopts it. */
export interface Holder { p: string; s: string; k: string; i: string }

/**
 * Deletes the holders that still stand, each with the proofs registered under its own source unless a live chunk names
 * that source, then decides their objects.
 */
export async function releaseHolders(db: RelationalStore, rows: readonly Holder[], now: number): Promise<void> {
  const page = JSON.stringify(rows);
  await db.batch([
    db.prepare(`DELETE FROM registered_content_proofs WHERE source_kind='document' AND (project_id,key,source_id) IN
      (SELECT r.project_id,r.blob_key,r.source_id FROM json_each(?) j JOIN retired_objects r ON r.project_id=json_extract(j.value,'$.p')
        AND r.session_id=json_extract(j.value,'$.s') AND r.blob_key=json_extract(j.value,'$.k') AND r.source_id=json_extract(j.value,'$.i')
       WHERE NOT EXISTS (SELECT 1 FROM session_chunks c WHERE c.project_id=r.project_id AND c.blob_key=r.blob_key AND c.source_id=r.source_id))`)
      .bind(page),
    db.prepare(`DELETE FROM retired_objects WHERE (project_id,session_id,blob_key,source_id) IN
      (SELECT json_extract(value,'$.p'),json_extract(value,'$.s'),json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?))`).bind(page),
  ]);
  await releaseBlobs(db, rows.map((row) => ({ projectId: row.p, key: row.k })), now);
}

/** The catalog row a batch starts from. */
export interface BatchDocument {
  generation: number;
  next_chunk: number;
  prompts: number;
  first_prompt: string | null;
  open_turn_key: string | null;
  token_id: string;
}

/** The statements a caller runs before and after the shared catalog statements of a commit. */
export interface Commit { before: PreparedStatement[]; after: PreparedStatement[] }

/** One chunk version a batch writes, with its source and the directory row it supersedes. */
export interface ChunkVersion { chunkNo: number; key: string; bytes: number; kind: 'page' | 'body'; encoding: string; sourceId: string; previous?: ChunkRow }

export const preview = (text: unknown): string | null =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, DOCUMENT_PREVIEW_CHARS) : null;

/** The canonical plan a plan appearance belongs to. */
const planKeyOf = (record: DocRecord): string => (typeof record.plan_key === 'string' ? record.plan_key : record.id);
/** Parent links `resolve` follows from a prompt to its turn. */
const ANCESTRY_DEPTH = 8;

/** The turn a document's records describe, as the card rules read it; a plan appears as its latest appearance. */
function turnInput(turnKey: string, records: readonly DocRecord[]): TurnInput | null {
  const prompt = records.find((record) => record.k === 'prompt' && record.id === turnKey);
  if (prompt === undefined) return null;
  const s = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    turnKey, origin: s(prompt.origin) || 'user', prompt: s(prompt.text),
    steering: records.filter((r) => r.k === 'prompt' && r.id !== turnKey).map((r) => ({ promptId: r.id, text: s(r.text) })),
    replies: records.filter((r) => r.k === 'reply').map((r) => ({ responseId: r.id, text: s(r.text) })),
    tools: records.filter((r) => r.k === 'tool').map((r) => ({
      toolCallId: r.id, toolName: s(r.tool_name), input: typeof r.input === 'string' ? r.input : null,
      output: typeof r.output_preview === 'string' ? r.output_preview : null, success: r.success === 1,
      errorMessage: typeof r.error_message === 'string' ? r.error_message : null,
    })),
    plans: [...new Map(records.filter((r) => r.k === 'plan').map((r) => [planKeyOf(r), r])).values()].map((r) => ({
      planKey: planKeyOf(r), title: typeof r.title === 'string' ? r.title : null, status: s(r.status), content: typeof r.content === 'string' ? r.content : null,
    })),
  };
}

/** The generation a batch writes: the live one, or generation 1 while the session waits for conversion. */
const BATCH_GENERATION = '(SELECT COALESCE(generation, 1) FROM session_documents WHERE project_id=?1 AND session_id=?2)';

/** The directory of the generation a batch writes, read in one round trip with whatever else the caller reads. */
export function directoryStatements(db: RelationalStore, projectId: string, sessionId: string): PreparedStatement[] {
  return [db.prepare(chunkRowsSql(BATCH_GENERATION)).bind(projectId, sessionId), db.prepare(pageRowsSql(BATCH_GENERATION)).bind(projectId, sessionId)];
}

export class DocumentBatch {
  readonly writer: DocumentWriter;
  readonly counts = { prompts: 0, user_prompts: 0, replies: 0, tool_calls: 0, failed_tools: 0, plans: 0 };
  records = 0;
  calls = 0;
  lastRecordAt: number | null = null;
  openTurn: string | null;
  firstPrompt: string | null;
  /** Records placed on the session's own pages, and those among them that name a prompt no turn holds. */
  unplaced = 0;
  unresolved = 0;
  /** The kind and id of every record this batch added. */
  readonly inserted: (readonly [string, string])[] = [];
  private readonly passId = crypto.randomUUID();
  private readonly db: RelationalStore;
  /** Each prompt's turn key, null for a prompt no turn holds; absent when unknown. */
  private readonly turns = new Map<string, string | null>();
  private readonly resolved = new Set<string>();
  private readonly newPrompts: { record: DocRecord; turnKey: string | null }[] = [];
  private readonly paths = new Map<string, { n: number; at: number }>();
  private readonly mycoCalls = new Map<string, DocRecord & { harness: string | null }>();
  /**
   * When set, every placement keeps the batch's commit payable: a chunk read or a placement whose commit the
   * invocation could no longer pay is undone and refused with `DocumentPassFull`.
   */
  admitted = false;
  /** The pending versions at the placement in progress, which every read keeps payable. */
  private floor = 0;

  constructor(
    private readonly env: Pick<ServerEnv, 'db' | 'blobs'>,
    private readonly projectId: string,
    private readonly sessionId: string,
    readonly doc: BatchDocument,
    chunks: readonly ChunkRow[],
    pages: readonly PageRow[],
  ) {
    this.db = env.db;
    this.openTurn = doc.open_turn_key;
    this.firstPrompt = doc.first_prompt;
    this.writer = new DocumentWriter(directoryOf(doc.generation, chunks, pages), doc.next_chunk, async (row) => {
      if (this.admitted && !commitAdmitted(this.db, Math.max(this.floor, this.writer.versions), 0, 1)) throw new DocumentPassFull();
      return readPageChunk(env, row);
    });
  }

  /** Reads the last page chunk and its continuation. */
  async open(): Promise<void> {
    const reads = this.writer.reads;
    await this.writer.open();
    this.calls += this.writer.reads - reads;
  }

  /**
   * Prompts not yet placed, each with its parent or null for a turn's own prompt, among the given ids; an id it does not
   * return is not in the session.
   */
  ancestry: ((ids: readonly string[]) => Promise<ReadonlyMap<string, string | null>>) | null = null;

  /** Reads the turn keys `session_prompts` holds for these prompts. */
  private async held(ids: readonly string[]): Promise<void> {
    const held = (await this.db.prepare(`SELECT prompt_id,turn_key FROM session_prompts WHERE project_id=? AND session_id=? AND generation=?
      AND prompt_id IN (SELECT value FROM json_each(?))`).bind(this.projectId, this.sessionId, this.doc.generation, JSON.stringify(ids))
      .all<{ prompt_id: string; turn_key: string | null }>()).results;
    this.calls += 1;
    for (const row of held) this.turns.set(row.prompt_id, row.turn_key);
    for (const id of ids) this.resolved.add(id);
  }

  /**
   * Reads the turn of every prompt these records name that this batch has not resolved yet. A prompt not placed yet
   * takes its turn through `ancestry`: the turn of its nearest placed ancestor, or the ancestor with no parent.
   */
  async resolve(records: readonly DocRecord[]): Promise<void> {
    const wanted = [...new Set(records.flatMap((record) => {
      const id = record.k === 'prompt' ? record.parent_prompt_id : record.prompt_id;
      return typeof id === 'string' && !this.resolved.has(id) && !this.turns.has(id) ? [id] : [];
    }))];
    if (wanted.length === 0) return;
    await this.held(wanted);
    const parents = new Map<string, string | null>();
    let pending = wanted.filter((id) => !this.turns.has(id));
    for (let depth = 0; this.ancestry !== null && pending.length > 0 && depth < ANCESTRY_DEPTH; depth += 1) {
      const found = await this.ancestry(pending);
      this.calls += 1;
      const next = new Set<string>();
      for (const id of pending) {
        if (!found.has(id)) continue;
        const parent = found.get(id)!;
        parents.set(id, parent);
        if (parent !== null && !this.turns.has(parent) && !parents.has(parent)) next.add(parent);
      }
      if (next.size === 0) break;
      await this.held([...next]);
      pending = [...next].filter((id) => !this.turns.has(id));
    }
    const turnOf = (id: string, depth: number): string | null => {
      if (this.turns.has(id)) return this.turns.get(id)!;
      if (!parents.has(id) || depth > ANCESTRY_DEPTH) return null;
      const parent = parents.get(id)!;
      return parent === null ? id : turnOf(parent, depth + 1);
    };
    for (const id of parents.keys()) this.turns.set(id, turnOf(id, 0));
  }

  /** The owner of a record: its prompt's turn, or the session for a record no turn holds. */
  private ownerOf(record: DocRecord): string {
    if (record.k === 'prompt') {
      const parent = typeof record.parent_prompt_id === 'string' ? record.parent_prompt_id : null;
      const turn = this.turns.has(record.id) ? this.turns.get(record.id)! : parent === null ? record.id : (this.turns.get(parent) ?? null);
      this.turns.set(record.id, turn);
      return turn ?? SESSION_OWNER;
    }
    return (record.prompt_id === null ? null : this.turns.get(record.prompt_id)) ?? SESSION_OWNER;
  }

  /** Assigns each incoming prompt its turn, a parent among these records before its children. */
  private assignPrompts(records: readonly DocRecord[]): void {
    let pending = records.filter((record) => record.k === 'prompt' && !this.turns.has(record.id));
    const incoming = new Set(pending.map((record) => record.id));
    while (pending.length > 0) {
      const ready = pending.filter((record) => {
        const parent = record.parent_prompt_id;
        return typeof parent !== 'string' || !incoming.has(parent) || this.turns.has(parent);
      });
      for (const record of ready.length > 0 ? ready : pending) this.ownerOf(record);
      pending = pending.filter((record) => !this.turns.has(record.id));
    }
  }

  /**
   * Places records in order, counting what each adds to the session's catalog. Returns each record as placed, null when
   * unchanged. While `admitted`, a placement whose commit could no longer be paid leaves the batch unchanged and throws
   * `DocumentPassFull`.
   */
  async place(records: readonly DocRecord[], harness: string | null): Promise<(DocRecord | null)[]> {
    if (!this.admitted) return this.placeAll(records, harness);
    const mark = this.mark();
    try {
      const placed = await this.placeAll(records, harness);
      if (!commitAdmitted(this.db, this.writer.versions)) throw new DocumentPassFull();
      return placed;
    } catch (error) {
      if (error instanceof DocumentPassFull) this.undo(mark);
      throw error;
    } finally {
      this.floor = 0;
    }
  }

  private mark(): { writer: WriterMark; counts: DocumentBatch['counts']; records: number; lastRecordAt: number | null; openTurn: string | null;
    firstPrompt: string | null; unplaced: number; unresolved: number; inserted: number; newPrompts: number; turns: Map<string, string | null>;
    resolved: Set<string>; paths: Map<string, { n: number; at: number }>; mycoCalls: Map<string, DocRecord & { harness: string | null }> } {
    this.floor = this.writer.versions;
    return {
      writer: this.writer.mark(), counts: { ...this.counts }, records: this.records, lastRecordAt: this.lastRecordAt, openTurn: this.openTurn,
      firstPrompt: this.firstPrompt, unplaced: this.unplaced, unresolved: this.unresolved, inserted: this.inserted.length,
      newPrompts: this.newPrompts.length, turns: new Map(this.turns), resolved: new Set(this.resolved), paths: new Map(this.paths),
      mycoCalls: new Map(this.mycoCalls),
    };
  }

  private undo(mark: ReturnType<DocumentBatch['mark']>): void {
    this.writer.undo(mark.writer);
    Object.assign(this.counts, mark.counts);
    Object.assign(this, { records: mark.records, lastRecordAt: mark.lastRecordAt, openTurn: mark.openTurn, firstPrompt: mark.firstPrompt,
      unplaced: mark.unplaced, unresolved: mark.unresolved });
    this.inserted.splice(mark.inserted);
    this.newPrompts.splice(mark.newPrompts);
    for (const [into, from] of [[this.turns, mark.turns], [this.paths, mark.paths], [this.mycoCalls, mark.mycoCalls]] as const) {
      (into as Map<string, unknown>).clear();
      for (const [key, value] of from) (into as Map<string, unknown>).set(key, value);
    }
    this.resolved.clear();
    for (const id of mark.resolved) this.resolved.add(id);
  }

  private async placeAll(records: readonly DocRecord[], harness: string | null): Promise<(DocRecord | null)[]> {
    await this.resolve(records);
    this.assignPrompts(records);
    const reads = this.writer.reads;
    const out: (DocRecord | null)[] = [];
    for (const record of records) {
      const owner = this.ownerOf(record);
      const placed = await this.writer.upsert(record, owner);
      out.push(placed.outcome === 'unchanged' ? null : placed.record);
      if (placed.outcome === 'unchanged') continue;
      this.records += 1;
      this.lastRecordAt = Math.max(this.lastRecordAt ?? 0, record.created_at);
      if (record.k === 'tool' && typeof placed.record.myco_tool === 'string') this.mycoCalls.set(record.id, { ...placed.record, harness });
      if (placed.outcome === 'merged') {
        if (record.k === 'tool') this.counts.failed_tools += (placed.record.success === 0 ? 1 : 0) - (placed.held.success === 0 ? 1 : 0);
        continue;
      }
      this.inserted.push([record.k, record.k === 'plan' ? planKeyOf(record) : record.id]);
      if (owner === SESSION_OWNER) {
        this.unplaced += 1;
        if (record.k === 'prompt' ? record.parent_prompt_id != null : record.prompt_id !== null) this.unresolved += 1;
      }
      if (record.k === 'prompt') {
        this.counts.prompts += 1;
        if (record.origin === 'user') this.counts.user_prompts += 1;
        const turnKey = owner === SESSION_OWNER ? null : owner;
        this.newPrompts.push({ record, turnKey });
        if (turnKey === record.id) {
          this.openTurn = record.id;
          if (this.firstPrompt === null && record.origin === 'user') this.firstPrompt = preview(record.text);
        }
      } else if (record.k === 'reply') this.counts.replies += 1;
      else if (record.k === 'plan') {
        if (!this.writer.plans.has(planKeyOf(record))) this.counts.plans += 1;
        this.writer.plans.add(planKeyOf(record));
      }
      else {
        this.counts.tool_calls += 1;
        if (record.success === 0) this.counts.failed_tools += 1;
        for (const path of Array.isArray(record.files_affected) ? record.files_affected : []) {
          if (typeof path !== 'string') continue;
          const held = this.paths.get(path);
          this.paths.set(path, { n: (held?.n ?? 0) + 1, at: Math.max(held?.at ?? 0, record.created_at) });
        }
      }
    }
    this.calls += this.writer.reads - reads;
    return out;
  }

  /** The summary and card input hash of every turn this batch changed, read from its pages. */
  async settledTurns(): Promise<Record<string, unknown>[]> {
    const settled: Record<string, unknown>[] = [];
    for (const owner of this.writer.touched) {
      if (owner === SESSION_OWNER) continue;
      const records = (await this.writer.pagesOf(owner)).flatMap((page) => page.records);
      const input = turnInput(owner, records);
      if (input === null) continue;
      const trimmed = trimTurn(input);
      const prompt = records.find((record) => record.k === 'prompt' && record.id === owner)!;
      settled.push({
        id: owner, preview: preview(prompt.text), text_chars: typeof prompt.text === 'string' ? prompt.text.length : 0,
        tools: input.tools.length, replies: input.replies.length, children: input.steering.length, plans: input.plans.length,
        input_hash: await sha256Hex(trimmed.text), input_chars: trimmed.text.length,
      });
    }
    return settled;
  }

  private source(sourceId: string): DerivedContentSource {
    return {
      projectId: this.projectId, sessionId: this.sessionId, eventId: sourceId, tokenId: this.doc.token_id, envelopeHash: sourceId,
      sourceKind: 'document', resourceId: sourceId,
    };
  }

  /** Every chunk version's stored bytes, bodies first so each page records its bodies' digests. */
  private async encode(layout: DocumentLayout): Promise<{ version: ChunkVersion; bytes: Uint8Array<ArrayBuffer> }[]> {
    const encoded: { version: ChunkVersion; bytes: Uint8Array<ArrayBuffer> }[] = [];
    const add = async (chunkNo: number, bytes: Uint8Array<ArrayBuffer>, kind: 'page' | 'body', encoding: string, previous?: ChunkRow) => {
      const key = await sha256HexOf(bytes);
      const sourceId = `doc:${this.sessionId}:${this.doc.generation}:${chunkNo}:${this.passId}`;
      encoded.push({ version: { chunkNo, key, bytes: bytes.byteLength, kind, encoding, sourceId, ...(previous ? { previous } : {}) }, bytes });
      return key;
    };
    for (const body of layout.bodyChunks) body.ref.digest = await add(body.chunkNo, utf8(body.text), 'body', BODY_ENCODING);
    for (const write of layout.pageChunks) await add(write.chunkNo, await encodePageChunk(write.chunk) as Uint8Array<ArrayBuffer>, 'page', PAGE_ENCODING, write.previous);
    return encoded;
  }

  /** The chunk keys a commit expects to replace, for its guard: the previous key, or null for a new chunk. */
  expectedChunks(registered: readonly ChunkVersion[]): string {
    return JSON.stringify(registered.map((row) => ({ n: row.chunkNo, k: row.previous?.blob_key ?? null })));
  }

  /** The directory, prompt, turn, path and Myco-call statements of a commit. */
  statements(layout: DocumentLayout | null, registered: readonly ChunkVersion[], settled: readonly Record<string, unknown>[], chunkState: 'building' | 'live', now: number): PreparedStatement[] {
    const db = this.db;
    const p = this.projectId, s = this.sessionId, g = this.doc.generation;
    const rows = JSON.stringify(registered.map((row) => ({ n: row.chunkNo, k: row.key, b: row.bytes, d: row.kind, e: row.encoding, i: row.sourceId })));
    const statements: PreparedStatement[] = [
      ...contentAssertion(db, `(SELECT COUNT(*) FROM json_each(?) j JOIN retired_objects r ON r.project_id=? AND r.session_id=?
        AND r.blob_key=json_extract(j.value,'$.k') AND r.source_id=json_extract(j.value,'$.i'))=?`, [rows, p, s, registered.length]),
    ];
    if (registered.length > 0) {
      statements.push(
        registeredBlobsGuard(db, registered.map((row) => ({ projectId: p, key: row.key }))),
        db.prepare(`DELETE FROM retired_objects WHERE (project_id,session_id,blob_key,source_id) IN
          (SELECT ?,?,json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?))`).bind(p, s, rows),
        db.prepare(`INSERT OR IGNORE INTO retired_objects (project_id,session_id,blob_key,source_id,retired_at)
          SELECT c.project_id,c.session_id,c.blob_key,c.source_id,? FROM json_each(?) j JOIN session_chunks c
            ON c.project_id=? AND c.session_id=? AND c.generation=? AND c.chunk_no=json_extract(j.value,'$.n')`)
          .bind(now, rows, p, s, g),
        db.prepare(`INSERT INTO session_chunks (project_id,session_id,generation,chunk_no,blob_key,kind,encoding,bytes,source_id,state)
          SELECT ?,?,?,json_extract(value,'$.n'),json_extract(value,'$.k'),json_extract(value,'$.d'),json_extract(value,'$.e'),
            json_extract(value,'$.b'),json_extract(value,'$.i'),? FROM json_each(?) WHERE true
          ON CONFLICT (project_id,session_id,generation,chunk_no) DO UPDATE SET blob_key=excluded.blob_key,kind=excluded.kind,
            encoding=excluded.encoding,bytes=excluded.bytes,source_id=excluded.source_id,state=excluded.state`)
          .bind(p, s, g, chunkState, rows),
      );
    }
    if (layout !== null && layout.pages.length > 0) {
      statements.push(db.prepare(`INSERT INTO session_pages (project_id,session_id,generation,owner,page,chunk_no,records,bytes)
        SELECT ?,?,?,json_extract(value,'$.owner'),json_extract(value,'$.page'),json_extract(value,'$.chunkNo'),
          json_extract(value,'$.records'),json_extract(value,'$.bytes') FROM json_each(?) WHERE true
        ON CONFLICT (project_id,session_id,generation,owner,page) DO UPDATE SET chunk_no=excluded.chunk_no,records=excluded.records,bytes=excluded.bytes`)
        .bind(p, s, g, JSON.stringify(layout.pages)));
    }
    if (this.newPrompts.length > 0) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO session_prompts (project_id,session_id,generation,prompt_id,turn_key,parent_hint,ord,origin,
          prompt_kind,thread_label,created_at,claim,source_key,prompt_key_hash,preview,text_chars)
        SELECT ?,?,?,json_extract(value,'$.id'),json_extract(value,'$.turn'),json_extract(value,'$.parent'),?+key,json_extract(value,'$.origin'),
          json_extract(value,'$.kind'),json_extract(value,'$.label'),json_extract(value,'$.at'),json_extract(value,'$.claim'),
          json_extract(value,'$.source'),json_extract(value,'$.hash'),json_extract(value,'$.preview'),json_extract(value,'$.chars') FROM json_each(?)`)
        .bind(p, s, g, this.doc.prompts, JSON.stringify(this.newPrompts.map(({ record, turnKey }) => ({
          id: record.id, turn: turnKey, parent: record.parent_prompt_id ?? null, origin: record.origin ?? null, kind: record.prompt_kind ?? null,
          label: record.thread_label ?? null, at: record.created_at, claim: record.claim ?? null, source: record.source_key ?? null,
          hash: record.prompt_key_hash ?? null, preview: preview(record.text), chars: typeof record.text === 'string' ? record.text.length : 0,
        })))));
    }
    const placed = layout === null ? [] : layout.pageChunks.flatMap((write) => write.chunk.pages.flatMap((page) =>
      page.records.filter((record) => record.k === 'prompt').map((record) => ({ id: record.id, page: page.page }))));
    if (placed.length > 0) {
      statements.push(db.prepare(`UPDATE session_prompts SET page=(SELECT json_extract(j.value,'$.page') FROM json_each(?1) j
          WHERE json_extract(j.value,'$.id')=session_prompts.prompt_id)
        WHERE project_id=?2 AND session_id=?3 AND generation=?4 AND prompt_id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`)
        .bind(JSON.stringify(placed), p, s, g));
    }
    if (settled.length > 0) {
      statements.push(db.prepare(`UPDATE session_prompts SET preview=json_extract(j.value,'$.preview'),text_chars=json_extract(j.value,'$.text_chars'),
          tools=json_extract(j.value,'$.tools'),replies=json_extract(j.value,'$.replies'),children=json_extract(j.value,'$.children'),
          plans=json_extract(j.value,'$.plans'),input_hash=json_extract(j.value,'$.input_hash'),input_chars=json_extract(j.value,'$.input_chars')
        FROM json_each(?) j WHERE project_id=? AND session_id=? AND generation=? AND prompt_id=json_extract(j.value,'$.id')`)
        .bind(JSON.stringify(settled), p, s, g));
    }
    if (this.paths.size > 0) {
      statements.push(db.prepare(`INSERT INTO session_paths (project_id,session_id,generation,path,tool_calls,last_at)
        SELECT ?,?,?,json_extract(j.value,'$.path'),json_extract(j.value,'$.n'),json_extract(j.value,'$.at') FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM session_paths h WHERE h.project_id=? AND h.session_id=? AND h.generation=? AND h.path=json_extract(j.value,'$.path'))
            OR (SELECT COUNT(*) FROM session_paths h WHERE h.project_id=? AND h.session_id=? AND h.generation=?) < ${SESSION_PATHS_LIMIT}
        ON CONFLICT (project_id,session_id,generation,path) DO UPDATE SET tool_calls=tool_calls+excluded.tool_calls,last_at=MAX(last_at,excluded.last_at)`)
        .bind(p, s, g, JSON.stringify([...this.paths].map(([path, held]) => ({ path, n: held.n, at: held.at }))), p, s, g, p, s, g));
    }
    if (this.mycoCalls.size > 0) {
      statements.push(db.prepare(`INSERT INTO myco_tool_calls (project_id,session_id,generation,tool_call_id,myco_tool,myco_op,success,created_at,harness)
        SELECT ?,?,?,json_extract(value,'$.id'),json_extract(value,'$.tool'),json_extract(value,'$.op'),json_extract(value,'$.ok'),
          json_extract(value,'$.at'),json_extract(value,'$.harness') FROM json_each(?) WHERE true
        ON CONFLICT (project_id,session_id,generation,tool_call_id) DO UPDATE SET myco_op=excluded.myco_op,success=excluded.success`)
        .bind(p, s, g, JSON.stringify([...this.mycoCalls.values()].map((record) => ({
          id: record.id, tool: record.myco_tool, op: record.myco_op ?? null, ok: record.success, at: record.created_at, harness: record.harness,
        })))));
    }
    return statements;
  }

  /** The counter, chunk numbering and turn fields of the session's catalog row, as SET terms and their parameters. */
  documentSet(now: number): { sql: string; params: unknown[] } {
    const c = this.counts;
    return {
      sql: `prompts=prompts+?,user_prompts=user_prompts+?,replies=replies+?,tool_calls=tool_calls+?,failed_tools=failed_tools+?,plans=plans+?,
        first_prompt=?,open_turn_key=?,last_record_at=MAX(COALESCE(last_record_at,0),COALESCE(?,0)),next_chunk=?,updated_at=?`,
      params: [c.prompts, c.user_prompts, c.replies, c.tool_calls, c.failed_tools, c.plans, this.firstPrompt, this.openTurn, this.lastRecordAt,
        this.writer.nextChunk, now],
    };
  }

  /**
   * Holds, registers and adopts this batch's chunk versions. Each version is held by a `retired_objects` row from before
   * it is registered until the commit removes that row; its proof is registered only while `guard(version)` holds. The
   * commit runs the caller's statements around the shared catalog statements, and a failed pass releases its holders.
   */
  async commit(write: boolean, chunkState: 'building' | 'live', now: number, guard: (version: ChunkVersion) => ContentPublicationGuard,
    statements: (versions: readonly ChunkVersion[]) => Commit | Promise<Commit>): Promise<number> {
    const layout = write ? this.writer.layout() : null;
    const settled = write ? await this.settledTurns() : [];
    const encoded = layout === null ? [] : await this.encode(layout);
    const versions = encoded.map(({ version }) => version);
    const holders = versions.map((version): Holder => ({ p: this.projectId, s: this.sessionId, k: version.key, i: version.sourceId }));
    if (holders.length > 0) {
      await this.db.prepare(`INSERT INTO retired_objects (project_id,session_id,blob_key,source_id,retired_at)
        SELECT json_extract(value,'$.p'),json_extract(value,'$.s'),json_extract(value,'$.k'),json_extract(value,'$.i'),? FROM json_each(?)`)
        .bind(now, JSON.stringify(holders)).run();
      this.calls += 1;
    }
    try {
      for (const { version, bytes } of encoded) {
        await prepareDerivedStream(this.env, this.source(version.sourceId), {
          size: bytes.byteLength, digest: version.key, stream: () => new Blob([bytes]).stream(),
        }, now, guard(version));
        this.calls += 4;
      }
      const own = await statements(versions);
      await this.db.batch([...own.before, ...this.statements(layout, versions, settled, chunkState, now), ...own.after]);
    } catch (error) {
      if (holders.length > 0) await releaseHolders(this.db, holders, now);
      throw error;
    }
    return versions.length;
  }
}

/** The record identity scheme a newly published transcript is minted under. */
export const PUBLISHED_RECORD_SCHEME = 'source-record-v1';

/** The prompt scheme a transcript first published is minted under: the view mapping of its pinned scheme. */
export function publishedPromptScheme(pinned: unknown): PromptIdScheme | null {
  const mapped = pinned === 'offset-v1' ? 'offset-v2' : pinned === 'stamp-or-offset-v1' ? 'stamp-or-offset-v2' : pinned;
  return isPromptIdScheme(mapped) ? mapped : null;
}

/** Upserts publisher frontiers, one JSON object per transcript. */
export function publicationStatement(db: RelationalStore, projectId: string, sessionId: string, generation: number, now: number,
  rows: readonly Record<string, unknown>[]): PreparedStatement {
  return db.prepare(`INSERT INTO transcript_publication (project_id,transcript_id,generation,session_id,published_offset,segment_lines,
      open_prompt_id,unfinished,reply_unfinished,reply_latest_at,prompt_scheme,record_scheme,parser_version,state,failure,awaited_size,updated_at)
    SELECT ?,json_extract(value,'$.t'),?,?,json_extract(value,'$.o'),json_extract(value,'$.l'),json_extract(value,'$.p'),json_extract(value,'$.u'),
      json_extract(value,'$.r'),json_extract(value,'$.a'),json_extract(value,'$.ps'),json_extract(value,'$.rs'),?,json_extract(value,'$.s'),
      json_extract(value,'$.f'),json_extract(value,'$.w'),? FROM json_each(?) WHERE true
    ON CONFLICT (project_id,transcript_id,generation) DO UPDATE SET published_offset=excluded.published_offset,segment_lines=excluded.segment_lines,
      open_prompt_id=excluded.open_prompt_id,unfinished=excluded.unfinished,reply_unfinished=excluded.reply_unfinished,
      reply_latest_at=excluded.reply_latest_at,parser_version=excluded.parser_version,state=excluded.state,failure=excluded.failure,
      awaited_size=excluded.awaited_size,updated_at=excluded.updated_at`)
    .bind(projectId, generation, sessionId, PARSER_VERSION, now, JSON.stringify(rows));
}
