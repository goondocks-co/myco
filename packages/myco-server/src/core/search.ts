import {
  SEARCH_STOPWORDS, SEARCH_WINDOW, SEARCH_WINDOW_TTL_MS, type SearchAcrossAnswer, type SearchAcrossResult, type SearchAnswer, type SearchCoverage, type SearchOptions,
} from '@goondocks/myco-shared/search-types';
import type { ServerEnv } from './adapters.js';
import type { ProjectSet, ReadScope } from '../read/scope.js';
import { embedding_semanticSearch as semanticSearch, type embedding_SemanticSearch as SemanticSearch } from '../read/catalog/embedding.js';
import { EmbeddingUnavailable } from './embedding/provider.js';
import { pendingSearchBlobs } from '../db/search/blob-index.js';
import { plansOfDocuments, reachProjects, readWindows, searchIndexReadiness } from '../db/search/documents.js';
import { heldWindow, storeWindow } from '../db/search/result-windows.js';
import {
  decodeCursor, docIdRange, documentKinds, encodeCursor, recordMs, searchBinding, searchRequest, SearchRefused, windowExpression,
  type DocumentKind, type SearchCursor, type SearchRequest,
} from './search-query.js';
import { matchingPlanDocuments, rankWindow, type KindWindow, type RankedEntry, type RankedWindow } from './search-ranking.js';
import { pageOfHits, SEARCH_PAGE_BATCH, type PageInput } from './search-hits.js';

/**
 * The one search operation, for HTTP, MCP, curation and near-match. A relevance search ranks the newest matches of each
 * kind (`search-ranking.ts`); its first page stores nothing and its cursor names the window it read, so the first
 * continuation re-reads that window, stores it once, and later pages read the stored ranking by place. When a stored
 * ranking runs out and older matches remain, the next page ranks the next older window. A search by time lists one
 * type's matches oldest first. No answer counts its matches.
 */

export async function resolveSemanticSearch(env: ServerEnv): Promise<SemanticSearch | null> {
  if (env.vectors === undefined) return null;
  const provider = await env.embeddingProvider?.();
  return provider == null ? null : { provider, vectors: env.vectors };
}

/** Who continues a search: a stored ranking answers only the reader that stored it. */
type SearchReader = string;

/** One Project's search: words, or meaning where the Deployment has a provider and the request allows it. */
export async function searchDeployment(env: ServerEnv, scope: ReadScope, options: SearchOptions, reader: SearchReader, now = Date.now()): Promise<SearchAnswer> {
  const request = searchRequest(options);
  const coverage = await coverageOf(env, scope.projectId);
  if (request.mode !== 'fts' && request.order === 'relevance' && request.cursor === null && request.match === 'all') {
    const semantic = await resolveSemanticSearch(env);
    if (semantic !== null) {
      try {
        const hits = await semanticSearch(env.db, scope, semantic, request.types, { ...options, query: options.query.trim() }, request.limit);
        return { hits, mode: 'semantic', provider_unavailable: false, coverage, partial: false, asOf: now, nextCursor: null };
      } catch (error) { if (!(error instanceof EmbeddingUnavailable)) throw error; }
    }
    if (request.mode === 'semantic') return { hits: [], mode: 'semantic', provider_unavailable: true, coverage, partial: false, asOf: now, nextCursor: null };
  }
  const answer = await wordSearch({ env, projects: [scope.projectId], reach: `project:${scope.projectId}`, request, reader, now, coverage });
  return {
    ...answer, hits: answer.hits.map(({ projectId: _projectId, ...hit }) => hit), mode: 'fts',
    provider_unavailable: request.mode === 'auto' && request.order === 'relevance' && request.cursor === null && request.match === 'all',
  };
}

