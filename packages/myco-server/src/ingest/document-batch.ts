import { publishedDocument } from '../db/documents/publication.js';
import { PublicationDirectory } from '../db/documents/directory.js';
import { jsonPages, STATEMENT_JSON_BYTES } from '../db/json-pages.js';
/**
 * One write to a session document: records placed by owner in memory, the turns they changed settled from their
 * pages, every new chunk version registered, and the catalog statements that describe them. The publisher and the
 * conversion each add their own guard and frontier statements and commit the whole as one batch.
 */
import type { PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import { contentAssertion, prepareDerivedStream, type ContentPublicationGuard, type DerivedContentSource } from '../core/registered-content.js';
import { CONTENT_WAKE_JOB_RESERVE, remainingInvocationBudget } from '../core/content-budget.js';
import { releaseBlobs } from '../core/object-release.js';
import { registeredBlobsGuard, recordHolderCandidates } from '../db/storage/release-queue.js';
import { trimTurn } from '../core/turn-card-rules.js';
import { TURN_QUIET_MS } from '../db/schema-v110.js';
import { publicationProgressStatements } from '../db/learning/progress.js';
import { turnInput } from '../content/turn-material.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';
import { DOCUMENT_PREVIEW_CHARS, SESSION_PATHS_LIMIT } from '../db/document-tables.js';
import { BODY_ENCODING, encodePageChunk, PAGE_ENCODING, type DocRecord, type Page } from '../content/document.js';
import { SESSION_OWNER } from '../db/document-tables.js';
import { readPageChunk, type ChunkRow } from '../content/document-reader.js';
import { DocumentWriter, type DocumentLayout, type SealedRecord, type WriterMark } from '../content/document-writer.js';
import { TRANSCRIPT_PARSE_ADAPTER } from '../constants.js';
import { ensureSessionLifecycle, presentedDatesAfterPublication, settlePublishedTurn } from '../db/documents/lifecycle.js';
import { adjustToolState, editedFiles, emptyToolState, recordMycoFields, parseToolState, scalarToolState, toolFiles, type ToolState } from '../content/tool-rollup.js';
import { sessionEditPaths } from '../db/documents/edit-paths.js';
import { prepareBound } from '../db/kernel/statement.js';
import { catalogAfterPublication, catalogAfterRestore, type CatalogDelta } from '../db/documents/catalog-row.js';
import type { Holder } from '../db/documents/retired-holders.js';
import { heldToolCalls, turnStatisticsStatements, type StatisticsChange } from '../content/tool-statistics.js';

export { SESSION_PATHS_LIMIT } from '../db/document-tables.js';
/** Statements and blob calls a pass keeps for its registration and commit, above the wake's reserve for later jobs. */
export const PASS_CLOSING_STATEMENTS = 64;
export const PASS_CLOSING_BLOB_CALLS = 12;

/** Sealed record rows one statement carries, and one commit: a bound JSON parameter stays well under a store's value limit. */
const SEALED_ROWS_PER_STATEMENT = 5_000;
const SEALED_ROWS_PER_COMMIT = 40_000;

/** Statements one chunk version's registration may spend, and its blob calls: a store or durability check, then its verifying read. */
export const VERSION_STATEMENTS = 12;
const VERSION_BLOB_CALLS = 2;

/** Whether the invocation can no longer pay for `statements` more without spending the wake's reserve. */
export function reserveReached(db: RelationalStore, statements: number, blobCalls: number): boolean {
  const remaining = remainingInvocationBudget(db);
  return remaining !== null && (remaining.statements < CONTENT_WAKE_JOB_RESERVE + statements || remaining.blobCalls < blobCalls);
}

/**
 * Whether the invocation can still commit `versions` chunk versions after spending `statements` and `blobCalls` more.
 * Closing metadata and the current chunk versions each reserve their registration calls.
 */
export function commitAdmitted(db: RelationalStore, versions: number, statements = 0, blobCalls = 0): boolean {
  return !reserveReached(db, PASS_CLOSING_STATEMENTS + versions * VERSION_STATEMENTS + statements, PASS_CLOSING_BLOB_CALLS + versions * VERSION_BLOB_CALLS + blobCalls);
}

/** A placement the batch refused: its commit could no longer be paid, and the batch holds what it held before it. */
export class DocumentPassFull extends Error {
  constructor() { super('document_pass_full'); }
}

/**
 * Deletes the holders that still stand, each with the proofs registered under its own source unless a live chunk names
 * that source, then decides their objects.
 */
export async function releaseHolders(db: RelationalStore, rows: readonly Holder[], now: number): Promise<void> {
  const page = JSON.stringify(rows);
  await db.batch([
    ...recordHolderCandidates(db, rows, now),
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
interface Commit { before: PreparedStatement[]; after: PreparedStatement[] }

/** One chunk version a batch writes, with its source and the directory row it supersedes. */
export interface ChunkVersion { metadata?: number; chunkNo: number; key: string; bytes: number; kind: 'page' | 'body'; encoding: string; sourceId: string; previous?: ChunkRow }

const preview = (text: unknown): string | null =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, DOCUMENT_PREVIEW_CHARS) : null;

/** The canonical plan a plan appearance belongs to. */
const planKeyOf = (record: DocRecord): string => (typeof record.plan_key === 'string' ? record.plan_key : record.id);
/** Parent links `resolve` follows from a prompt to its turn. */
const ANCESTRY_DEPTH = 8;

/** A plan a transcript holds, as placed, with the digest of its whole body and whether the body moved to a body chunk. */
interface TranscriptPlan { record: DocRecord; hash: string; spilled: boolean }
const PLAN_STATEMENTS_PER_PAGE = 2;
/** Fixed guard, frontier and session-control statements reserved for a commit. */
const DOCUMENT_COMMIT_FIXED_STATEMENTS = 6;

const transcriptPlanRows = (plans: ReadonlyMap<string, TranscriptPlan>) => [...plans].map(([key, { record, hash, spilled }]) => ({
  key, id: record.id, title: record.title ?? null, content: spilled ? null : record.content, blob: spilled ? hash : null, hash,
  status: record.status ?? 'active', path: record.origin_path ?? null, at: record.created_at, prompt: record.prompt_id ?? null, source: record.source ?? null,
}));

/**
 * What a live publication tells the session's canonical rows. A plan a transcript holds is inserted, or its title and
 * content follow a newer appearance while the row has no member edit and its last writer is a transcript (publication,
 * whose appearance id is the plan key, or the transcript parse); status and other editorial fields are never
 * overwritten. A body the document moved to a body chunk is stored as a spilled plan: no inline content, the chunk's
 * object as `blob_key` and its digest as `content_hash`, with the processed proof its readers require. A user prompt
 * newer than the session's end reopens it. A session an import alone accounts for is presented from its document: its
 * first turn's prompt and its latest record.
 */
function sessionRowStatements(db: RelationalStore, projectId: string, sessionId: string, generation: number, tokenId: string,
  plans: ReadonlyMap<string, TranscriptPlan>, latestUserPrompt: number | null, lastRecordAt: number | null, now: number): PreparedStatement[] {
  const statements: PreparedStatement[] = [];
  for (const page of jsonPages(transcriptPlanRows(plans))) {
    const rows = JSON.stringify(page);
    statements.push(db.prepare(`INSERT INTO plans (project_id,plan_key,session_id,event_id,machine_id,title,content,blob_key,content_hash,status,origin_path,
        created_at,updated_at,token_id,received_at,prompt_id,source)
      SELECT ?1,json_extract(j.value,'$.key'),?2,json_extract(j.value,'$.id'),
        COALESCE((SELECT machine_id FROM sessions WHERE project_id=?1 AND session_id=?2),''),json_extract(j.value,'$.title'),
        json_extract(j.value,'$.content'),json_extract(j.value,'$.blob'),json_extract(j.value,'$.hash'),json_extract(j.value,'$.status'),json_extract(j.value,'$.path'),
        json_extract(j.value,'$.at'),json_extract(j.value,'$.at'),?3,?4,json_extract(j.value,'$.prompt'),json_extract(j.value,'$.source') FROM json_each(?5) j WHERE true
      ON CONFLICT (project_id,plan_key) DO UPDATE SET title=excluded.title,content=excluded.content,blob_key=excluded.blob_key,content_hash=excluded.content_hash,
        event_id=excluded.event_id,updated_at=excluded.updated_at,received_at=excluded.received_at
      WHERE (plans.event_id=plans.plan_key OR EXISTS (SELECT 1 FROM events e WHERE e.project_id=plans.project_id
          AND e.event_id=plans.event_id AND e.producer_adapter='${TRANSCRIPT_PARSE_ADAPTER}'))
        AND plans.updated_by IS NULL AND plans.updated_at<excluded.updated_at AND plans.content_hash<>excluded.content_hash`)
      .bind(projectId, sessionId, tokenId, now, rows),
      db.prepare(`INSERT INTO processed_resources (project_id,kind,resource_id,blob_key,source_token_id,event_id)
        SELECT ?1,'plan',p.plan_key,p.blob_key,p.token_id,p.event_id FROM json_each(?2) j
          JOIN plans p ON p.project_id=?1 AND p.plan_key=json_extract(j.value,'$.key') AND p.blob_key=json_extract(j.value,'$.blob')
          JOIN blobs b ON b.project_id=p.project_id AND b.key=p.blob_key
        WHERE json_extract(j.value,'$.blob') IS NOT NULL ON CONFLICT DO NOTHING`).bind(projectId, rows));
  }
  statements.push(ensureSessionLifecycle(db, projectId, sessionId));
  if (latestUserPrompt !== null) statements.push(settlePublishedTurn(db, projectId, sessionId));
  statements.push(presentedDatesAfterPublication(db, projectId, sessionId, generation, lastRecordAt));
  return statements;
}

interface TurnAdded { tools: number; replies: number; children: number; plans: number }

export class DocumentBatch {
  readonly writer: DocumentWriter;
  readonly counts = { prompts: 0, user_prompts: 0, replies: 0, tool_calls: 0, failed_tools: 0, plans: 0, myco_calls: 0 };
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
  /** What this batch added to each turn, the summary of a turn whose pages are not all read. */
  private readonly added = new Map<string, TurnAdded>();
  /** The pages this batch's commit seals. */
  private sealed: { page: Page; chunk: number }[] = [];
  private readonly passId = crypto.randomUUID();
  private readonly db: RelationalStore;
  /** Each prompt's turn key, null for a prompt no turn holds; absent when unknown. */
  private readonly turns = new Map<string, string | null>();
  private readonly resolved = new Set<string>();
  private readonly newPrompts: { record: DocRecord; turnKey: string | null }[] = [];
  private readonly paths = new Map<string, { n: number; edits: number; at: number; turn: string | null }>();
  private readonly toolChanges: { owner: string; record: DocRecord; held: DocRecord | null; harness: string | null }[] = [];
  private rewrittenBefore: number | null = null;
  private fallbackHarness: string | null | undefined;
  private readonly mycoCalls = new Map<string, DocRecord & { harness: string | null }>();
  /**
   * When set, every placement keeps the batch's commit payable: a chunk read or a placement whose commit the
   * invocation could no longer pay is undone and refused with `DocumentPassFull`.
   */
  admitted = false;
  /** The pending versions at the placement in progress, which every read keeps payable. */
  private floor = 0;
  /** The latest appearance this batch placed of each plan a transcript holds, with its content hash. */
  private readonly transcriptPlans = new Map<string, TranscriptPlan>();
  /** The latest top-level user prompt this batch added. */
  private latestUserPrompt: number | null = null;

  constructor(
    private readonly env: Pick<ServerEnv, 'db' | 'blobs'>,
    private readonly projectId: string,
    private readonly sessionId: string,
    readonly doc: BatchDocument,
  ) {
    this.db = env.db;
    this.openTurn = doc.open_turn_key;
    this.firstPrompt = doc.first_prompt;
    this.writer = new DocumentWriter(new PublicationDirectory(this.db, projectId, sessionId, doc.generation, (statements) => {
      if (this.admitted && !commitAdmitted(this.db, Math.max(this.floor, this.writer.versions), this.commitStatements + statements)) throw new DocumentPassFull();
      this.calls += statements;
    }), doc.next_chunk, async (row) => {
      if (this.admitted && !commitAdmitted(this.db, Math.max(this.floor, this.writer.versions), this.commitStatements, 1)) throw new DocumentPassFull();
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
      if (!commitAdmitted(this.db, this.writer.versions, this.commitStatements)) throw new DocumentPassFull();
      return placed;
    } catch (error) {
      if (error instanceof DocumentPassFull) this.undo(mark);
      throw error;
    } finally {
      this.floor = 0;
    }
  }

  /** Upper bound for summary reads and byte-split writes, above the fixed closing reserve. */
  get commitStatements(): number {
    const bytes = this.toolChanges.reduce((sum, change) => sum + 500 + new TextEncoder().encode(JSON.stringify({
      name: change.record.tool_name, myco: change.record.myco_tool, op: change.record.myco_op, files: change.record.files_affected,
    })).length * 8, 0) + this.writer.touched.size * 1_000;
    return DOCUMENT_COMMIT_FIXED_STATEMENTS + this.writer.metadataStatementCount + Math.ceil(bytes / STATEMENT_JSON_BYTES) * 5 + jsonPages(transcriptPlanRows(this.transcriptPlans)).length * PLAN_STATEMENTS_PER_PAGE;
  }

  private mark(): { writer: WriterMark; counts: DocumentBatch['counts']; records: number; lastRecordAt: number | null; openTurn: string | null;
    firstPrompt: string | null; unplaced: number; unresolved: number; inserted: number; newPrompts: number; turns: Map<string, string | null>;
    added: Map<string, TurnAdded>;
    resolved: Set<string>; paths: Map<string, { n: number; edits: number; at: number; turn: string | null }>; toolChanges: number; mycoCalls: Map<string, DocRecord & { harness: string | null }>;
    transcriptPlans: Map<string, TranscriptPlan>; latestUserPrompt: number | null } {
    this.floor = this.writer.versions;
    return {
      writer: this.writer.mark(), counts: { ...this.counts }, records: this.records, lastRecordAt: this.lastRecordAt, openTurn: this.openTurn,
      firstPrompt: this.firstPrompt, unplaced: this.unplaced, unresolved: this.unresolved, inserted: this.inserted.length,
      newPrompts: this.newPrompts.length, turns: new Map(this.turns), added: new Map([...this.added].map(([owner, held]) => [owner, { ...held }])), resolved: new Set(this.resolved), paths: new Map(this.paths),
      toolChanges: this.toolChanges.length, mycoCalls: new Map(this.mycoCalls), transcriptPlans: new Map(this.transcriptPlans), latestUserPrompt: this.latestUserPrompt,
    };
  }

  private undo(mark: ReturnType<DocumentBatch['mark']>): void {
    this.writer.undo(mark.writer);
    Object.assign(this.counts, mark.counts);
    Object.assign(this, { records: mark.records, lastRecordAt: mark.lastRecordAt, openTurn: mark.openTurn, firstPrompt: mark.firstPrompt,
      unplaced: mark.unplaced, unresolved: mark.unresolved, latestUserPrompt: mark.latestUserPrompt });
    this.inserted.splice(mark.inserted);
    this.newPrompts.splice(mark.newPrompts);
    this.toolChanges.splice(mark.toolChanges);
    for (const [into, from] of [[this.turns, mark.turns], [this.added, mark.added], [this.paths, mark.paths], [this.mycoCalls, mark.mycoCalls],
      [this.transcriptPlans, mark.transcriptPlans]] as const) {
      (into as Map<string, unknown>).clear();
      for (const [key, value] of from) (into as Map<string, unknown>).set(key, value);
    }
    this.resolved.clear();
    for (const id of mark.resolved) this.resolved.add(id);
  }

  /** Reads the sealed pages the catalog names for these records, for the owners that have any. */
  private async locateSealed(records: readonly DocRecord[]): Promise<void> {
    await this.writer.prepareOwners([SESSION_OWNER, ...records.map(record => this.ownerOf(record))]);
    const wanted: SealedRecord[] = [];
    for (const record of records) {
      const owner = this.ownerOf(record);
      for (const candidate of record.k === 'tool' && owner !== SESSION_OWNER ? [owner, SESSION_OWNER] : [owner]) {
        if (!await this.writer.hasSealed(candidate)) continue;
        wanted.push({ o: candidate, k: record.k, i: record.id });
        if (record.k === 'plan') wanted.push({ o: candidate, k: record.k, i: planKeyOf(record) });
      }
    }
    if (wanted.length === 0) return;
    const held = (await this.db.prepare(`SELECT r.owner,r.k,r.record_id,r.page FROM json_each(?4) j CROSS JOIN session_sealed_records r
        ON r.project_id=?1 AND r.session_id=?2 AND r.generation=?3 AND r.owner=json_extract(j.value,'$.o') AND r.k=json_extract(j.value,'$.k')
          AND r.record_id=json_extract(j.value,'$.i')`).bind(this.projectId, this.sessionId, this.doc.generation, JSON.stringify(wanted))
      .all<{ owner: string; k: string; record_id: string; page: number }>()).results;
    this.calls += 1;
    for (const row of held) this.writer.noteSealed(row.owner, row.k, row.record_id, row.page);
  }

  /** Whether this owner already holds an appearance of this plan, on a page read or a sealed page the catalog names. */
  private async planHeld(owner: string, key: string): Promise<boolean> {
    return this.writer.sealedHolds(owner, 'plan', key)
      || (await this.writer.pagesOf(owner)).some((page) => page.records.some((record) => record.k === 'plan' && planKeyOf(record) === key));
  }

  private addToTurn(owner: string, field: keyof TurnAdded): void {
    const held = this.added.get(owner) ?? { tools: 0, replies: 0, children: 0, plans: 0 };
    held[field] += 1;
    this.added.set(owner, held);
  }

  private async placeAll(records: readonly DocRecord[], harness: string | null): Promise<(DocRecord | null)[]> {
    if (harness === null) {
      if (this.fallbackHarness === undefined) {
        const session = await this.db.prepare('SELECT agent FROM sessions WHERE project_id=? AND session_id=?')
          .bind(this.projectId, this.sessionId).first<{ agent: string | null }>();
        this.calls += 1;
        this.fallbackHarness = session?.agent ?? null;
      }
      harness = this.fallbackHarness;
    }
    await this.resolve(records);
    this.assignPrompts(records);
    await this.writer.readPlanKeys(records.filter(record => record.k === 'plan').map(planKeyOf));
    await this.locateSealed(records);
    const reads = this.writer.reads;
    const out: (DocRecord | null)[] = [];
    for (const incoming of records) {
      const record = incoming.k === 'tool' ? { ...incoming, harness: incoming.harness ?? harness } : incoming;
      if (record.k === 'tool') {
        record.files_affected = toolFiles(record, harness);
        const myco = recordMycoFields(record);
        record.myco_tool = myco.tool;
        record.myco_op = myco.op;
      }
      let owner = this.ownerOf(record);
      const newPlan = record.k === 'plan' && !(await this.planHeld(owner, planKeyOf(record)));
      const placed = await this.writer.upsert(record, owner);
      if (placed.outcome !== 'unchanged') owner = placed.owner;
      out.push(placed.outcome === 'unchanged' ? null : placed.record);
      if (placed.outcome === 'unchanged') continue;
      this.records += 1;
      this.lastRecordAt = Math.max(this.lastRecordAt ?? 0, record.created_at);
      if (record.k === 'tool' && typeof placed.record.myco_tool === 'string') this.mycoCalls.set(record.id, { ...placed.record, harness });
      if (record.k === 'plan' && typeof placed.record.ev !== 'string' && typeof placed.record.content === 'string'
        && record.created_at >= (this.transcriptPlans.get(planKeyOf(record))?.record.created_at ?? 0)) {
        const content = typeof record.content === 'string' ? record.content : placed.record.content;
        this.transcriptPlans.set(planKeyOf(record), {
          record: placed.record, hash: await sha256Hex(content), spilled: placed.record.bodies?.content !== undefined,
        });
      }
      this.toolChanges.push({ owner, record: placed.record, held: placed.outcome === 'merged' ? placed.held : null, harness });
      if (record.k === 'tool') {
        const prior = placed.outcome === 'merged' ? placed.held : null;
        const before = prior === null ? [] : toolFiles(prior);
        const after = toolFiles(placed.record);
        const beforeEdits = prior === null ? [] : editedFiles(prior, harness);
        const afterEdits = editedFiles(placed.record, harness);
        for (const path of new Set([...before, ...after])) {
          const held = this.paths.get(path);
          this.paths.set(path, {
            n: (held?.n ?? 0) + Number(after.includes(path)) - Number(before.includes(path)),
            edits: (held?.edits ?? 0) + Number(afterEdits.includes(path)) - Number(beforeEdits.includes(path)),
            at: Math.max(held?.at ?? 0, record.created_at), turn: held !== undefined && held.at > record.created_at ? held.turn : owner === SESSION_OWNER ? null : owner,
          });
        }
      }
      if (placed.outcome === 'merged') {
        if (record.k === 'tool') this.counts.failed_tools += (placed.record.success === 0 ? 1 : 0) - (placed.held.success === 0 ? 1 : 0);
        if (record.k === 'tool') this.counts.myco_calls += Number(recordMycoFields(placed.record).tool !== null) - Number(recordMycoFields(placed.held).tool !== null);
        continue;
      }
      this.inserted.push([record.k, record.k === 'plan' ? planKeyOf(record) : record.id]);
      if (owner !== SESSION_OWNER) {
        if (record.k === 'tool') this.addToTurn(owner, 'tools');
        else if (record.k === 'reply') this.addToTurn(owner, 'replies');
        else if (record.k === 'prompt' && record.id !== owner) this.addToTurn(owner, 'children');
        else if (newPlan) this.addToTurn(owner, 'plans');
      }
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
          if (record.origin === 'user') this.latestUserPrompt = Math.max(this.latestUserPrompt ?? 0, record.created_at);
          if (this.firstPrompt === null && record.origin === 'user') this.firstPrompt = preview(record.text);
        }
      } else if (record.k === 'reply') this.counts.replies += 1;
      else if (record.k === 'plan') {
        if (!this.writer.plans.has(planKeyOf(record))) this.counts.plans += 1;
        this.writer.plans.add(planKeyOf(record));
      }
      else {
        this.counts.tool_calls += 1;
        if (recordMycoFields(record).tool !== null) this.counts.myco_calls += 1;
        if (record.success === 0) this.counts.failed_tools += 1;
      }
    }
    for (const owner of this.writer.touched) if (owner !== SESSION_OWNER) await this.writer.readTurnHead(owner);
    this.calls += this.writer.reads - reads;
    return out;
  }

  /**
   * The summary and card input hash of every turn this batch changed. A turn with every page read is summarized from
   * its records. A wider turn's hash and preview come from its leading pages and its last, and its counts grow by what
   * this batch added.
   */
  async settledTurns(): Promise<Record<string, unknown>[]> {
    const settled: Record<string, unknown>[] = [];
    const owners = [...this.writer.touched].filter(owner => owner !== SESSION_OWNER);
    const priors = new Map<string, { tool_state: string | null; tool_revision: number }>();
    for (const page of jsonPages(owners)) {
      const rows = (await this.db.prepare(`SELECT p.prompt_id,p.tool_state,p.tool_revision FROM json_each(?4) j CROSS JOIN session_prompts p
        ON p.project_id=?1 AND p.session_id=?2 AND p.generation=?3 AND p.prompt_id=j.value`)
        .bind(this.projectId, this.sessionId, this.doc.generation, JSON.stringify(page))
        .all<{ prompt_id: string; tool_state: string | null; tool_revision: number }>()).results;
      for (const row of rows) priors.set(row.prompt_id, row);
      this.calls += 1;
    }
    const opaque = this.toolChanges.filter(change => change.record.k === 'tool' && change.record.bodies?.input !== undefined)
      .map(change => ({ owner: change.owner, id: change.record.id }));
    const calls = await heldToolCalls(this.db, [this.projectId, this.sessionId, this.doc.generation], opaque);
    for (const owner of owners) {
      const { pages, complete } = await this.writer.turnPages(owner);
      const records = pages.flatMap((page) => page.records);
      const prior = priors.get(owner);
      let state: ToolState | null = prior?.tool_state ? parseToolState(prior.tool_state) : null;
      const reset = state === null;
      if (state !== null) {
        for (const change of this.toolChanges.filter(change => change.owner === owner)) {
          const held = calls[change.record.id];
          if (held !== undefined) Object.defineProperty(state.calls, change.record.id, { value: held, enumerable: true, configurable: true, writable: true });
          if (change.held !== null) adjustToolState(state, change.held, change.harness, -1);
          adjustToolState(state, change.record, change.harness, 1);
        }
      } else if (complete && records.every(record => record.k !== 'tool' || record.bodies?.input === undefined || Object.hasOwn(record, 'harness'))) {
        state = emptyToolState();
        const harness = this.toolChanges.find(change => change.owner === owner)?.harness ?? null;
        for (const record of records) adjustToolState(state, record, harness, 1);
      }
      const statistics = { expected_revision: prior?.tool_revision ?? 0, ...(state === null ? {} : {
        failed_tools: state.failed, myco_calls: state.mycoCalls, tool_state: scalarToolState(state), statistics: { id: owner, state, reset },
      }) };
      const input = turnInput(owner, records);
      const added = this.added.get(owner) ?? { tools: 0, replies: 0, children: 0, plans: 0 };
      if (input === null) {
        if (!complete) settled.push({ id: owner, added, ...statistics });
        continue;
      }
      const trimmed = trimTurn(input);
      const prompt = records.find((record) => record.k === 'prompt' && record.id === owner)!;
      settled.push({
        ...statistics, id: owner, at: prompt.created_at, last: Math.max(...records.map((record) => record.created_at)),
        preview: preview(prompt.text), text_chars: typeof prompt.text === 'string' ? prompt.text.length : 0,
        ...(complete ? { tools: input.tools.length, replies: input.replies.length, children: input.steering.length, plans: input.plans.length } : { added }),
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
    const add = async (chunkNo: number, bytes: Uint8Array<ArrayBuffer>, kind: 'page' | 'body', encoding: string, previous?: ChunkRow, metadata = 0) => {
      const key = await sha256HexOf(bytes);
      const sourceId = `doc:${this.sessionId}:${this.doc.generation}:${chunkNo}:${this.passId}`;
      encoded.push({ version: { chunkNo, key, bytes: bytes.byteLength, kind, encoding, sourceId, metadata, ...(previous ? { previous } : {}) }, bytes });
      return key;
    };
    for (const body of layout.bodyChunks) body.ref.digest = await add(body.chunkNo, utf8(body.text), 'body', BODY_ENCODING);
    for (const write of layout.pageChunks) await add(write.chunkNo, await encodePageChunk(write.chunk) as Uint8Array<ArrayBuffer>, write.metadata === 1 ? 'body' : 'page', PAGE_ENCODING, write.previous, write.metadata);
    return encoded;
  }

  /** The chunk keys a commit expects to replace, for its guard: the previous key, or null for a new chunk. */
  expectedChunks(registered: readonly ChunkVersion[]): string {
    return JSON.stringify([
      ...this.writer.metadataSource,
      ...registered.map((row) => ({ n: row.chunkNo, k: row.previous?.blob_key ?? null })),
      ...[...new Set(this.sealed.map((held) => held.chunk))].map((n) => ({ n, k: this.writer.directory.chunks.get(n)?.blob_key ?? null })),
    ]);
  }

  /** The statements that record the record ids of the pages this commit seals, and drop those of records that left a sealed page. */
  private sealStatements(): PreparedStatement[] {
    const db = this.db;
    const p = this.projectId, s = this.sessionId, g = this.doc.generation;
    const statements: PreparedStatement[] = [];
    const rows = this.sealed.flatMap(({ page }) => page.records.flatMap((record) => [
      { o: page.owner, k: record.k, i: record.id, p: page.page },
      ...(record.k === 'plan' && planKeyOf(record) !== record.id ? [{ o: page.owner, k: record.k, i: planKeyOf(record), p: page.page }] : []),
    ]));
    for (let at = 0; at < rows.length; at += SEALED_ROWS_PER_STATEMENT) {
      statements.push(db.prepare(`INSERT INTO session_sealed_records (project_id,session_id,generation,owner,k,record_id,page)
        SELECT ?,?,?,json_extract(value,'$.o'),json_extract(value,'$.k'),json_extract(value,'$.i'),json_extract(value,'$.p') FROM json_each(?) WHERE true
        ON CONFLICT (project_id,session_id,generation,owner,k,record_id) DO UPDATE SET page=excluded.page`)
        .bind(p, s, g, JSON.stringify(rows.slice(at, at + SEALED_ROWS_PER_STATEMENT))));
    }
    if (this.sealed.length > 0) {
      statements.push(db.prepare(`UPDATE session_pages SET sealed=1 WHERE project_id=? AND session_id=? AND generation=?
        AND (owner,page) IN (SELECT json_extract(value,'$.o'),json_extract(value,'$.p') FROM json_each(?))`)
        .bind(p, s, g, JSON.stringify(this.sealed.map(({ page }) => ({ o: page.owner, p: page.page })))));
    }
    if (this.writer.moved.length > 0) {
      statements.push(db.prepare(`DELETE FROM session_sealed_records WHERE project_id=? AND session_id=? AND generation=?
        AND (owner,k,record_id) IN (SELECT json_extract(value,'$.o'),json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?))`)
        .bind(p, s, g, JSON.stringify(this.writer.moved)));
    }
    return statements;
  }

  /** The pages this commit seals, as many as its rows allow, oldest first. */
  private pagesToSeal(): { page: Page; chunk: number }[] {
    let rows = 0;
    const taken: { page: Page; chunk: number }[] = [];
    for (const held of this.writer.sealing()) {
      rows += held.page.records.length * 2;
      if (rows > SEALED_ROWS_PER_COMMIT) break;
      taken.push(held);
    }
    return taken;
  }

  /** The directory, prompt, turn, path and Myco-call statements of a commit. */
  statements(layout: DocumentLayout | null, registered: readonly ChunkVersion[], allSettled: readonly Record<string, unknown>[], chunkState: 'building' | 'live', now: number): PreparedStatement[] {
    const db = this.db;
    const p = this.projectId, s = this.sessionId, g = this.doc.generation;
    const settled = allSettled.map(({ statistics: _statistics, ...turn }) => turn);
    const statistics = allSettled.flatMap(turn => turn.statistics === undefined ? [] : [turn.statistics as StatisticsChange]);
    const rows = JSON.stringify(registered.map((row) => ({ n: row.chunkNo, k: row.key, b: row.bytes, d: row.kind, e: row.encoding, i: row.sourceId, m: row.metadata ?? 0 })));
    const statements: PreparedStatement[] = [
      ...contentAssertion(db, `(SELECT COUNT(*) FROM json_each(?) j JOIN retired_objects r ON r.project_id=? AND r.session_id=?
        AND r.blob_key=json_extract(j.value,'$.k') AND r.source_id=json_extract(j.value,'$.i'))=?`, [rows, p, s, registered.length]),
    ];
    for (const page of jsonPages(settled)) statements.push(...contentAssertion(db, `NOT EXISTS (
      SELECT 1 FROM json_each(?4) j CROSS JOIN session_prompts sp
        ON sp.project_id=?1 AND sp.session_id=?2 AND sp.generation=?3 AND sp.prompt_id=json_extract(j.value,'$.id')
        WHERE sp.tool_revision<>json_extract(j.value,'$.expected_revision'))`, [p, s, g, JSON.stringify(page)]));
    if (registered.length > 0) {
      statements.push(
        registeredBlobsGuard(db, registered.map((row) => ({ projectId: p, key: row.key }))),
        db.prepare(`DELETE FROM retired_objects WHERE (project_id,session_id,blob_key,source_id) IN
          (SELECT ?,?,json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?))`).bind(p, s, rows),
        db.prepare(`INSERT OR IGNORE INTO retired_objects (project_id,session_id,blob_key,source_id,retired_at)
          SELECT c.project_id,c.session_id,c.blob_key,c.source_id,? FROM json_each(?) j JOIN session_chunks c
            ON c.project_id=? AND c.session_id=? AND c.generation=? AND c.chunk_no=json_extract(j.value,'$.n')`)
          .bind(now, rows, p, s, g),
        db.prepare(`INSERT INTO session_chunks (project_id,session_id,generation,chunk_no,blob_key,kind,encoding,bytes,source_id,state,metadata)
          SELECT ?,?,?,json_extract(value,'$.n'),json_extract(value,'$.k'),json_extract(value,'$.d'),json_extract(value,'$.e'),
            json_extract(value,'$.b'),json_extract(value,'$.i'),?,json_extract(value,'$.m') FROM json_each(?) WHERE true
          ON CONFLICT (project_id,session_id,generation,chunk_no) DO UPDATE SET blob_key=excluded.blob_key,kind=excluded.kind,
            encoding=excluded.encoding,bytes=excluded.bytes,source_id=excluded.source_id,state=excluded.state,metadata=excluded.metadata`)
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
    const prompts = this.newPrompts.map(({ record, turnKey }, index) => ({
      id: record.id, turn: turnKey, parent: record.parent_prompt_id ?? null, ord: this.doc.prompts + index, origin: record.origin ?? null, kind: record.prompt_kind ?? null,
      label: record.thread_label ?? null, at: record.created_at, claim: record.claim ?? null, source: record.source_key ?? null,
      hash: record.prompt_key_hash ?? null, preview: preview(record.text), chars: typeof record.text === 'string' ? record.text.length : 0,
    }));
    for (const page of jsonPages(prompts)) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO session_prompts (project_id,session_id,generation,prompt_id,turn_key,parent_hint,ord,origin,
          prompt_kind,thread_label,created_at,claim,source_key,prompt_key_hash,preview,text_chars)
        SELECT ?,?,?,json_extract(value,'$.id'),json_extract(value,'$.turn'),json_extract(value,'$.parent'),json_extract(value,'$.ord'),json_extract(value,'$.origin'),
          json_extract(value,'$.kind'),json_extract(value,'$.label'),json_extract(value,'$.at'),json_extract(value,'$.claim'),
          json_extract(value,'$.source'),json_extract(value,'$.hash'),json_extract(value,'$.preview'),json_extract(value,'$.chars') FROM json_each(?)`)
        .bind(p, s, g, JSON.stringify(page)));
    }
    const placed = layout === null ? [] : layout.pageChunks.flatMap((write) => write.chunk.pages.flatMap((page) =>
      page.records.filter((record) => record.k === 'prompt').map((record) => ({ id: record.id, page: page.page }))));
    if (placed.length > 0) {
      statements.push(db.prepare(`WITH j(id,page) AS MATERIALIZED (SELECT json_extract(value,'$.id'),json_extract(value,'$.page') FROM json_each(?1))
        UPDATE session_prompts SET page=j.page FROM j WHERE project_id=?2 AND session_id=?3 AND generation=?4 AND prompt_id=j.id`)
        .bind(JSON.stringify(placed), p, s, g));
    }
    for (const page of jsonPages(settled)) statements.push(...this.cardStatements(page, chunkState === 'building', now));
    for (const page of jsonPages(settled)) {
      const count = (field: string) => `${field}=COALESCE(json_extract(j.value,'$.${field}'),${field}+COALESCE(json_extract(j.value,'$.added.${field}'),0))`;
      const kept = (field: string) => `${field}=COALESCE(json_extract(j.value,'$.${field}'),${field})`;
      statements.push(db.prepare(`WITH j(id,value) AS MATERIALIZED (SELECT json_extract(value,'$.id'),value FROM json_each(?1))
        UPDATE session_prompts SET ${kept('preview')},${kept('text_chars')},${count('tools')},${count('replies')},${count('children')},
          ${count('plans')},${kept('failed_tools')},${kept('myco_calls')},${kept('files_named')},${kept('tool_rollup')},${kept('tool_state')},tool_revision=tool_revision+1,${kept('input_hash')},${kept('input_chars')}
        FROM j WHERE project_id=?2 AND session_id=?3 AND generation=?4 AND prompt_id=j.id AND prompt_id IN (SELECT id FROM j)`)
        .bind(JSON.stringify(page), p, s, g));
    }
    statements.push(...turnStatisticsStatements(db, [p, s, g], statistics, statistics.map(change => change.id)));
    if (chunkState === 'live' && (this.writer.touched.size > 0 || this.transcriptPlans.size > 0)) statements.push(...sessionRowStatements(db, p, s, g, this.doc.token_id, this.transcriptPlans, this.latestUserPrompt, this.lastRecordAt, now));
    if (this.paths.size > 0) {
      statements.push(...sessionEditPaths(p, s, g, [...this.paths].filter(([, held]) => held.edits > 0).map(([path]) => path)).map(bound => prepareBound(db, bound)));
      for (const page of jsonPages([...this.paths].filter(([, held]) => held.n <= 0).map(([path, held]) => ({ path, ...held })))) {
        const rows = JSON.stringify(page);
        statements.push(db.prepare(`UPDATE session_paths SET tool_calls=tool_calls+json_extract(j.value,'$.n'),edits=edits+json_extract(j.value,'$.edits'),
          last_turn=CASE WHEN json_extract(j.value,'$.at')>=last_at THEN json_extract(j.value,'$.turn') ELSE last_turn END,
          last_at=MAX(last_at,json_extract(j.value,'$.at')) FROM json_each(?4) j
          WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND session_paths.path=json_extract(j.value,'$.path')
            AND session_paths.path IN (SELECT json_extract(value,'$.path') FROM json_each(?4))`).bind(p, s, g, rows),
          db.prepare(`DELETE FROM session_paths WHERE project_id=?1 AND session_id=?2 AND generation=?3
            AND path IN (SELECT json_extract(value,'$.path') FROM json_each(?4)) AND tool_calls<=0`).bind(p, s, g, rows));
      }
      for (const page of jsonPages([...this.paths].filter(([, held]) => held.n > 0).map(([path, held]) => ({ path, ...held })))) statements.push(db.prepare(`INSERT INTO session_paths (project_id,session_id,generation,path,tool_calls,last_at,edits,last_turn)
        SELECT ?,?,?,json_extract(j.value,'$.path'),json_extract(j.value,'$.n'),json_extract(j.value,'$.at'),json_extract(j.value,'$.edits'),json_extract(j.value,'$.turn') FROM json_each(?) j
          WHERE true
        ON CONFLICT (project_id,session_id,generation,path) DO UPDATE SET tool_calls=tool_calls+excluded.tool_calls,edits=edits+excluded.edits,
          last_turn=CASE WHEN excluded.last_at >= last_at THEN excluded.last_turn ELSE last_turn END,last_at=MAX(last_at,excluded.last_at)`)
        .bind(p, s, g, JSON.stringify(page)));
    }
    if (this.mycoCalls.size > 0) {
      for (const page of jsonPages([...this.mycoCalls.values()].map(record => ({ id: record.id, tool: record.myco_tool, op: record.myco_op ?? null, ok: record.success, at: record.created_at, harness: record.harness })))) statements.push(db.prepare(`INSERT INTO myco_tool_calls (project_id,session_id,generation,tool_call_id,myco_tool,myco_op,success,created_at,harness)
        SELECT ?,?,?,json_extract(value,'$.id'),json_extract(value,'$.tool'),json_extract(value,'$.op'),json_extract(value,'$.ok'),
          json_extract(value,'$.at'),json_extract(value,'$.harness') FROM json_each(?) WHERE true
        ON CONFLICT (project_id,session_id,generation,tool_call_id) DO UPDATE SET myco_op=excluded.myco_op,success=excluded.success`)
        .bind(p, s, g, JSON.stringify(page)));
    }
    statements.push(...this.writer.metadataStatements(layout));
    statements.push(...this.sealStatements());
    return statements;
  }

  /**
   * The card state of the turns this batch settled, run before their new input hashes are stored. A turn whose input
   * hash changed, or that has no card, is pending and waits to be settled: at once when it is closed, and once quiet
   * when it is the open turn. A new open turn brings the pending turns before it forward. A turn whose prompt is on none
   * of the pages read has no hash, and its card stands. A building generation adds only the cards missing, so the cards of a converted session carry over by key.
   */
  private cardStatements(settled: readonly Record<string, unknown>[], building: boolean, now: number): PreparedStatement[] {
    const db = this.db;
    const p = this.projectId, s = this.sessionId;
    const turns = JSON.stringify(settled.filter((turn) => turn.input_hash !== undefined).map((turn) => ({
      id: turn.id, hash: turn.input_hash, at: turn.at, activity: turn.last, settle: turn.id === this.openTurn ? Number(turn.last) + TURN_QUIET_MS : now,
    })));
    return [
      db.prepare(`INSERT INTO turn_cards (project_id,session_id,turn_key,settle_at,created_at,source_activity_at)
        SELECT ?1,?2,json_extract(j.value,'$.id'),json_extract(j.value,'$.settle'),json_extract(j.value,'$.at'),json_extract(j.value,'$.activity') FROM json_each(?4) j
        WHERE json_extract(j.value,'$.hash') IS NOT (SELECT sp.input_hash FROM session_prompts sp WHERE sp.project_id=?1 AND sp.session_id=?2
          AND sp.generation=?3 AND sp.prompt_id=json_extract(j.value,'$.id'))
        ON CONFLICT (project_id,session_id,turn_key) DO ${building ? 'NOTHING' : `UPDATE SET state='pending',changes=changes+1,due_at=NULL,settle_at=excluded.settle_at`}`)
        .bind(p, s, this.doc.generation, turns),
      db.prepare(`WITH j(id,value) AS MATERIALIZED (SELECT json_extract(value,'$.id'),value FROM json_each(?3))
        UPDATE turn_cards SET source_activity_at=MAX(COALESCE(source_activity_at,0),json_extract(j.value,'$.activity'))
        FROM j WHERE project_id=?1 AND session_id=?2 AND turn_key=j.id
          AND (source_activity_at IS NULL OR source_activity_at<json_extract(j.value,'$.activity'))`).bind(p, s, turns),
      ...(this.openTurn === this.doc.open_turn_key ? [] : [db.prepare(`UPDATE turn_cards SET settle_at=MIN(settle_at,?) WHERE project_id=? AND session_id=?
        AND state='pending' AND settle_at IS NOT NULL AND turn_key IS NOT ?`).bind(now, p, s, this.openTurn)]),
      ...publicationProgressStatements(db, p, s, now),
    ];
  }

  /** What this batch adds to the session's catalog row: its counters, chunk numbering and turn fields. */
  private catalogDelta(now: number): CatalogDelta {
    const c = this.counts;
    return { prompts: c.prompts, userPrompts: c.user_prompts, replies: c.replies, toolCalls: c.tool_calls, failedTools: c.failed_tools, plans: c.plans,
      mycoCalls: c.myco_calls, firstPrompt: this.firstPrompt, openTurn: this.openTurn, lastRecordAt: this.lastRecordAt, nextChunk: this.writer.nextChunk,
      now, rewrittenBefore: this.rewrittenBefore };
  }

  /** The session's catalog row after a publication commit. */
  catalogStatement(now: number): PreparedStatement {
    return prepareBound(this.db, catalogAfterPublication(this.projectId, this.sessionId, this.catalogDelta(now)));
  }

  /** The session's catalog row after a restore commit, live at the restored generation. */
  restoredCatalogStatement(now: number, restore: { generation: number; build: string | null }): PreparedStatement {
    return prepareBound(this.db, catalogAfterRestore(this.projectId, this.sessionId, this.catalogDelta(now), restore));
  }

  /**
   * Holds, registers and adopts this batch's chunk versions. Each version is held by a `retired_objects` row from before
   * it is registered until the commit removes that row; its proof is registered only while `guard(version)` holds. The
   * commit runs the caller's statements around the shared catalog statements, and a failed pass releases its holders.
   */
  async commit(write: boolean, chunkState: 'building' | 'live', now: number, guard: (version: ChunkVersion) => ContentPublicationGuard,
    statements: (versions: readonly ChunkVersion[]) => Commit | Promise<Commit>): Promise<number> {
    this.sealed = this.pagesToSeal();
    const layout = write ? this.writer.layout() : null;
    const rewrites = layout?.pageChunks.filter(write => write.previous !== undefined && write.metadata !== 1).map(write => write.chunkNo) ?? [];
    this.rewrittenBefore = rewrites.length === 0 ? null : Math.min(...rewrites);
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
      const transaction = [...own.before, ...this.statements(layout, versions, settled, chunkState, now), ...own.after,
        ...(layout !== null && chunkState === 'live' ? [publishedDocument(this.db, this.projectId, this.sessionId, this.doc.generation)] : [])];
      if (this.admitted && reserveReached(this.db, transaction.length, 0)) throw new DocumentPassFull();
      await this.db.batch(transaction);
    } catch (error) {
      if (holders.length > 0) await releaseHolders(this.db, holders, now);
      throw error;
    }
    return versions.length;
  }
}

export { publicationStatement } from '../db/documents/frontiers.js';
