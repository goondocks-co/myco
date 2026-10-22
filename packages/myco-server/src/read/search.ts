import { displayPrompt } from '@goondocks/myco-shared/prompt-text';
import { processedResourceProofSql } from '../core/processed-resources.js';
import type { RelationalStore } from '../core/adapters.js';
import { occurredAt, presentedStatus } from '../db/session-dates.js';
import { pendingSearchBlobs, SEARCH_QUERY_MAX_CHARS } from '../core/search-index.js';
import { projectsBoundOnce, type ProjectSet, type ReadScope } from './scope.js';
import { semanticSearch, type SemanticSearch } from './embedding.js';
import { EmbeddingUnavailable } from '../core/embedding/provider.js';
import { notTombstonedSql } from '../core/tombstones.js';
import { TURN_PREVIEW_CHARS } from './turns.js';

import { SEARCH_TYPES, SEARCH_API_LIMIT, SEARCH_MAX_LIMIT, SEARCH_PREVIEW_CHARS, type SearchType, type SearchOptions, type SearchResult, type SearchAnswer, type SearchAcrossAnswer, type SearchAcrossResult, type ReleaseAnnotation, type SearchTurn } from '@goondocks/myco-shared/search-types';
import { getReleaseStatesAcross, getReleaseStatesForRecords, isReleaseNamespace, type ReleaseNamespace } from '../core/provenance.js';
export * from '@goondocks/myco-shared/search-types';
const SEARCH_MAX_TERMS = 16;
/** Control characters a query may not carry: every C0 control but the tab and line breaks a pasted query splits on, and DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class InvalidSearch extends Error {}

/** Punctuation and FTS operators are literal search terms. */
export function sanitizeFtsQuery(query: string): string {
  return query.split(/\s+/).filter((tok) => tok.length > 0)
    .map((tok) => /^[\w]+$/.test(tok) && !/^(AND|OR|NOT|NEAR)$/.test(tok) ? tok : `"${tok.replace(/"/g, '""')}"`).join(' ');
}