/** A search across Projects: every Project accepting capture, or the ones named; always words alone. */
export async function searchAcross(env: ServerEnv, set: ProjectSet, options: SearchOptions, reader: SearchReader, now = Date.now()): Promise<SearchAcrossAnswer> {
  const request = searchRequest(options);
  if (request.mode === 'semantic') throw new SearchRefused('invalid_query', 'semantic search reads one project; across projects send mode auto or fts');
  const projects = await reachProjects(env.db, set.all ? null : set.projectIds);
  const answer = await wordSearch({ env, projects, reach: set.all ? 'all' : `named:${[...set.projectIds].sort().join(',')}`, request, reader, now, coverage: await coverageOf(env, set) });
  return { ...answer, mode: 'fts', provider_unavailable: false };
}

async function coverageOf(env: ServerEnv, reach: string | ProjectSet): Promise<SearchCoverage> {
  const [state, pendingBlobs] = await Promise.all([searchIndexReadiness(env.db), pendingSearchBlobs(env.db, reach)]);
  return { state, pendingBlobs, horizon: null };
}

type WordAnswer = Omit<SearchAcrossAnswer, 'mode' | 'provider_unavailable'>;

/** One word search: where it reads, what it asks, who asks, and what the answer reports covered. */
interface WordSearch {
  env: ServerEnv; projects: readonly string[]; reach: string; request: SearchRequest; reader: SearchReader; now: number; coverage: SearchCoverage;
}

/** A word search with the binding its cursors carry and the page input its rankings feed. */
interface Walk extends WordSearch { binding: string; input: (scores: ReadonlyMap<number, number> | null) => PageInput }

async function wordSearch(search: WordSearch): Promise<WordAnswer> {
  const { env, projects, request, reader, now, coverage } = search;
  const kinds = documentKinds(request);
  const empty: WordAnswer = { hits: [], coverage, partial: false, asOf: now, nextCursor: null };
  const binding = searchBinding(search.reach, request);
  const cursor = request.cursor === null ? null : decodeCursor(request.cursor, binding);
  if (kinds.length === 0 || projects.length === 0) return empty;
  const walk: Walk = { ...search, binding, input: (scores) => ({ db: env.db, projects, request, scores }) };
  const input = walk.input;
  if (request.order === 'time') return timePage(walk, kinds, cursor?.o === 't' ? cursor.a : null);
  if (cursor?.o === 't') throw new SearchRefused('cursor_foreign', 'cursor belongs to a search by time: send it with order=time, or send none for the first page');
  if (cursor === null) {
    const { high } = docIdRange(request.filters);
    const window = await rankWindow(env.db, projects, request, Object.fromEntries(kinds.map((kind) => [kind, high])));
    const page = await pageOfHits(input(window.scores), window.entries, 0);
    const more = page.next < window.entries.length || anyPartial(window.kinds);
    // The cursor names the window (its fences) and the place the page stopped, and the documents it listed, so a
    // re-read of the window that moved repeats none of them.
    const listed = window.entries.slice(0, page.next).filter((entry) => page.listed.has(entry.id)).map((entry) => entry.id);
    return answerOf(page.hits, window.kinds, now, coverage, more ? encodeCursor({ o: 'r', b: binding, at: now, f: window.fences, n: page.next, l: listed }) : null);
  }
  if (cursor.o === 'r') {
    const window = await rankWindow(env.db, projects, request, cursor.f);
    const listed = new Set(cursor.l);
    const start = cursor.n - window.entries.slice(0, cursor.n).filter((entry) => listed.has(entry.id)).length;
    const entries = window.entries.filter((entry) => !listed.has(entry.id));
    const state: WindowState = { search_id: crypto.randomUUID(), round: 0, asof: now, entries, kinds: window.kinds, scores: window.scores };
    // A first page that examined its whole window goes straight to the next older one.
    return start < entries.length ? continueWindow(walk, state, Math.max(0, start)) : olderWindow(walk, state);
  }
  if (cursor.o !== 'w') throw new SearchRefused('cursor_foreign', 'cursor is not one this search returned: send none for the first page');
  const held = await heldWindow(env.db, cursor.s, now);
  const expired = new SearchRefused('cursor_expired', `this search's later pages expired (they last ${SEARCH_WINDOW_TTL_MS / 60_000} minutes after the second page): request the first page again, with no cursor, to start over`);
  if (held === null || held.round !== cursor.r) throw expired;
  if (held.reader !== reader || held.binding !== binding) throw new SearchRefused('cursor_foreign', 'cursor belongs to another reader or search: request the first page again without a cursor');
  const stored = JSON.parse(held.hits) as [number, number, string[]?][];
  const kindsHeld = JSON.parse(held.kinds) as Partial<Record<DocumentKind, KindWindow>>;
  if (cursor.n < stored.length) {
    const entries = stored.map(([id, , plans]): RankedEntry => (plans === undefined ? { id } : { id, plans }));
    return continueWindow(walk, { search_id: held.search_id, round: held.round, asof: Number(held.asof), entries, kinds: kindsHeld,
      scores: new Map(stored.map(([id, score]) => [id, score])), stored: true }, cursor.n);
  }
  return olderWindow(walk, { search_id: held.search_id, round: held.round, asof: Number(held.asof), entries: [], kinds: kindsHeld, scores: new Map(), stored: true });
}

