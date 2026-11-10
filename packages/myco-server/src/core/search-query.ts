import {
  SEARCH_API_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MAX_TERMS, SEARCH_QUERY_MAX_CHARS, SEARCH_STOPWORDS, SEARCH_TYPES, SEARCH_WINDOW,
  type SearchOptions, type SearchType,
} from '@goondocks/myco-shared/search-types';
import { DOC_IDS_PER_SECOND } from '../db/search/documents-schema.js';

/**
 * What a search asks, checked once: its words, the kinds and filters it covers, how it matches and orders, and the
 * page it continues. Every refusal names what to send instead.
 */
export class SearchRefused extends Error {
  constructor(readonly code: 'invalid_query' | 'stopwords_only' | 'cursor_expired' | 'cursor_foreign', message: string) { super(message); }
}

/** The kinds a search's documents carry: a plan body stored apart is indexed as `chunk` documents of its blob. */
export type DocumentKind = 'session' | 'spore' | 'plan' | 'chunk' | 'card';

export interface SearchFilters {
  status?: string; session_id?: string; observation_type?: string; agent?: string; branch?: string;
  release_state?: string; release_confidence?: string; since?: number; until?: number;
}

export interface SearchRequest {
  /** Each word as a full-text phrase, stopwords removed. */
  terms: string[];
  /** The words as typed, lowercased, for cutting snippets. */
  words: string[];
  types: SearchType[];
  mode: 'auto' | 'fts' | 'semantic';
  match: 'all' | 'any';
  order: 'relevance' | 'time';
  limit: number;
  filters: SearchFilters;
  cursor: string | null;
  /** The newest matches one ranking reads, shared among the kinds; `SEARCH_WINDOW` unless a caller inside the server asks for fewer. */
  window: number;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const STOPWORDS = new Set(SEARCH_STOPWORDS);
const MODES = ['auto', 'fts', 'semantic'] as const;

const invalid = (message: string) => new SearchRefused('invalid_query', message);

/** The full-text phrase one typed word searches for: its letters and digits, quoted, so punctuation and operators are literal. */
const phrase = (word: string) => `"${word.replace(/"/g, '""')}"`;

export function searchRequest(options: SearchOptions): SearchRequest {
  const query = (options.query ?? '').trim();
  if (query.length === 0 || query.length > SEARCH_QUERY_MAX_CHARS) throw invalid(`query has ${query.length} characters; send 1–${SEARCH_QUERY_MAX_CHARS}`);
  if (CONTROL_CHARACTERS.test(query)) throw invalid('query must not contain control characters; send the words alone');
  const typed = query.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const kept = typed.filter((word) => !STOPWORDS.has(word.toLowerCase()));
  if (kept.length === 0) {
    throw new SearchRefused('stopwords_only', `query "${query}" holds only common words a search ignores (${SEARCH_STOPWORDS.slice(0, 6).join(', ')}, …); send a word naming what the record is about`);
  }
  if (kept.length > SEARCH_MAX_TERMS) throw invalid(`query has ${kept.length} words after ignoring common ones; at most ${SEARCH_MAX_TERMS} are searched: send at most ${SEARCH_MAX_TERMS}`);
  const types = typesOf(options.type);
  const mode = (options.mode ?? 'auto') as SearchRequest['mode'];
  if (!MODES.includes(mode)) throw invalid(`mode "${options.mode}" is not one of auto, fts or semantic`);
  const match = options.match ?? 'all';
  if (match !== 'all' && match !== 'any') throw invalid(`match "${match}" is not all or any`);
  const order = options.order ?? 'relevance';
  if (order !== 'relevance' && order !== 'time') throw invalid(`order "${order}" is not relevance or time`);
  const limit = options.limit ?? SEARCH_API_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) throw invalid(`limit ${limit} is outside 1–${SEARCH_MAX_LIMIT}; send a limit in that range`);
  for (const value of [options.since, options.until]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw invalid('since and until are non-negative epoch seconds');
  }
  if (options.since !== undefined && options.until !== undefined && options.since > options.until) throw invalid('since must not exceed until');
  if (order === 'time') {
    const [only, ...others] = types;
    if (only === undefined || others.length > 0) throw invalid('order=time lists the matches of one type; name it with type (spore, plan or card)');
    if (only === 'session') throw invalid('order=time does not apply to sessions, whose time moves when their transcript is read; use type spore, plan or card');
    if (mode === 'semantic') throw invalid('order=time lists word matches; send mode auto or fts');
  }
  const filters: SearchFilters = {};
  for (const key of ['status', 'session_id', 'observation_type', 'agent', 'branch', 'release_state', 'release_confidence'] as const) {
    if (options[key] !== undefined && options[key] !== '') filters[key] = options[key];
  }
  if (options.since !== undefined) filters.since = options.since;
  if (options.until !== undefined) filters.until = options.until;
  return {
    terms: kept.map(phrase), words: kept.map((word) => word.toLowerCase()), types, mode, match, order, limit, filters,
    cursor: options.cursor === undefined || options.cursor === '' ? null : options.cursor, window: SEARCH_WINDOW,
  };
}

