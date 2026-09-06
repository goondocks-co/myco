import type { RelationalStore } from '../core/adapters.js';
import { pendingSearchBlobs, SEARCH_QUERY_MAX_CHARS } from '../core/search-index.js';
import type { ReadScope } from './scope.js';
import { semanticSearch, type SemanticSearch } from './embedding.js';
import { EmbeddingUnavailable } from '../core/embedding/provider.js';

import { SEARCH_TYPES, SEARCH_API_LIMIT, SEARCH_MAX_LIMIT, SEARCH_PREVIEW_CHARS, type SearchType, type SearchOptions, type SearchResult, type SearchAnswer } from './search-types.js';
export * from './search-types.js';
const SEARCH_MAX_TERMS = 16;

export class InvalidSearch extends Error {}

/** Punctuation and FTS operators are literal search terms. */
export function sanitizeFtsQuery(query: string): string {
  return query.split(/\s+/).filter((tok) => tok.length > 0)
    .map((tok) => /^[\w]+$/.test(tok) && !/^(AND|OR|NOT|NEAR)$/.test(tok) ? tok : `"${tok.replace(/"/g, '""')}"`).join(' ');
}

interface Source {
  table: string; id: string; title: string; created: string; session: string; prompt: string;
  status?: string; blob?: boolean; namespace: string;
}
const SOURCES: Record<SearchType, Source> = {
  session: { table: 'sessions', id: 'session_id', title: "COALESCE(NULLIF(d.title, ''), 'Session ' || substr(d.session_id, -6))", created: 'COALESCE(d.started_at, d.first_received_at)', session: 'd.session_id', prompt: 'NULL', status: "CASE WHEN d.ended_at IS NULL THEN 'active' ELSE 'completed' END", namespace: 'sessions' },
  spore: { table: 'spores', id: 'id', title: 'd.observation_type', created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', status: 'd.status', namespace: 'spores' },
  plan: { table: 'plans', id: 'plan_key', title: "COALESCE(NULLIF(d.title, ''), 'Plan')", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', status: 'd.status', blob: true, namespace: 'plans' },
  skill: { table: 'skill_records', id: 'id', title: "COALESCE(NULLIF(d.display_name, ''), d.name)", created: 'd.created_at', session: 'NULL', prompt: 'NULL', status: 'd.status', namespace: 'skill_records' },
  prompt: { table: 'prompt_batches', id: 'prompt_id', title: "'Prompt'", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', blob: true, namespace: 'prompt_batches' },
  response: { table: 'responses', id: 'response_id', title: "'Response'", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', blob: true, namespace: 'responses' },
};

const ALIASES: Record<string, SearchType> = {
  sessions: 'session', spores: 'spore', plans: 'plan', skills: 'skill', skill_records: 'skill',
  prompts: 'prompt', prompt_batches: 'prompt', responses: 'response',
};

function typesFor(value: string | undefined): readonly SearchType[] {
  if (value === undefined || value === 'all') return SEARCH_TYPES;
  const type = ALIASES[value] ?? value;
  if (!SEARCH_TYPES.includes(type as SearchType)) throw new InvalidSearch(`unsupported search type: ${value}`);
  return [type as SearchType];
}

interface Hit { id: string; title: string; preview: string; rank: number; created_at: number; session_id: string | null; prompt_id: string | null }

async function searchType(db: RelationalStore, scope: ReadScope, type: SearchType, terms: string[], opts: SearchOptions, limit: number): Promise<SearchResult[]> {
  const s = SOURCES[type];
  if ((opts.status !== undefined && s.status === undefined) || (opts.observation_type !== undefined && type !== 'spore')) return [];
  if (opts.session_id !== undefined && s.session === 'NULL') return [];
  const fts = `${s.table}_fts`;
  const params: (string | number)[] = [terms[0], scope.projectId];
  const first = `SELECT d.rowid AS source_rowid, ${fts}.rank AS rank,
    snippet(${fts}, -1, '', '', ' … ', 40) AS preview
    FROM ${fts} JOIN ${s.table} d ON d.rowid = ${fts}.rowid
    WHERE ${fts} MATCH ? AND d.project_id = ?`;
  const blob = s.blob ? ` UNION ALL SELECT d.rowid AS source_rowid, search_blob_chunks_fts.rank AS rank,
    snippet(search_blob_chunks_fts, 0, '', '', ' … ', 40) AS preview
    FROM search_blob_chunks_fts JOIN search_blob_chunks c ON c.rowid = search_blob_chunks_fts.rowid
    JOIN ${s.table} d ON d.project_id = c.project_id AND d.blob_key = c.blob_key
    WHERE search_blob_chunks_fts MATCH ? AND d.project_id = ?` : '';
  if (s.blob) params.push(terms[0], scope.projectId);
  const where = ['d.project_id = ?'];
  params.push(scope.projectId);
  for (const term of terms.slice(1)) {
    let exists = `EXISTS (SELECT 1 FROM ${fts} WHERE ${fts}.rowid = d.rowid AND ${fts} MATCH ?)`;
    params.push(term);
    if (s.blob) {
      exists += ` OR EXISTS (SELECT 1 FROM search_blob_chunks_fts JOIN search_blob_chunks c
        ON c.rowid = search_blob_chunks_fts.rowid WHERE c.project_id = d.project_id AND c.blob_key = d.blob_key
        AND search_blob_chunks_fts MATCH ?)`;
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
  params.push(limit);
  const rows = (await db.prepare(`WITH candidates AS MATERIALIZED (${first}${blob})
    SELECT d.${s.id} AS id, ${s.title} AS title, candidates.preview, MIN(candidates.rank) AS rank,
      ${s.created} AS created_at, ${s.session} AS session_id, ${s.prompt} AS prompt_id
    FROM candidates JOIN ${s.table} d ON d.rowid = candidates.source_rowid
    WHERE ${where.join(' AND ')} GROUP BY d.rowid ORDER BY rank, created_at DESC, id LIMIT ?`).bind(...params).all<Hit>()).results;
  const best = Math.max(...rows.map((r) => Math.abs(r.rank)), Number.MIN_VALUE);
  const tools: Partial<Record<SearchType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans', skill: 'myco_skills' };
  return rows.filter((r) => r.id.length > 0).map((r) => ({
    id: r.id, type, title: r.title, preview: (r.preview ?? '').slice(0, SEARCH_PREVIEW_CHARS), score: Math.abs(r.rank) / best,
    ...(r.session_id === null ? {} : { session_id: r.session_id }),
    ...(r.prompt_id === null ? {} : { prompt_id: r.prompt_id }),
    ...(tools[type] === undefined ? {} : { retrieve: { tool: tools[type], input: { op: 'get', id: r.id } } }),
  }));
}

/** One scoped search implementation for HTTP and MCP. An unavailable semantic provider is explicit. */
export async function searchProject(db: RelationalStore, scope: ReadScope, opts: SearchOptions, resolveSemantic?: () => Promise<SemanticSearch | null>): Promise<SearchAnswer> {
  const query = opts.query.trim();
  if (query.length === 0 || query.length > SEARCH_QUERY_MAX_CHARS) throw new InvalidSearch(`query must contain 1–${SEARCH_QUERY_MAX_CHARS} characters`);
  const words = query.split(/\s+/);
  if (words.length > SEARCH_MAX_TERMS) throw new InvalidSearch(`query may contain at most ${SEARCH_MAX_TERMS} terms`);
  const types = typesFor(opts.type);
  const mode = opts.mode ?? 'auto';
  if (!['auto', 'fts', 'semantic'].includes(mode)) throw new InvalidSearch('mode must be auto, fts or semantic');
  const limit = opts.limit ?? SEARCH_API_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) throw new InvalidSearch(`limit must be between 1 and ${SEARCH_MAX_LIMIT}`);
  for (const value of [opts.since, opts.until]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new InvalidSearch('timestamps must be non-negative epoch seconds');
  if (opts.since !== undefined && opts.until !== undefined && opts.since > opts.until) throw new InvalidSearch('since must not exceed until');
  const coverage = { pending_blobs: await pendingSearchBlobs(db, scope.projectId) };
  if (mode !== 'fts') {
    const semantic = await resolveSemantic?.();
    if (semantic != null) {
      try {
        return { results: await semanticSearch(db, scope, semantic, types, { ...opts, query }, limit), mode: 'semantic', provider_unavailable: false, coverage };
      } catch (error) { if (!(error instanceof EmbeddingUnavailable)) throw error; }
    }
  }
  if (mode === 'semantic') return { results: [], mode, provider_unavailable: true, coverage };
  const branches = await Promise.all(types.map((type) => searchType(db, scope, type, words.map(sanitizeFtsQuery), opts, limit)));
  const order = (a: SearchResult, b: SearchResult) => b.score - a.score || SEARCH_TYPES.indexOf(a.type) - SEARCH_TYPES.indexOf(b.type) || a.id.localeCompare(b.id);
  const floor = branches.flatMap((hits) => hits.slice(0, 1)).sort(order).slice(0, limit);
  const remaining = branches.flatMap((hits) => hits.slice(1)).sort(order).slice(0, limit - floor.length);
  return { results: [...floor, ...remaining].sort(order), mode: 'fts', provider_unavailable: mode === 'auto', coverage };
}