/** The first page of the window below `state`'s partial kinds, or no more when none is partial. */
async function olderWindow(walk: Walk, state: WindowState): Promise<WordAnswer> {
  const { env, projects, request, now, coverage } = walk;
  const older = Object.fromEntries(Object.entries(state.kinds).filter(([, kind]) => kind!.partial).map(([name, kind]) => [name, kind!.low - 1]));
  if (Object.keys(older).length === 0) return { hits: [], coverage, partial: false, asOf: state.asof, nextCursor: null };
  const window: RankedWindow = await rankWindow(env.db, projects, request, older, true);
  // A ranking already stored under this search is replaced by the next round; a new one starts at round 0.
  const round = state.stored === true ? state.round + 1 : state.round;
  return continueWindow(walk, { search_id: state.search_id, round, asof: now, entries: window.entries, kinds: window.kinds, scores: window.scores }, 0);
}

const anyPartial = (kinds: Partial<Record<DocumentKind, KindWindow>>) => Object.values(kinds).some((kind) => kind!.partial);

function answerOf(hits: SearchAcrossResult[], kinds: Partial<Record<DocumentKind, KindWindow>>, asOf: number, coverage: SearchCoverage, nextCursor: string | null): WordAnswer {
  const partial = anyPartial(kinds);
  const lows = Object.values(kinds).filter((kind) => kind!.partial).map((kind) => recordMs(kind!.low));
  return { hits, coverage: { ...coverage, horizon: partial ? Math.min(...lows) : null }, partial, asOf, nextCursor };
}

interface WindowState {
  search_id: string; round: number; asof: number; entries: RankedEntry[]; kinds: Partial<Record<DocumentKind, KindWindow>>;
  scores: ReadonlyMap<number, number>; stored?: true;
}

/** A page of a ranking from `from`; a ranking not yet stored is stored once when a page follows it. */
async function continueWindow(walk: Walk, state: WindowState, from: number): Promise<WordAnswer> {
  const { env, reader, binding, now, coverage } = walk;
  const page = await pageOfHits(walk.input(state.scores), state.entries, from);
  const more = page.next < state.entries.length || anyPartial(state.kinds);
  if (more && state.stored !== true) {
    await storeWindow(env.db, {
      search_id: state.search_id, reader, binding, asof: state.asof, expires_at: now + SEARCH_WINDOW_TTL_MS, round: state.round,
      kinds: JSON.stringify(state.kinds),
      hits: JSON.stringify(state.entries.map((entry) => [entry.id, state.scores.get(entry.id) ?? 0, ...(entry.plans === undefined ? [] : [entry.plans])])),
    }, now);
  }
  return answerOf(page.hits, state.kinds, state.asof, coverage,
    more ? encodeCursor({ o: 'w', b: binding, s: state.search_id, r: state.round, n: page.next }) : null);
}