function typesOf(value: string | undefined): SearchType[] {
  if (value === undefined || value === '' || value === 'all') return [...SEARCH_TYPES];
  if ((SEARCH_TYPES as readonly string[]).includes(value)) return [value as SearchType];
  if (value === 'prompt' || value === 'response' || value === 'prompts' || value === 'responses' || value === 'prompt_batches') {
    throw invalid(`type "${value}" is now "card": a conversation's turns are searched as cards; send type card`);
  }
  throw invalid(`type "${value}" is not one of ${SEARCH_TYPES.join(', ')} or all`);
}

/** The document kinds a request reads, each with the facets that bound its window; a kind no filter can match is left out. */
export function documentKinds(request: SearchRequest): DocumentKind[] {
  const { filters } = request;
  return request.types.flatMap((type): DocumentKind[] => {
    if (filters.observation_type !== undefined && type !== 'spore') return [];
    if (filters.status !== undefined && type === 'card') return [];
    return type === 'plan' ? ['plan', 'chunk'] : [type];
  });
}

const hex = (value: string) => [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * The full-text expression of one kind's window: the reach's Projects, the kind, and every filter the kind carries as a
 * token, then the words in the record's own text.
 */
export function windowExpression(kind: DocumentKind, projects: readonly string[], request: SearchRequest, terms: readonly string[] = request.terms): string {
  const { filters } = request;
  const parts = [`facets:(${projects.map((project) => `p${hex(project)}`).join(' OR ')})`, `facets:k${kind}`];
  if (filters.session_id !== undefined && kind !== 'chunk') parts.push(`facets:s${hex(filters.session_id)}`);
  if (filters.status !== undefined && (kind === 'plan' || kind === 'spore')) parts.push(`facets:st${hex(filters.status)}`);
  if (filters.observation_type !== undefined && kind === 'spore') parts.push(`facets:ty${hex(filters.observation_type)}`);
  parts.push(`{headline body}:(${terms.join(request.match === 'all' ? ' AND ' : ' OR ')})`);
  return parts.join(' AND ');
}

/** One word's presence in a record's headline, or anywhere in its text. */
export const headlineExpression = (term: string) => `headline:(${term})`;
export const textExpression = (term: string) => `{headline body}:(${term})`;

/** The `doc_id` range `since` and `until` (epoch seconds) cover: a document's id orders it by its record's second. */
export function docIdRange(filters: SearchFilters): { low: number; high: number } {
  return {
    low: filters.since === undefined ? 0 : Math.floor(filters.since) * DOC_IDS_PER_SECOND,
    high: filters.until === undefined ? Number.MAX_SAFE_INTEGER : (Math.floor(filters.until) + 1) * DOC_IDS_PER_SECOND - 1,
  };
}

/** The start of the record second a `doc_id` orders by, in epoch milliseconds. */
export const recordMs = (docId: number) => Math.floor(docId / DOC_IDS_PER_SECOND) * 1000;

/** The query, filters and reach a cursor belongs to, as a short digest: a cursor from another search is refused. */
export function searchBinding(reach: string, request: SearchRequest): string {
  const text = JSON.stringify([reach, request.types, request.terms, request.match, request.order, request.filters]);
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

/** A safe integer and its separator, written out. */
const ID_CHARS = String(Number.MAX_SAFE_INTEGER).length + 1;
/**
 * The longest cursor this search writes, base64url: a ranking cursor names at most a page of listed ids (one hit each at
 * most), one fence per kind, its position and its binding.
 */
const CURSOR_MAX_CHARS = Math.ceil(((SEARCH_MAX_LIMIT + 8) * ID_CHARS + 256) * 4 / 3);

/** Where a page ends: after a document listed by time, after page one of a ranking, or at a place in a stored ranking. */
export type SearchCursor =
  | { o: 't'; b: string; a: number }
  | { o: 'r'; b: string; at: number; f: Partial<Record<DocumentKind, number>>; n: number; l: number[] }
  | { o: 'w'; b: string; s: string; r: number; n: number };

export function encodeCursor(cursor: SearchCursor): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const foreign = () => new SearchRefused('cursor_foreign', 'cursor is not one this search returned: send the nextCursor of the previous page of the same search, or none for the first page');

export function decodeCursor(value: string, binding: string): SearchCursor {
  if (value.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) throw foreign();
  let parsed: unknown;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw foreign(); }
  const c = parsed as Record<string, unknown>;
  if (typeof c !== 'object' || c === null || c.b !== binding) throw foreign();
  const ids = (value: unknown) => Array.isArray(value) && value.every((id) => Number.isSafeInteger(id));
  if (c.o === 't' && Number.isSafeInteger(c.a)) return { o: 't', b: binding, a: c.a as number };
  if (c.o === 'r' && Number.isSafeInteger(c.at) && typeof c.f === 'object' && c.f !== null && ids(c.l) && (c.l as number[]).length <= SEARCH_MAX_LIMIT
    && Number.isSafeInteger(c.n) && (c.n as number) >= 0 && Object.values(c.f).every((id) => Number.isSafeInteger(id))) {
    return { o: 'r', b: binding, at: c.at as number, f: c.f as Partial<Record<DocumentKind, number>>, n: c.n as number, l: c.l as number[] };
  }
  if (c.o === 'w' && typeof c.s === 'string' && Number.isSafeInteger(c.r) && Number.isSafeInteger(c.n)) return { o: 'w', b: binding, s: c.s, r: c.r as number, n: c.n as number };
  throw foreign();
}
