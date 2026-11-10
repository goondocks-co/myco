import { displayPrompt as search_import_displayPrompt } from "@goondocks/myco-shared/prompt-text";
import { processedResourceProofSql as search_import_processedResourceProofSql } from "../../db/processed-resources.js";
import type { RelationalStore as search_import_RelationalStore } from "../../core/adapters.js";
import { occurredAt as search_import_occurredAt } from "../../db/session-dates.js";
import { presentedStatus as search_import_presentedStatus } from "../../db/session-dates.js";
import { SEARCH_QUERY_MAX_CHARS as search_import_SEARCH_QUERY_MAX_CHARS } from "../../core/search-index.js";
import { projectsBoundOnce as search_import_projectsBoundOnce, binaryOrder as search_import_binaryOrder } from "../scope.js";
import type { ProjectSet as search_import_ProjectSet } from "../scope.js";
import type { ReadScope as search_import_ReadScope } from "../scope.js";
import { EmbeddingUnavailable as search_import_EmbeddingUnavailable } from "../../core/embedding/provider.js";
import { notTombstonedSql as search_import_notTombstonedSql } from "../../db/session-read-model.js";
import { SEARCH_TYPES as search_import_SEARCH_TYPES } from "@goondocks/myco-shared/search-types";
import { SEARCH_API_LIMIT as search_import_SEARCH_API_LIMIT } from "@goondocks/myco-shared/search-types";
import { SEARCH_MAX_LIMIT as search_import_SEARCH_MAX_LIMIT } from "@goondocks/myco-shared/search-types";
import { SEARCH_PREVIEW_CHARS as search_import_SEARCH_PREVIEW_CHARS } from "@goondocks/myco-shared/search-types";
import type { SearchType as search_import_SearchType } from "@goondocks/myco-shared/search-types";
import type { SearchOptions as search_import_SearchOptions } from "@goondocks/myco-shared/search-types";
import type { SearchResult as search_import_SearchResult } from "@goondocks/myco-shared/search-types";
import type { SearchAnswer as search_import_SearchAnswer } from "@goondocks/myco-shared/search-types";
import type { SearchAcrossAnswer as search_import_SearchAcrossAnswer } from "@goondocks/myco-shared/search-types";
import type { SearchAcrossResult as search_import_SearchAcrossResult } from "@goondocks/myco-shared/search-types";
import type { ReleaseAnnotation as search_import_ReleaseAnnotation } from "@goondocks/myco-shared/search-types";
import type { SearchTurn as search_import_SearchTurn } from "@goondocks/myco-shared/search-types";
import { getReleaseStatesAcross as search_import_getReleaseStatesAcross } from "../../core/provenance.js";
import { getReleaseStatesForRecords as search_import_getReleaseStatesForRecords } from "../../core/provenance.js";
import { isReleaseNamespace as search_import_isReleaseNamespace } from "../../core/provenance.js";
import type { ReleaseNamespace as search_import_ReleaseNamespace } from "../../core/provenance.js";
import { type embedding_SemanticSearch, embedding_semanticSearch } from './embedding.js';
import { core_search_index_pendingSearchBlobs } from './search-index.js';
import { sessionFieldSql as search_import_sessionFieldSql, rankedAfterSql as search_import_rankedAfterSql, rankingMarks as search_import_rankingMarks, type RevisionKind as search_import_RevisionKind, type RankedIndex as search_import_RankedIndex } from '../../db/search/ranking.js';

const search_SEARCH_MAX_TERMS = 16;

/** Control characters a query may not carry: every C0 control but the tab and line breaks a pasted query splits on, and DEL. */
const search_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class search_InvalidSearch extends Error { }

/** A cursor whose search ranks its matches differently now than at its first page. */
class search_StaleSearch extends search_InvalidSearch { }

/** Punctuation and FTS operators are literal search terms. */
function search_sanitizeFtsQuery(query: string): string {
  return query.split(/\s+/).filter((tok) => tok.length > 0)
    .map((tok) => /^[\w]+$/.test(tok) && !/^(AND|OR|NOT|NEAR)$/.test(tok) ? tok : `"${tok.replace(/"/g, '""')}"`).join(' ');
}

interface search_Source {
  table: string; id: string; title: string; created: string; session: string; prompt: string;
  status?: string; blob?: 'plan' | 'prompt' | 'response'; namespace: string;
  /** The one line a reader sees for the record, which previews it in place of a snippet wherever it has one. */
  line?: string;
  /** A hit on a record of a conversation names the turn it belongs to. */
  turn?: true;
  /** The type whose hits repeat this type's: searched alone this type answers them, and beside that type it adds none. */
  coveredBy?: search_import_SearchType;
}