/** One type's matches oldest first, after the last one listed: each page a bounded walk upward by `doc_id`. */
async function timePage(walk: Walk, kinds: readonly DocumentKind[], after: number | null): Promise<WordAnswer> {
  const { env, projects, request, binding, now, coverage } = walk;
  const input = walk.input(null);
  const range = docIdRange(request.filters);
  let low = after === null ? range.low : after + 1;
  const hits: SearchAcrossResult[] = [];
  let examined = 0;
  let more = false;
  let last = after;
  const step = Math.max(request.limit + 1, SEARCH_PAGE_BATCH);
  while (hits.length < request.limit && examined < SEARCH_WINDOW) {
    const found = (await readWindows(env.db, kinds.map((kind) => ({ match: windowExpression(kind, projects, request), low, high: range.high, limit: step, direction: 'oldest' as const })))).windows;
    const full = found.filter((ids) => ids.length === step);
    const cut = full.length === 0 ? Infinity : Math.min(...full.map((ids) => ids.at(-1)!));
    const ids = found.flat().filter((id) => id < cut || full.length === 0).sort((a, b) => a - b);
    if (ids.length === 0) { more = false; break; }
    const entries = await oldestOwners(walk, kinds, ids);
    const page = await pageOfHits({ ...input, request: { ...request, limit: request.limit - hits.length } }, entries, 0);
    hits.push(...page.hits);
    examined += page.next;
    // Documents between listed entries own no plan, so the walk stands after the last entry examined, or after the batch.
    last = page.next < entries.length ? entries[page.next - 1]?.id ?? last : ids.at(-1)!;
    more = page.next < entries.length || full.length > 0;
    if (!more || page.next < entries.length) break;
    low = last! + 1;
  }
  more ||= examined >= SEARCH_WINDOW;
  return { hits, coverage, partial: false, asOf: now, nextCursor: more && last !== null ? encodeCursor({ o: 't', b: binding, a: last }) : null };
}

/**
 * Time-ordered `ids` as entries: a plan is listed once, at the oldest of its documents (its own or a chunk of its body)
 * that matches.
 */
async function oldestOwners(walk: Walk, kinds: readonly DocumentKind[], ids: readonly number[]): Promise<RankedEntry[]> {
  if (!kinds.includes('plan') && !kinds.includes('chunk')) return ids.map((id) => ({ id }));
  const plans = await plansOfDocuments(walk.env.db, ids);
  const matching = await matchingPlanDocuments(walk.env.db, walk.projects, walk.request, [...new Set([...plans.values()].flat())]);
  const oldest = new Map([...matching].map(([plan, docs]) => [plan, Math.min(...docs.map((doc) => doc.doc_id))]));
  return ids.flatMap((id) => {
    const owned = (plans.get(id) ?? []).filter((plan) => oldest.get(plan) === id);
    return owned.length === 0 ? [] : [{ id, plans: owned }];
  });
}

/**
 * The active spores of one Project sharing the most of `words`, among its newest `window` matches of any of them: one
 * bounded ranking, no stored window.
 */
export async function sporesSharingWords(env: ServerEnv, scope: ReadScope, words: readonly string[], options: { limit: number; window: number; now?: number }): Promise<string[]> {
  const kept = words.filter((word) => !SEARCH_STOPWORDS.includes(word));
  if (kept.length === 0) return [];
  const request = { ...searchRequest({ query: kept.join(' '), type: 'spore', status: 'active', match: 'any', mode: 'fts', limit: options.limit }), window: options.window };
  const answer = await wordSearch({ env, projects: [scope.projectId], reach: `project:${scope.projectId}`, request, reader: 'near-match',
    now: options.now ?? Date.now(), coverage: { state: 'ready', pendingBlobs: 0, horizon: null } });
  return answer.hits.map((hit) => hit.id);
}