interface Source {
  table: string; id: string; title: string; created: string; session: string; prompt: string;
  status?: string; blob?: 'plan' | 'prompt' | 'response'; namespace: string;
  /** The one line a reader sees for the record, which previews it in place of a snippet wherever it has one. */
  line?: string;
  /** A hit on a record of a conversation names the turn it belongs to. */
  turn?: true;
}
const SOURCES: Record<SearchType, Source> = {
  session: { table: 'sessions', id: 'session_id', title: "COALESCE(NULLIF(d.title, ''), 'Session ' || substr(d.session_id, -6))", created: occurredAt('d.'), session: 'd.session_id', prompt: 'NULL', status: presentedStatus('d.'), namespace: 'sessions' },
  spore: { table: 'spores', id: 'id', title: 'd.observation_type', created: 'd.created_at', session: 'd.session_id', prompt: 'NULL', status: 'd.status', namespace: 'spores', line: 'd.agent_line' },
  plan: { table: 'plans', id: 'plan_key', title: "COALESCE(NULLIF(d.title, ''), 'Plan')", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', status: 'd.status', blob: 'plan', namespace: 'plans' },
  prompt: { table: 'prompt_batches', id: 'prompt_id', title: "'Prompt'", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', blob: 'prompt', namespace: 'prompt_batches', turn: true },
  response: { table: 'responses', id: 'response_id', title: "'Response'", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', blob: 'response', namespace: 'responses', turn: true },
};

const ALIASES: Record<string, SearchType> = {
  sessions: 'session', spores: 'spore', plans: 'plan',
  prompts: 'prompt', prompt_batches: 'prompt', responses: 'response',
};

function typesFor(value: string | undefined): readonly SearchType[] {
  if (value === undefined || value === 'all') return SEARCH_TYPES;
  const type = ALIASES[value] ?? value;
  if (!SEARCH_TYPES.includes(type as SearchType)) throw new InvalidSearch(`unsupported search type: ${value}`);
  return [type as SearchType];
}

interface Hit {
  agent: string | null; project_id: string; id: string; title: string; preview: string; rank: number; created_at: number; session_id: string | null; prompt_id: string | null;
  turn_id?: string | null; turn_preview?: string | null; turn_chars?: number | null; turn_stored?: number | null;
}

/** Where a page of one type's matches, listed by time, ends: the last match's place in an order of immutable keys. */
interface TimeCursor { type: SearchType; created_at: number; id: string; project_id: string }

const utf8 = new TextEncoder();
const CURSOR_MAX_CHARS = 1024;

function encodeCursor(cursor: TimeCursor): string {
  let binary = '';
  for (const byte of utf8.encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(value: string, type: SearchType): TimeCursor {
  const invalid = () => new InvalidSearch('cursor is not one this search returned');
  if (value.length === 0 || value.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let parsed: unknown;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw invalid(); }
  const c = parsed as Partial<Record<keyof TimeCursor, unknown>> | null;
  if (typeof c !== 'object' || c === null || c.type !== type || typeof c.created_at !== 'number' || !Number.isSafeInteger(c.created_at)
    || typeof c.id !== 'string' || typeof c.project_id !== 'string') throw invalid();
  return { type, created_at: c.created_at, id: c.id, project_id: c.project_id };
}

/** How one type's matches are listed: best match first in a single bounded page, or oldest first in pages that continue by cursor. */
type Listing = { by: 'relevance' } | { by: 'time'; after: TimeCursor | null };

/** One type's matches in the order they are listed, and the cursor of the matches after them when they are listed by time and more follow. */
interface TypeHits { hits: SearchAcrossResult[]; cursor: string | null }

/** Where a search reads: one Project, or a set of them. */
type SearchReach = ReadScope | ProjectSet;

/** The reach as a predicate on `d.project_id`. A set binds at most one value, so the predicate repeats in a statement without multiplying its binds. */
function reachOf(reach: SearchReach): { sql: string; params: string[] } {
  return 'projectId' in reach ? { sql: 'd.project_id = ?', params: [reach.projectId] } : projectsBoundOnce(reach, 'd');
}

async function searchType(db: RelationalStore, reach: SearchReach, type: SearchType, terms: string[], opts: SearchOptions, limit: number, listing: Listing): Promise<TypeHits> {
  const s = SOURCES[type];
  const none: TypeHits = { hits: [], cursor: null };
  if ((opts.status !== undefined && s.status === undefined) || (opts.observation_type !== undefined && type !== 'spore')) return none;
  if (opts.session_id !== undefined && s.session === 'NULL') return none;
  const fts = `${s.table}_fts`;
  const inReach = reachOf(reach);
  // The full-text match drives each branch, and `CROSS JOIN` holds that order: a planner free to choose may instead read
  // every row of the reach and evaluate the match once per row.
  const params: (string | number)[] = [terms[0], ...inReach.params];
  // A candidate carries its rank, which branch matched it and the matched row, never its snippet: a snippet is read for
  // the rows the page keeps, by matching that one row again.
  const first = `SELECT d.rowid AS source_rowid, ${fts}.rank AS rank, 0 AS branch, ${fts}.rowid AS match_rowid
    FROM ${fts} CROSS JOIN ${s.table} d ON d.rowid = ${fts}.rowid
    WHERE ${fts} MATCH ? AND ${inReach.sql}`;
  const blob = s.blob ? ` UNION ALL SELECT d.rowid AS source_rowid, search_blob_chunks_fts.rank AS rank, 1 AS branch,
    search_blob_chunks_fts.rowid AS match_rowid
    FROM search_blob_chunks_fts CROSS JOIN search_blob_chunks c ON c.rowid = search_blob_chunks_fts.rowid
    CROSS JOIN ${s.table} d ON d.project_id = c.project_id AND d.blob_key = c.blob_key
    WHERE search_blob_chunks_fts MATCH ? AND ${inReach.sql} AND ${processedResourceProofSql('d.project_id', s.blob, `d.${s.id}`, 'd.blob_key')}` : '';
  if (s.blob) params.push(terms[0], ...inReach.params);
  // Each candidate is already a row of the reach. The outer read walks the candidates and joins each one's row back by
  // rowid: `CROSS JOIN` holds that order, so no statistics can turn it into a walk of the table.
  const where: string[] = [];
  if (type === 'session') where.push(notTombstonedSql('d'));
  for (const term of terms.slice(1)) {
    let exists = `EXISTS (SELECT 1 FROM ${fts} WHERE ${fts}.rowid = d.rowid AND ${fts} MATCH ?)`;
    params.push(term);
    if (s.blob) {
      exists += ` OR EXISTS (SELECT 1 FROM search_blob_chunks_fts JOIN search_blob_chunks c
        ON c.rowid = search_blob_chunks_fts.rowid WHERE c.project_id = d.project_id AND c.blob_key = d.blob_key
        AND search_blob_chunks_fts MATCH ? AND ${processedResourceProofSql('d.project_id', s.blob, `d.${s.id}`, 'd.blob_key')})`;
      params.push(term);
    }
    where.push(`(${exists})`);
  }
  const filter = (value: string | number | undefined, expression: string) => {
    if (value !== undefined) { where.push(expression); params.push(value); }
  };
  filter(opts.status, `${s.status} = ?`);
  filter(opts.session_id, `${s.session} = ?`);
  filter(opts.observation_type, 'd.observation_type = ?');
  filter(opts.since === undefined ? undefined : opts.since * 1000, `${s.created} >= ?`);
  filter(opts.until === undefined ? undefined : opts.until * 1000, `${s.created} <= ?`);
  if (opts.release_state !== undefined || opts.release_confidence !== undefined) {
    let condition = 'k.project_id = d.project_id AND k.namespace = ? AND k.record_id = d.' + s.id;
    params.push(s.namespace);
    if (opts.release_state !== undefined) { condition += ' AND k.state = ?'; params.push(opts.release_state); }
    if (opts.release_confidence !== undefined) { condition += ' AND k.confidence = ?'; params.push(opts.release_confidence); }
    where.push(`EXISTS (SELECT 1 FROM knowledge_release_state k WHERE ${condition})`);
  }
  // Listed by time, a page after another starts past that page's last match in an order of keys no capture changes: the record's own
  // time, its id, its Project. One row past the page says whether another follows.
  if (listing.by === 'time' && listing.after !== null) {
    const { created_at, id, project_id } = listing.after;
    where.push(`(${s.created} > ? OR (${s.created} = ? AND d.${s.id} > ?) OR (${s.created} = ? AND d.${s.id} = ? AND d.project_id > ?))`);
    params.push(created_at, created_at, id, created_at, id, project_id);
  }
  params.push(listing.by === 'time' ? limit + 1 : limit);
  // The page's snippets: each kept row's best match, matched again by its rowid in the branch that found it.
  const ownSnippet = `(SELECT snippet(${fts}, -1, '', '', ' … ', 40) FROM ${fts} WHERE ${fts} MATCH ? AND ${fts}.rowid = kept.match_rowid)`;
  const blobSnippet = `(SELECT snippet(search_blob_chunks_fts, 0, '', '', ' … ', 40) FROM search_blob_chunks_fts
    WHERE search_blob_chunks_fts MATCH ? AND search_blob_chunks_fts.rowid = kept.match_rowid)`;
  const snippet = s.blob ? `CASE kept.branch WHEN 0 THEN ${ownSnippet} ELSE ${blobSnippet} END` : ownSnippet;
  const preview = s.line === undefined ? snippet : `COALESCE(NULLIF(kept.line, ''), ${snippet})`;
  params.push(terms[0]);
  if (s.blob) params.push(terms[0]);
  // A conversation hit names its turn: the hit's own prompt reference, kept only where the Project's session holds that prompt, and a
  // steering prompt resolved to the turn it steers, as the named-turn read does. Both reads are by primary key.
  const turnColumns = s.turn ? `, tp.prompt_id AS turn_id, substr(tp.text, 1, ${TURN_PREVIEW_CHARS}) AS turn_preview, length(tp.text) AS turn_chars, tp.blob_key IS NOT NULL AS turn_stored` : '';
  const turnJoins = s.turn ? `LEFT JOIN prompt_batches rp ON rp.project_id = kept.project_id AND rp.session_id = kept.session_id AND rp.prompt_id = kept.prompt_id
    LEFT JOIN prompt_batches tp ON tp.project_id = rp.project_id AND tp.session_id = rp.session_id AND tp.prompt_id = COALESCE(rp.parent_prompt_id, rp.prompt_id) AND tp.parent_prompt_id IS NULL` : '';
  const keptOrder = listing.by === 'time' ? 'created_at, id, d.project_id' : 'rank, created_at DESC, id, d.project_id';
  const listedOrder = listing.by === 'time' ? 'kept.created_at, kept.id, kept.project_id' : 'kept.rank, kept.created_at DESC, kept.id, kept.project_id';
  const found = (await db.prepare(`WITH candidates AS MATERIALIZED (${first}${blob}),
    kept AS MATERIALIZED (SELECT d.project_id, d.${s.id} AS id, ${s.title} AS title, MIN(candidates.rank) AS rank,
      candidates.branch, candidates.match_rowid, ${s.line ?? 'NULL'} AS line,
      ${s.created} AS created_at, ${s.session} AS session_id, ${s.prompt} AS prompt_id
    FROM candidates CROSS JOIN ${s.table} d ON d.rowid = candidates.source_rowid
    ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} GROUP BY d.rowid ORDER BY ${keptOrder} LIMIT ?)
    SELECT kept.project_id, kept.id, kept.title, kept.rank, kept.created_at, kept.session_id, kept.prompt_id, (SELECT agent FROM sessions WHERE project_id = kept.project_id AND session_id = kept.session_id) AS agent, ${preview} AS preview${turnColumns}
    FROM kept ${turnJoins} ORDER BY ${listedOrder}`).bind(...params).all<Hit>()).results;
  const more = listing.by === 'time' && found.length > limit;
  const rows = more ? found.slice(0, limit) : found;
  const best = Math.max(...rows.map((r) => Math.abs(r.rank)), Number.MIN_VALUE);
  const tools: Partial<Record<SearchType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans' };
  const tool = tools[type];
  const last = rows.at(-1);
  const hits = rows.filter((r) => r.id.length > 0).map((r): SearchAcrossResult => ({
    projectId: r.project_id, id: r.id, type, title: type === 'session' ? displayPrompt(r.title, r.agent) : r.title, preview: (type === 'session' || type === 'prompt' ? displayPrompt(r.preview ?? '', r.agent) : r.preview ?? '').slice(0, SEARCH_PREVIEW_CHARS), score: Math.abs(r.rank) / best,
    created_at: r.created_at,
    ...(r.session_id === null ? {} : { session_id: r.session_id }),
    ...(r.prompt_id === null ? {} : { prompt_id: r.prompt_id }),
    ...(s.turn ? { turn: turnOf(r) } : {}),
    ...(tool === undefined ? {} : { retrieve: { tool, input: { op: 'get', id: r.id } } }),
  }));
  const cursor = more && last !== undefined ? encodeCursor({ type, created_at: last.created_at, id: last.id, project_id: last.project_id }) : null;
  return { hits, cursor };
}

/** The turn a conversation hit opens, or null when its prompt reference names no top-level prompt of the hit's own session. */
function turnOf(r: Hit): SearchTurn | null {
  if (r.turn_id == null) return null;
  return { prompt_id: r.turn_id, preview: r.turn_preview ?? null, text_chars: r.turn_chars ?? null, stored: r.turn_stored === 1 };
}

/** Each result's release state, one bulk read per namespace present. */
async function withRelease(db: RelationalStore, scope: ReadScope, results: SearchResult[]): Promise<SearchResult[]> {
  const byNamespace = new Map<ReleaseNamespace, string[]>();
  for (const r of results) if (isReleaseNamespace(r.type)) byNamespace.set(r.type, [...(byNamespace.get(r.type) ?? []), r.id]);
  const states = new Map<string, ReleaseAnnotation>();
  for (const [namespace, ids] of byNamespace) {
    for (const [id, row] of Object.entries(await getReleaseStatesForRecords(db, scope, namespace, ids))) {
      states.set(`${namespace}:${id}`, annotation(row));
    }
  }
  return results.map((r) => {
    const release = states.get(`${r.type}:${r.id}`);
    return release === undefined ? r : { ...r, release };
  });
}

const annotation = (row: Awaited<ReturnType<typeof getReleaseStatesForRecords>>[string]): ReleaseAnnotation =>
  ({ state: row.state, confidence: row.confidence, ref: row.basisRef, checked_at: row.checkedAt });

/** Each result's release state across Projects, one batched read per Project and namespace present. */
async function withReleaseAcross(db: RelationalStore, results: SearchAcrossResult[]): Promise<SearchAcrossResult[]> {
  const groups = new Map<string, { projectId: string; namespace: ReleaseNamespace; recordIds: string[] }>();
  const key = (projectId: string, namespace: string) => JSON.stringify([projectId, namespace]);
  for (const r of results) {
    if (!isReleaseNamespace(r.type)) continue;
    const group = groups.get(key(r.projectId, r.type)) ?? { projectId: r.projectId, namespace: r.type, recordIds: [] };
    group.recordIds.push(r.id);
    groups.set(key(r.projectId, r.type), group);
  }
  const wanted = [...groups.values()];
  const answers = await getReleaseStatesAcross(db, wanted);
  const states = new Map<string, ReleaseAnnotation>();
  wanted.forEach((w, i) => { for (const [id, row] of Object.entries(answers[i] ?? {})) states.set(JSON.stringify([w.projectId, w.namespace, id]), annotation(row)); });
  return results.map((r) => {
    const release = states.get(JSON.stringify([r.projectId, r.type, r.id]));
    return release === undefined ? r : { ...r, release };
  });
}

/** One scoped search implementation for HTTP and MCP. An unavailable semantic provider is explicit. */
export async function searchProject(db: RelationalStore, scope: ReadScope, opts: SearchOptions, resolveSemantic?: () => Promise<SemanticSearch | null>): Promise<SearchAnswer> {
  const answer = await searchUnannotated(db, scope, opts, resolveSemantic);
  return { ...answer, results: await withRelease(db, scope, answer.results) };
}

/**
 * Full-text search across a set of Projects: every Project that accepts capture, or the ones named. Each type is one
 * statement over the whole set, ranked by the same full-text rank a Project's search uses; the index's statistics span
 * every Project, so ranks compare across them. Semantic search reads one Project's vectors, so `mode` here is `auto`
 * or `fts`, and the answer is always full text.
 */
export async function searchAcross(db: RelationalStore, set: ProjectSet, opts: SearchOptions): Promise<SearchAcrossAnswer> {
  const { words, types, mode, limit, listing } = validated(opts);
  if (mode === 'semantic') throw new InvalidSearch('semantic search reads one project; across projects, mode must be auto or fts');
  const { results, cursor } = await fullText(db, set, types, words, opts, limit, listing);
  return { results: await withReleaseAcross(db, results), mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: await pendingSearchBlobs(db, set) }, cursor };
}

function validated(opts: SearchOptions): { query: string; words: string[]; types: readonly SearchType[]; mode: string; limit: number; listing: Listing } {
  const query = opts.query.trim();
  if (query.length === 0 || query.length > SEARCH_QUERY_MAX_CHARS) throw new InvalidSearch(`query must contain 1–${SEARCH_QUERY_MAX_CHARS} characters`);
  if (CONTROL_CHARACTERS.test(query)) throw new InvalidSearch('query must not contain control characters');
  const words = query.split(/\s+/);
  if (words.length > SEARCH_MAX_TERMS) throw new InvalidSearch(`query may contain at most ${SEARCH_MAX_TERMS} terms`);
  const types = typesFor(opts.type);
  const mode = opts.mode ?? 'auto';
  if (!['auto', 'fts', 'semantic'].includes(mode)) throw new InvalidSearch('mode must be auto, fts or semantic');
  const limit = opts.limit ?? SEARCH_API_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) throw new InvalidSearch(`limit must be between 1 and ${SEARCH_MAX_LIMIT}`);
  for (const value of [opts.since, opts.until]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new InvalidSearch('timestamps must be non-negative epoch seconds');
  if (opts.since !== undefined && opts.until !== undefined && opts.since > opts.until) throw new InvalidSearch('since must not exceed until');
  const order = opts.order ?? 'relevance';
  if (order !== 'relevance' && order !== 'time') throw new InvalidSearch('order must be relevance or time');
  if (order === 'relevance') {
    if (opts.cursor !== undefined) throw new InvalidSearch('a cursor continues a search ordered by time; send order=time');
    return { query, words, types, mode, limit, listing: { by: 'relevance' } };
  }
  // Only a search by time pages: its order rests on keys no capture changes, so a page after another never loses or repeats a match.
  const [only, ...others] = types;
  if (only === undefined || others.length > 0) throw new InvalidSearch('order=time lists the matches of one type; name it with type');
  if (only === 'session') throw new InvalidSearch('order=time does not apply to sessions');
  if (mode === 'semantic') throw new InvalidSearch('order=time lists full-text matches; mode must be auto or fts');
  return { query, words, types, mode, limit, listing: { by: 'time', after: opts.cursor === undefined ? null : decodeCursor(opts.cursor, only) } };
}

/**
 * Each type's best hits, one statement per type, merged: every type's best first, then the rest by score, to the limit. Listed by
 * time, one type's matches oldest first, each page naming the cursor of the matches after it.
 */
async function fullText(db: RelationalStore, reach: SearchReach, types: readonly SearchType[], words: string[], opts: SearchOptions, limit: number, listing: Listing): Promise<{ results: SearchAcrossResult[]; cursor: string | null }> {
  const terms = words.map(sanitizeFtsQuery);
  if (listing.by === 'time') {
    const { hits, cursor } = await searchType(db, reach, types[0]!, terms, opts, limit, listing);
    return { results: hits, cursor };
  }
  const branches = (await Promise.all(types.map((type) => searchType(db, reach, type, terms, opts, limit, listing)))).map((branch) => branch.hits);
  const order = (a: SearchAcrossResult, b: SearchAcrossResult) => b.score - a.score || SEARCH_TYPES.indexOf(a.type) - SEARCH_TYPES.indexOf(b.type) || a.id.localeCompare(b.id) || a.projectId.localeCompare(b.projectId);
  const floor = branches.flatMap((hits) => hits.slice(0, 1)).sort(order).slice(0, limit);
  const remaining = branches.flatMap((hits) => hits.slice(1)).sort(order).slice(0, limit - floor.length);
  return { results: [...floor, ...remaining].sort(order), cursor: null };
}

async function searchUnannotated(db: RelationalStore, scope: ReadScope, opts: SearchOptions, resolveSemantic?: () => Promise<SemanticSearch | null>): Promise<SearchAnswer> {
  const { query, words, types, mode, limit, listing } = validated(opts);
  const coverage = { pending_blobs: await pendingSearchBlobs(db, scope.projectId) };
  if (mode !== 'fts' && listing.by === 'relevance') {
    const semantic = await resolveSemantic?.();
    if (semantic != null) {
      try {
        return { results: await semanticSearch(db, scope, semantic, types, { ...opts, query }, limit), mode: 'semantic', provider_unavailable: false, coverage, cursor: null };
      } catch (error) { if (!(error instanceof EmbeddingUnavailable)) throw error; }
    }
  }
  if (mode === 'semantic') return { results: [], mode, provider_unavailable: true, coverage, cursor: null };
  const found = await fullText(db, scope, types, words, opts, limit, listing);
  const results = found.results.map(({ projectId: _projectId, ...result }) => result);
  return { results, mode: 'fts', provider_unavailable: mode === 'auto' && listing.by === 'relevance', coverage, cursor: found.cursor };
}