const search_SOURCES: Record<search_import_SearchType, search_Source> = {
  session: { table: 'sessions', id: 'session_id', title: "COALESCE(NULLIF(d.title, ''), 'Session ' || substr(d.session_id, -6))", created: search_import_occurredAt('d.'), session: 'd.session_id', prompt: 'NULL', status: search_import_presentedStatus('d.'), namespace: 'sessions' },
  spore: { table: 'spores', id: 'id', title: 'd.observation_type', created: 'd.created_at', session: 'd.session_id', prompt: 'NULL', status: 'd.status', namespace: 'spores', line: 'd.agent_line' },
  plan: { table: 'plans', id: 'plan_key', title: "COALESCE(NULLIF(d.title, ''), 'Plan')", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', status: 'd.status', blob: 'plan', namespace: 'plans' },
  prompt: { table: 'turn_cards', id: 'turn_key', title: "'Prompt'", created: 'd.created_at', session: 'd.session_id', prompt: 'd.turn_key', namespace: 'prompt_batches', turn: true },
  response: { table: 'turn_cards', id: 'turn_key', title: "'Response'", created: 'd.created_at', session: 'd.session_id', prompt: 'd.turn_key', namespace: 'responses', turn: true, coveredBy: 'prompt' },
};

const search_ALIASES: Record<string, search_import_SearchType> = {
  sessions: 'session', spores: 'spore', plans: 'plan',
  prompts: 'prompt', prompt_batches: 'prompt', responses: 'response',
};

function search_typesFor(value: string | undefined): readonly search_import_SearchType[] {
  if (value === undefined || value === 'all') return search_import_SEARCH_TYPES;
  const type = search_ALIASES[value] ?? value;
  if (!search_import_SEARCH_TYPES.includes(type as search_import_SearchType)) throw new search_InvalidSearch(`unsupported search type: ${value}`);
  return [type as search_import_SearchType];
}

interface search_Hit {
  agent: string | null; project_id: string; id: string; title: string; preview: string; rank: number; created_at: number; session_id: string | null; prompt_id: string | null;
  turn_id?: string | null; turn_preview?: string | null; turn_chars?: number | null; turn_stored?: number | null;
  ceiling?: number | null;
}

/** Where a page of one type's matches, listed by time, ends: the last match's place in an order of immutable keys. */
interface search_TimeCursor { type: search_import_SearchType; created_at: number; id: string; project_id: string }

/** A match's place in its type's ranking: best rank first, then the newest, then the id and the Project. */
interface search_RankKey { rank: number; created_at: number; id: string; project_id: string }

/**
 * Where a page of matches listed by relevance ends, for each type searched: after the last match of that type the pages
 * so far listed, or `done` when every match of that type is listed. `search` names the query, filters and reach the
 * cursor belongs to. `ceiling` is each type's highest row at the first page: later pages list only rows at
 * or below it, so a record written after the first page never enters the walk. `marks` fence the ranking itself.
 */
interface search_RelevanceCursor {
  kind: 'relevance';
  search: string;
  /** Each searched type's ranking statistics at the first page: a later page ranks the same way or is refused. */
  marks: Partial<Record<search_import_SearchType, string>>;
  ceiling: Partial<Record<search_import_SearchType, number>>;
  after: Partial<Record<search_import_SearchType, search_RankKey | 'done'>>;
}

const search_utf8 = new TextEncoder();

const search_CURSOR_MAX_CHARS = 4096;

function search_encodeCursor(cursor: search_TimeCursor | search_RelevanceCursor): string {
  let binary = '';
  for (const byte of search_utf8.encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const search_invalidCursor = () => new search_InvalidSearch('cursor is not one this search returned: send the cursor of the previous page of the same search, or none for the first page');

function search_decodeToken(value: string): Record<string, unknown> {
  if (value.length === 0 || value.length > search_CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) throw search_invalidCursor();
  let parsed: unknown;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw search_invalidCursor(); }
  if (typeof parsed !== 'object' || parsed === null) throw search_invalidCursor();
  return parsed as Record<string, unknown>;
}

function search_decodeCursor(value: string, type: search_import_SearchType): search_TimeCursor {
  const c = search_decodeToken(value);
  if (c.type !== type || typeof c.created_at !== 'number' || !Number.isSafeInteger(c.created_at)
    || typeof c.id !== 'string' || typeof c.project_id !== 'string') throw search_invalidCursor();
  return { type, created_at: c.created_at, id: c.id, project_id: c.project_id };
}

function search_decodeRelevance(value: string, types: readonly search_import_SearchType[]): search_RelevanceCursor {
  const c = search_decodeToken(value);
  if (c.kind !== 'relevance' || typeof c.search !== 'string' || typeof c.ceiling !== 'object' || c.ceiling === null
    || typeof c.after !== 'object' || c.after === null || typeof c.marks !== 'object' || c.marks === null) throw search_invalidCursor();
  const marks: search_RelevanceCursor['marks'] = {};
  const ceiling: search_RelevanceCursor['ceiling'] = {};
  const after: search_RelevanceCursor['after'] = {};
  for (const type of types) {
    const mark = (c.marks as Record<string, unknown>)[type];
    if (mark !== undefined) { if (typeof mark !== 'string') throw search_invalidCursor(); marks[type] = mark; }
    const top = (c.ceiling as Record<string, unknown>)[type];
    if (top !== undefined) { if (typeof top !== 'number' || !Number.isSafeInteger(top)) throw search_invalidCursor(); ceiling[type] = top; }
    const key = (c.after as Record<string, unknown>)[type];
    if (key === undefined) continue;
    if (key === 'done') { after[type] = 'done'; continue; }
    const k = key as Partial<Record<keyof search_RankKey, unknown>> | null;
    if (typeof k !== 'object' || k === null || typeof k.rank !== 'number' || !Number.isFinite(k.rank) || typeof k.created_at !== 'number'
      || !Number.isSafeInteger(k.created_at) || typeof k.id !== 'string' || typeof k.project_id !== 'string') throw search_invalidCursor();
    after[type] = { rank: k.rank, created_at: k.created_at, id: k.id, project_id: k.project_id };
  }
  return { kind: 'relevance', search: c.search, marks, ceiling, after };
}

/** How one type's matches are listed: best match first, or oldest first; both continue after the previous page. */
type search_Listing =
  | { by: 'relevance'; after: search_RankKey | null; ceiling: number | null }
  | { by: 'time'; after: search_TimeCursor | null };

/** One type's matches in the order they are listed, each with its place, whether more follow, and the type's highest row when read. */
interface search_TypeHits { hits: search_import_SearchAcrossResult[]; keys: search_RankKey[]; more: boolean; ceiling: number | null; cursor: string | null }

/** Where a search reads: one Project, or a set of them. */
type search_SearchReach = search_import_ReadScope | search_import_ProjectSet;

/** The reach as a predicate on `d.project_id`. A set binds at most one value, so the predicate repeats in a statement without multiplying its binds. */
function search_reachOf(reach: search_SearchReach): { sql: string; params: string[] } {
  return 'projectId' in reach ? { sql: 'd.project_id = ?', params: [reach.projectId] } : search_import_projectsBoundOnce(reach, 'd');
}

async function search_searchType(
  db: search_import_RelationalStore,
  reach: search_SearchReach,
  type: search_import_SearchType,
  terms: string[],
  opts: search_import_SearchOptions,
  limit: number,
  listing: search_Listing,
): Promise<search_TypeHits> {
  const s = search_SOURCES[type];
  const none: search_TypeHits = { hits: [], keys: [], more: false, ceiling: null, cursor: null };
  if ((opts.status !== undefined && s.status === undefined) || (opts.observation_type !== undefined && type !== 'spore')) return none;
  if ((opts.session_id !== undefined || opts.agent !== undefined || opts.branch !== undefined) && s.session === 'NULL') return none;
  const fts = `${s.table}_fts`;
  if (s.blob === undefined) terms = [terms.join(' AND ')];
  else if (terms.length > 1) {
    const counts = await Promise.all(
      terms.map(async (term) => {
        const word = /^(?:[A-Za-z0-9]+|"[A-Za-z0-9]+")$/.test(term) ? term.replaceAll('"', '').toLowerCase() : null;
        const row =
          word === null
            ? await db
                .prepare(
                  `SELECT (SELECT COUNT(*) FROM ${fts} WHERE ${fts} MATCH ?)
          +(SELECT COUNT(*) FROM search_blob_chunks_fts WHERE search_blob_chunks_fts MATCH ?) AS n`,
                )
                .bind(term, term)
                .first<{ n: number }>()
            : await db
                .prepare(
                  `SELECT COALESCE((SELECT doc FROM plans_search_terms WHERE term=?),0)
          +COALESCE((SELECT doc FROM blob_search_terms WHERE term=?),0) AS n`,
                )
                .bind(word, word)
                .first<{ n: number }>();
        return row!.n;
      }),
    );
    const first = counts.indexOf(Math.min(...counts));
    terms = [terms[first]!, ...terms.filter((_, index) => index !== first)];
  }
  const inReach = search_reachOf(reach);
  // The full-text match drives each branch, and `CROSS JOIN` holds that order: a planner free to choose may instead read
  // every row of the reach and evaluate the match once per row.
  const params: (string | number)[] = [terms[0], ...inReach.params];
  // A candidate carries its rank, which branch matched it and the matched row, never its snippet: a snippet is read for
  // the rows the page keeps, by matching that one row again.
  const first = `SELECT d.rowid AS source_rowid, ${fts}.rank AS rank, 0 AS branch, ${fts}.rowid AS match_rowid
    FROM ${fts} CROSS JOIN ${s.table} d ON d.rowid = ${fts}.rowid
    WHERE ${fts} MATCH ? AND ${inReach.sql}`;
  const blob = s.blob
    ? ` UNION ALL SELECT d.rowid AS source_rowid, search_blob_chunks_fts.rank AS rank, 1 AS branch,
    search_blob_chunks_fts.rowid AS match_rowid
    FROM search_blob_chunks_fts CROSS JOIN search_blob_chunks c ON c.rowid = search_blob_chunks_fts.rowid
    CROSS JOIN ${s.table} d ON d.project_id = c.project_id AND d.blob_key = c.blob_key
    WHERE search_blob_chunks_fts MATCH ? AND ${inReach.sql} AND ${search_import_processedResourceProofSql('d.project_id', s.blob, `d.${s.id}`, 'd.blob_key')}`
    : '';
  if (s.blob) params.push(terms[0], ...inReach.params);
  // Each candidate is already a row of the reach. The outer read walks the candidates and joins each one's row back by
  // rowid: `CROSS JOIN` holds that order, so no statistics can turn it into a walk of the table.
  const where: string[] = [];
  if (type === 'session' || type === 'plan' || s.turn === true) where.push(search_import_notTombstonedSql('d'));
  for (const term of terms.slice(1)) {
    let exists = `EXISTS (SELECT 1 FROM ${fts} WHERE ${fts}.rowid = d.rowid AND ${fts} MATCH ?)`;
    params.push(term);
    if (s.blob) {
      exists += ` OR EXISTS (SELECT 1 FROM search_blob_chunks_fts JOIN search_blob_chunks c
        ON c.rowid = search_blob_chunks_fts.rowid WHERE c.project_id = d.project_id AND c.blob_key = d.blob_key
        AND search_blob_chunks_fts MATCH ? AND ${search_import_processedResourceProofSql('d.project_id', s.blob, `d.${s.id}`, 'd.blob_key')})`;
      params.push(term);
    }
    where.push(`(${exists})`);
  }
  const filter = (value: string | number | undefined, expression: string) => {
    if (value !== undefined) {
      where.push(expression);
      params.push(value);
    }
  };
  filter(opts.status, `${s.status} = ?`);
  filter(opts.session_id, `${s.session} = ?`);
  filter(opts.observation_type, 'd.observation_type = ?');
  const sessionColumn = (column: 'agent' | 'branch') => type === 'session' ? `d.${column} = ?` : search_import_sessionFieldSql(s.session, column);
  filter(opts.agent, sessionColumn('agent'));
  filter(opts.branch, sessionColumn('branch'));
  filter(opts.since === undefined ? undefined : opts.since * 1000, `${s.created} >= ?`);
  filter(opts.until === undefined ? undefined : opts.until * 1000, `${s.created} <= ?`);
  if (opts.release_state !== undefined || opts.release_confidence !== undefined) {
    let condition = 'k.project_id = d.project_id AND k.namespace = ? AND k.record_id = d.' + s.id;
    params.push(s.namespace);
    if (opts.release_state !== undefined) {
      condition += ' AND k.state = ?';
      params.push(opts.release_state);
    }
    if (opts.release_confidence !== undefined) {
      condition += ' AND k.confidence = ?';
      params.push(opts.release_confidence);
    }
    where.push(`EXISTS (SELECT 1 FROM knowledge_release_state k WHERE ${condition})`);
  }
  // Listed by time, a page after another starts past that page's last match in an order of keys no capture changes: the record's own
  // time, its id, its Project. One row past the page says whether another follows.
  if (listing.by === 'time' && listing.after !== null) {
    const { created_at, id, project_id } = listing.after;
    where.push(`(${s.created} > ? OR (${s.created} = ? AND d.${s.id} > ?) OR (${s.created} = ? AND d.${s.id} = ? AND d.project_id > ?))`);
    params.push(created_at, created_at, id, created_at, id, project_id);
  }
  // Listed by relevance, a later page reads only rows that existed at the first page, and starts past the
  // previous page's last match in the ranking: rank, then newest, then id and Project.
  if (listing.by === 'relevance' && listing.ceiling !== null) { where.push('d.rowid <= ?'); params.push(listing.ceiling); }
  const having = listing.by === 'relevance' && listing.after !== null ? search_import_rankedAfterSql('MIN(candidates.rank)', s.created, `d.${s.id}`, 'd.project_id') : '';
  if (listing.by === 'relevance' && listing.after !== null) {
    const { rank, created_at, id, project_id } = listing.after;
    params.push(rank, rank, created_at, created_at, id, id, project_id);
  }
  params.push(limit + 1);
  // The page's snippets: each kept row's best match, matched again by its rowid in the branch that found it.
  const ownSnippet = `(SELECT snippet(${fts}, -1, '', '', ' … ', 40) FROM ${fts} WHERE ${fts} MATCH ? AND ${fts}.rowid = kept.match_rowid)`;
  const blobSnippet = `(SELECT snippet(search_blob_chunks_fts, 0, '', '', ' … ', 40) FROM search_blob_chunks_fts
    WHERE search_blob_chunks_fts MATCH ? AND search_blob_chunks_fts.rowid = kept.match_rowid)`;
  const snippet = s.blob ? `CASE kept.branch WHEN 0 THEN ${ownSnippet} ELSE ${blobSnippet} END` : ownSnippet;
  const preview = s.line === undefined ? snippet : `COALESCE(NULLIF(${s.line}, ''), ${snippet})`;
  params.push(terms[0]);
  if (s.blob) params.push(terms[0]);
  // A conversation hit names its turn: the hit's own prompt reference, kept only where the Project's session holds that prompt, and a
  // steering prompt resolved to the turn it steers, as the named-turn read does. Both reads are by primary key.
  const turnColumns = s.turn ? `, tp.prompt_id AS turn_id, tp.preview AS turn_preview, tp.text_chars AS turn_chars, 0 AS turn_stored` : '';
  const turnJoins = s.turn
    ? `LEFT JOIN session_documents td ON td.project_id = kept.project_id AND td.session_id = ${s.session} AND td.state = 'live'
    LEFT JOIN session_prompts tp ON tp.project_id = td.project_id AND tp.session_id = td.session_id AND tp.generation = td.generation
      AND tp.prompt_id = ${s.prompt} AND tp.turn_key = tp.prompt_id`
    : '';
  const keptOrder = listing.by === 'time' ? 'created_at, id, d.project_id' : 'rank, created_at DESC, id, d.project_id';
  const listedOrder =
    listing.by === 'time' ? 'kept.created_at, kept.id, kept.project_id' : 'kept.rank, kept.created_at DESC, kept.id, kept.project_id';
  const found = (
    await db
      .prepare(
        // The two leading CTEs decide which records a page lists and in what order, from keys, rank and the ordering instant
        // alone; the final select only presents the kept rows, joined back by rowid. The search revision gate reads the
        // CTEs to derive every column a page's membership and order rest on.
        `WITH candidates AS MATERIALIZED (${first}${blob}),
    kept AS MATERIALIZED (SELECT d.rowid AS source_rowid, d.project_id, d.${s.id} AS id, MIN(candidates.rank) AS rank,
      candidates.branch, candidates.match_rowid, ${s.created} AS created_at
    FROM candidates CROSS JOIN ${s.table} d ON d.rowid = candidates.source_rowid
    ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} GROUP BY d.rowid ${having} ORDER BY ${keptOrder} LIMIT ?)
    SELECT kept.project_id, kept.id, ${s.title} AS title, kept.rank, kept.created_at, ${s.session} AS session_id, ${s.prompt} AS prompt_id,
      (SELECT agent FROM sessions WHERE project_id = kept.project_id AND session_id = ${s.session}) AS agent, ${preview} AS preview${turnColumns},
      (SELECT MAX(rowid) FROM ${s.table}) AS ceiling
    FROM kept CROSS JOIN ${s.table} d ON d.rowid = kept.source_rowid ${turnJoins} ORDER BY ${listedOrder}`,
      )
      .bind(...params)
      .all<search_Hit>()
  ).results;
  const more = found.length > limit;
  const rows = (more ? found.slice(0, limit) : found).filter((r) => r.id.length > 0);
  const best = Math.max(...rows.map((r) => Math.abs(r.rank)), Number.MIN_VALUE);
  const tools: Partial<Record<search_import_SearchType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans' };
  const tool = tools[type];
  const last = rows.at(-1);
  const hits = rows
    .map(
      (r): search_import_SearchAcrossResult => ({
        projectId: r.project_id,
        id: r.id,
        type,
        title: type === 'session' ? search_import_displayPrompt(r.title, r.agent) : r.title,
        preview: (type === 'session' || type === 'prompt'
          ? search_import_displayPrompt(r.preview ?? '', r.agent)
          : (r.preview ?? '')
        ).slice(0, search_import_SEARCH_PREVIEW_CHARS),
        score: Math.abs(r.rank) / best,
        created_at: r.created_at,
        ...(r.session_id === null ? {} : { session_id: r.session_id }),
        ...(r.prompt_id === null ? {} : { prompt_id: r.prompt_id }),
        ...(s.turn ? { turn: search_turnOf(r) } : {}),
        ...(tool === undefined ? {} : { retrieve: { tool, input: { op: 'get', id: r.id } } }),
      }),
    );
  const cursor =
    listing.by === 'time' && more && last !== undefined
      ? search_encodeCursor({ type, created_at: last.created_at, id: last.id, project_id: last.project_id })
      : null;
  const keys = rows.map((r) => ({ rank: r.rank, created_at: r.created_at, id: r.id, project_id: r.project_id }));
  const ceiling = listing.by === 'relevance' ? listing.ceiling ?? (found[0] === undefined ? null : Number(found[0].ceiling)) : null;
  return { hits, keys, more, ceiling, cursor };
}

/** The turn a conversation hit opens, or null when its prompt reference names no top-level prompt of the hit's own session. */
function search_turnOf(r: search_Hit): search_import_SearchTurn | null {
  if (r.turn_id == null) return null;
  return { prompt_id: r.turn_id, preview: r.turn_preview ?? null, text_chars: r.turn_chars ?? null, stored: r.turn_stored === 1 };
}

/** Each result's release state, one bulk read per namespace present. */
async function search_withRelease(db: search_import_RelationalStore, scope: search_import_ReadScope, results: search_import_SearchResult[]): Promise<search_import_SearchResult[]> {
  const byNamespace = new Map<search_import_ReleaseNamespace, string[]>();
  for (const r of results) if (search_import_isReleaseNamespace(r.type)) byNamespace.set(r.type, [...(byNamespace.get(r.type) ?? []), r.id]);
  const states = new Map<string, search_import_ReleaseAnnotation>();
  for (const [namespace, ids] of byNamespace) {
    for (const [id, row] of Object.entries(await search_import_getReleaseStatesForRecords(db, scope, namespace, ids))) {
      states.set(`${namespace}:${id}`, search_annotation(row));
    }
  }
  return results.map((r) => {
    const release = states.get(`${r.type}:${r.id}`);
    return release === undefined ? r : { ...r, release };
  });
}

const search_annotation = (row: Awaited<ReturnType<typeof search_import_getReleaseStatesForRecords>>[string]): search_import_ReleaseAnnotation =>
  ({ state: row.state, confidence: row.confidence, ref: row.basisRef, checked_at: row.checkedAt, ...(row.propagating ? { propagating: true } : {}) });

/** Each result's release state across Projects, one batched read per Project and namespace present. */
async function search_withReleaseAcross(db: search_import_RelationalStore, results: search_import_SearchAcrossResult[]): Promise<search_import_SearchAcrossResult[]> {
  const groups = new Map<string, { projectId: string; namespace: search_import_ReleaseNamespace; recordIds: string[] }>();
  const key = (projectId: string, namespace: string) => JSON.stringify([projectId, namespace]);
  for (const r of results) {
    if (!search_import_isReleaseNamespace(r.type)) continue;
    const group = groups.get(key(r.projectId, r.type)) ?? { projectId: r.projectId, namespace: r.type, recordIds: [] };
    group.recordIds.push(r.id);
    groups.set(key(r.projectId, r.type), group);
  }
  const wanted = [...groups.values()];
  const answers = await search_import_getReleaseStatesAcross(db, wanted);
  const states = new Map<string, search_import_ReleaseAnnotation>();
  wanted.forEach((w, i) => { for (const [id, row] of Object.entries(answers[i] ?? {})) states.set(JSON.stringify([w.projectId, w.namespace, id]), search_annotation(row)); });
  return results.map((r) => {
    const release = states.get(JSON.stringify([r.projectId, r.type, r.id]));
    return release === undefined ? r : { ...r, release };
  });
}

/** One scoped search implementation for HTTP and MCP. An unavailable semantic provider is explicit. */
async function search_searchProject(db: search_import_RelationalStore, scope: search_import_ReadScope, opts: search_import_SearchOptions, resolveSemantic?: () => Promise<embedding_SemanticSearch | null>): Promise<search_import_SearchAnswer> {
  const answer = await search_searchUnannotated(db, scope, opts, resolveSemantic);
  return { ...answer, results: await search_withRelease(db, scope, answer.results) };
}

/**
 * Full-text search across a set of Projects: every Project that accepts capture, or the ones named. Each type is one
 * statement over the whole set, ranked by the same full-text rank a Project's search uses; the index's statistics span
 * every Project, so ranks compare across them. Semantic search reads one Project's vectors, so `mode` here is `auto`
 * or `fts`, and the answer is always full text.
 */
async function search_searchAcross(db: search_import_RelationalStore, set: search_import_ProjectSet, opts: search_import_SearchOptions): Promise<search_import_SearchAcrossAnswer> {
  const { words, types, mode, limit, listing } = search_validated(opts);
  if (mode === 'semantic') throw new search_InvalidSearch('semantic search reads one project; across projects, mode must be auto or fts');
  const { results, cursor } = await search_fullText(db, set, types, words, opts, limit, listing);
  return { results: await search_withReleaseAcross(db, results), mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: await core_search_index_pendingSearchBlobs(db, set) }, cursor, hasMore: cursor !== null };
}

/** How a validated search lists its matches; a relevance cursor is checked against its search where the reach is known. */
type search_Requested = { by: 'relevance'; cursor: search_RelevanceCursor | null } | { by: 'time'; after: search_TimeCursor | null };

function search_validated(opts: search_import_SearchOptions): { query: string; words: string[]; types: readonly search_import_SearchType[]; mode: string; limit: number; listing: search_Requested } {
  const query = opts.query.trim();
  if (query.length === 0 || query.length > search_import_SEARCH_QUERY_MAX_CHARS) throw new search_InvalidSearch(`query must contain 1–${search_import_SEARCH_QUERY_MAX_CHARS} characters`);
  if (search_CONTROL_CHARACTERS.test(query)) throw new search_InvalidSearch('query must not contain control characters');
  const words = query.split(/\s+/);
  if (words.length > search_SEARCH_MAX_TERMS) throw new search_InvalidSearch(`query may contain at most ${search_SEARCH_MAX_TERMS} terms`);
  const types = search_typesFor(opts.type);
  const mode = opts.mode ?? 'auto';
  if (!['auto', 'fts', 'semantic'].includes(mode)) throw new search_InvalidSearch('mode must be auto, fts or semantic');
  const limit = opts.limit ?? search_import_SEARCH_API_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > search_import_SEARCH_MAX_LIMIT) throw new search_InvalidSearch(`limit must be between 1 and ${search_import_SEARCH_MAX_LIMIT}`);
  for (const value of [opts.since, opts.until]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new search_InvalidSearch('timestamps must be non-negative epoch seconds');
  if (opts.since !== undefined && opts.until !== undefined && opts.since > opts.until) throw new search_InvalidSearch('since must not exceed until');
  const order = opts.order ?? 'relevance';
  if (order !== 'relevance' && order !== 'time') throw new search_InvalidSearch('order must be relevance or time');
  if (order === 'relevance') {
    return { query, words, types, mode, limit, listing: { by: 'relevance', cursor: opts.cursor === undefined ? null : search_decodeRelevance(opts.cursor, types) } };
  }
  // Only a search by time pages: its order rests on keys no capture changes, so a page after another never loses or repeats a match.
  const [only, ...others] = types;
  if (only === undefined || others.length > 0) throw new search_InvalidSearch('order=time lists the matches of one type; name it with type');
  if (only === 'session') throw new search_InvalidSearch('order=time does not apply to sessions');
  if (mode === 'semantic') throw new search_InvalidSearch('order=time lists full-text matches; mode must be auto or fts');
  return { query, words, types, mode, limit, listing: { by: 'time', after: opts.cursor === undefined ? null : search_decodeCursor(opts.cursor, only) } };
}

/** The query, filters and reach a relevance cursor belongs to, as a short digest: a cursor from another search is refused. */
function search_digest(reach: search_SearchReach, types: readonly search_import_SearchType[], words: readonly string[], opts: search_import_SearchOptions): string {
  const named = 'projectId' in reach ? ['project', reach.projectId] : reach.all ? ['all'] : ['named', ...reach.projectIds];
  const text = JSON.stringify([named, types, words, opts.status, opts.session_id, opts.observation_type, opts.since, opts.until,
    opts.release_state, opts.release_confidence, opts.agent, opts.branch]);
  let hash = 0x811c9dc5;
  for (const byte of search_utf8.encode(text)) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

/**
 * Listed by relevance, each type's next matches after its place in the cursor, merged: every type's best first, then the
 * rest by score, to the limit. What a page takes of each type is always the head of that type's ranking, so the next
 * page continues each type after the last of it this page listed, and no match repeats or is skipped. A record written
 * after the first page is never listed; one that changes an index's ranking statistics refuses the next page, which names
 * the first page to read again. Listed by time, one
 * type's matches oldest first, each page naming the cursor of the matches after it.
 */
async function search_fullText(db: search_import_RelationalStore, reach: search_SearchReach, types: readonly search_import_SearchType[], words: string[], opts: search_import_SearchOptions, limit: number, listing: search_Requested): Promise<{ results: search_import_SearchAcrossResult[]; cursor: string | null }> {
  const terms = words.map(search_sanitizeFtsQuery);
  if (listing.by === 'time') {
    const { hits, cursor } = await search_searchType(db, reach, types[0]!, terms, opts, limit, listing);
    return { results: hits, cursor };
  }
  const search = search_digest(reach, types, words, opts);
  if (listing.cursor !== null && listing.cursor.search !== search) throw search_invalidCursor();
  const at = listing.cursor;
  const searched = types.filter((type) => { const by = search_SOURCES[type].coveredBy; return by === undefined || !types.includes(by); });
  const open = searched.filter((type) => at?.after[type] !== 'done');
  // A type's ranking and membership rest on its full-text indexes and on its revision, which moves with every column its
  // order and filters read; a search narrowed by a session's agent or branch also rests on the sessions' revision, one
  // narrowed by release classification on the release revision, and one over every Project on the Projects' revision.
  // All are read before and after the page for every type the search covers, an exhausted type included: a record of that
  // type can still become a match. A change between the two reads means the page may mix two states.
  const indexesOf = (type: search_import_SearchType): search_import_RankedIndex[] =>
    [`${search_SOURCES[type].table}_fts` as search_import_RankedIndex, ...(search_SOURCES[type].blob === undefined ? [] : ['search_blob_chunks_fts' as const])];
  const kindsOf = (type: search_import_SearchType): search_import_RevisionKind[] => {
    const own: search_import_RevisionKind = type === 'prompt' || type === 'response' ? 'turn' : type;
    return [own, ...(own !== 'session' && (opts.agent !== undefined || opts.branch !== undefined) ? ['session' as const] : []),
      ...(opts.release_state !== undefined || opts.release_confidence !== undefined ? ['release' as const] : []),
      ...(!('projectId' in reach) && reach.all ? ['projects' as const] : [])];
  };
  const readMarks = async () => {
    const rows = await search_import_rankingMarks(db, searched.flatMap(indexesOf), searched.flatMap(kindsOf));
    const revisions = rows.slice(searched.flatMap(indexesOf).length);
    let index = 0;
    let revision = 0;
    return Object.fromEntries(searched.map((type) => {
      const own = rows.slice(index, index + indexesOf(type).length);
      index += own.length;
      const kinds = revisions.slice(revision, revision + kindsOf(type).length);
      revision += kinds.length;
      return [type, [...own, ...kinds].join('+')];
    })) as Partial<Record<search_import_SearchType, string>>;
  };
  const stale = () => new search_StaleSearch('the matches changed since the first page of this search, so its ranking moved and a next page could skip or repeat a match: request the first page again without a cursor');
  for (let attempt = 0; ; attempt += 1) {
    const marks = await readMarks();
    if (at !== null && searched.some((type) => at.marks[type] !== marks[type])) throw stale();
    const read = await search_relevancePage(db, reach, terms, opts, limit, open, at, search, marks);
    const after = await readMarks();
    if (searched.every((type) => after[type] === marks[type])) return read;
    // A first page read again where a write landed under it; a later page is refused, as its cursor no longer holds.
    if (at !== null || attempt >= 2) throw stale();
  }
}

/** One relevance page of the open types, at the marks read just before it, with the cursor that continues it. */
async function search_relevancePage(db: search_import_RelationalStore, reach: search_SearchReach, terms: string[], opts: search_import_SearchOptions, limit: number,
  open: readonly search_import_SearchType[], at: search_RelevanceCursor | null, search: string, marks: Partial<Record<search_import_SearchType, string>>): Promise<{ results: search_import_SearchAcrossResult[]; cursor: string | null }> {
  const branches = await Promise.all(open.map(async (type) => {
    const after = at?.after[type];
    const found = await search_searchType(db, reach, type, terms, opts, limit,
      { by: 'relevance', after: after === undefined || after === 'done' ? null : after, ceiling: at?.ceiling[type] ?? null });
    return { type, found, entries: found.hits.map((hit, i) => ({ hit, key: found.keys[i]! })) };
  }));

  // Within a type this is the type's own ranking order (rank, newest, id and Project in byte order), so a cut keeps a head of it.
  const order = (a: search_import_SearchAcrossResult, b: search_import_SearchAcrossResult) => b.score - a.score
    || search_import_SEARCH_TYPES.indexOf(a.type) - search_import_SEARCH_TYPES.indexOf(b.type) || b.created_at - a.created_at
    || search_import_binaryOrder(a.id, b.id) || search_import_binaryOrder(a.projectId, b.projectId);
  const byHit = (a: { hit: search_import_SearchAcrossResult }, b: { hit: search_import_SearchAcrossResult }) => order(a.hit, b.hit);
  const floor = branches.flatMap((branch) => branch.entries.slice(0, 1)).sort(byHit).slice(0, limit);
  const remaining = branches.flatMap((branch) => branch.entries.slice(1)).sort(byHit).slice(0, limit - floor.length);
  const taken = new Set([...floor, ...remaining]);
  const next: search_RelevanceCursor = { kind: 'relevance', search, marks: { ...(at?.marks ?? {}), ...marks }, ceiling: { ...(at?.ceiling ?? {}) }, after: { ...(at?.after ?? {}) } };
  let more = false;
  for (const branch of branches) {
    if (branch.found.ceiling !== null) next.ceiling[branch.type] = branch.found.ceiling;
    const kept = branch.entries.filter((entry) => taken.has(entry));
    const last = kept.at(-1);
    if (last !== undefined) next.after[branch.type] = last.key;
    if (!branch.found.more && kept.length === branch.entries.length) next.after[branch.type] = 'done';
    else more = true;
  }
  return { results: [...taken].map((entry) => entry.hit).sort(order), cursor: more ? search_encodeCursor(next) : null };
}

async function search_searchUnannotated(db: search_import_RelationalStore, scope: search_import_ReadScope, opts: search_import_SearchOptions, resolveSemantic?: () => Promise<embedding_SemanticSearch | null>): Promise<search_import_SearchAnswer> {
  const { query, words, types, mode, limit, listing } = search_validated(opts);
  const coverage = { pending_blobs: await core_search_index_pendingSearchBlobs(db, scope.projectId) };
  // A continued search lists full-text matches: a semantic answer is the nearest matches alone and names no next page.
  if (mode !== 'fts' && listing.by === 'relevance' && listing.cursor === null) {
    const semantic = await resolveSemantic?.();
    if (semantic != null) {
      try {
        return { results: await embedding_semanticSearch(db, scope, semantic, types, { ...opts, query }, limit), mode: 'semantic', provider_unavailable: false, coverage, cursor: null, hasMore: false };
      } catch (error) { if (!(error instanceof search_import_EmbeddingUnavailable)) throw error; }
    }
  }
  if (mode === 'semantic') return { results: [], mode, provider_unavailable: true, coverage, cursor: null, hasMore: false };
  const found = await search_fullText(db, scope, types, words, opts, limit, listing);
  const results = found.results.map(({ projectId: _projectId, ...result }) => result);
  return { results, mode: 'fts', provider_unavailable: mode === 'auto' && listing.by === 'relevance' && listing.cursor === null, coverage, cursor: found.cursor, hasMore: found.cursor !== null };
}

export { search_InvalidSearch, search_StaleSearch, search_sanitizeFtsQuery, search_searchProject, search_searchAcross };
