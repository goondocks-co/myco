import type { RelationalStore } from '../core/adapters.js';
import { occurredAt, presentedStatus } from '../db/session-dates.js';
import { pendingSearchBlobs, SEARCH_QUERY_MAX_CHARS } from '../core/search-index.js';
import { projectsBoundOnce, type ProjectSet, type ReadScope } from './scope.js';
import { semanticSearch, type SemanticSearch } from './embedding.js';
import { EmbeddingUnavailable } from '../core/embedding/provider.js';
import { notTombstonedSql } from '../core/tombstones.js';

import { SEARCH_TYPES, SEARCH_API_LIMIT, SEARCH_MAX_LIMIT, SEARCH_PREVIEW_CHARS, type SearchType, type SearchOptions, type SearchResult, type SearchAnswer, type SearchAcrossAnswer, type SearchAcrossResult, type ReleaseAnnotation } from './search-types.js';
import { getReleaseStatesAcross, getReleaseStatesForRecords, isReleaseNamespace, type ReleaseNamespace } from '../core/provenance.js';
export * from './search-types.js';
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
  status?: string; blob?: boolean; namespace: string;
  /** The one line a reader sees for the record, which previews it in place of a snippet wherever it has one. */
  line?: string;
}
const SOURCES: Record<SearchType, Source> = {
  session: { table: 'sessions', id: 'session_id', title: "COALESCE(NULLIF(d.title, ''), 'Session ' || substr(d.session_id, -6))", created: occurredAt('d.'), session: 'd.session_id', prompt: 'NULL', status: presentedStatus('d.'), namespace: 'sessions' },
  spore: { table: 'spores', id: 'id', title: 'd.observation_type', created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', status: 'd.status', namespace: 'spores', line: 'd.agent_line' },
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

interface Hit { project_id: string; id: string; title: string; preview: string; rank: number; created_at: number; session_id: string | null; prompt_id: string | null }

/** Where a search reads: one Project, or a set of them. */
type SearchReach = ReadScope | ProjectSet;

/** The reach as a predicate on `d.project_id`. A set binds at most one value, so the predicate repeats in a statement without multiplying its binds. */
function reachOf(reach: SearchReach): { sql: string; params: string[] } {
  return 'projectId' in reach ? { sql: 'd.project_id = ?', params: [reach.projectId] } : projectsBoundOnce(reach, 'd');
}

async function searchType(db: RelationalStore, reach: SearchReach, type: SearchType, terms: string[], opts: SearchOptions, limit: number): Promise<SearchAcrossResult[]> {
  const s = SOURCES[type];
  if ((opts.status !== undefined && s.status === undefined) || (opts.observation_type !== undefined && type !== 'spore')) return [];
  if (opts.session_id !== undefined && s.session === 'NULL') return [];
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
    WHERE search_blob_chunks_fts MATCH ? AND ${inReach.sql}` : '';
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
  // The page's snippets: each kept row's best match, matched again by its rowid in the branch that found it.
  const ownSnippet = `(SELECT snippet(${fts}, -1, '', '', ' … ', 40) FROM ${fts} WHERE ${fts} MATCH ? AND ${fts}.rowid = kept.match_rowid)`;
  const blobSnippet = `(SELECT snippet(search_blob_chunks_fts, 0, '', '', ' … ', 40) FROM search_blob_chunks_fts
    WHERE search_blob_chunks_fts MATCH ? AND search_blob_chunks_fts.rowid = kept.match_rowid)`;
  const snippet = s.blob ? `CASE kept.branch WHEN 0 THEN ${ownSnippet} ELSE ${blobSnippet} END` : ownSnippet;
  const preview = s.line === undefined ? snippet : `COALESCE(NULLIF(kept.line, ''), ${snippet})`;
  params.push(terms[0]);
  if (s.blob) params.push(terms[0]);
  const rows = (await db.prepare(`WITH candidates AS MATERIALIZED (${first}${blob}),
    kept AS MATERIALIZED (SELECT d.project_id, d.${s.id} AS id, ${s.title} AS title, MIN(candidates.rank) AS rank,
      candidates.branch, candidates.match_rowid, ${s.line ?? 'NULL'} AS line,
      ${s.created} AS created_at, ${s.session} AS session_id, ${s.prompt} AS prompt_id
    FROM candidates CROSS JOIN ${s.table} d ON d.rowid = candidates.source_rowid
    ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} GROUP BY d.rowid ORDER BY rank, created_at DESC, id, d.project_id LIMIT ?)
    SELECT kept.project_id, kept.id, kept.title, kept.rank, kept.created_at, kept.session_id, kept.prompt_id, ${preview} AS preview
    FROM kept ORDER BY kept.rank, kept.created_at DESC, kept.id, kept.project_id`).bind(...params).all<Hit>()).results;
  const best = Math.max(...rows.map((r) => Math.abs(r.rank)), Number.MIN_VALUE);
  // No `skill` entry: `myco_skills` answers from the shipped catalogue, so a
  // hint naming a generated record's id would send a caller to a refusal. The
  // rows survive until #1170 removes the table; the hint does not.
  const tools: Partial<Record<SearchType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans' };
  const tool = tools[type];
  return rows.filter((r) => r.id.length > 0).map((r) => ({
    projectId: r.project_id, id: r.id, type, title: r.title, preview: (r.preview ?? '').slice(0, SEARCH_PREVIEW_CHARS), score: Math.abs(r.rank) / best,
    ...(r.session_id === null ? {} : { session_id: r.session_id }),
    ...(r.prompt_id === null ? {} : { prompt_id: r.prompt_id }),
    ...(tool === undefined ? {} : { retrieve: { tool, input: { op: 'get', id: r.id } } }),
  }));
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
  const { words, types, mode, limit } = validated(opts);
  if (mode === 'semantic') throw new InvalidSearch('semantic search reads one project; across projects, mode must be auto or fts');
  const results = await fullText(db, set, types, words, opts, limit);
  return { results: await withReleaseAcross(db, results), mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: await pendingSearchBlobs(db, set) } };
}

function validated(opts: SearchOptions): { query: string; words: string[]; types: readonly SearchType[]; mode: string; limit: number } {
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
  return { query, words, types, mode, limit };
}

/** Each type's best hits, one statement per type, merged: every type's best first, then the rest by score, to the limit. */
async function fullText(db: RelationalStore, reach: SearchReach, types: readonly SearchType[], words: string[], opts: SearchOptions, limit: number): Promise<SearchAcrossResult[]> {
  const branches = await Promise.all(types.map((type) => searchType(db, reach, type, words.map(sanitizeFtsQuery), opts, limit)));
  const order = (a: SearchAcrossResult, b: SearchAcrossResult) => b.score - a.score || SEARCH_TYPES.indexOf(a.type) - SEARCH_TYPES.indexOf(b.type) || a.id.localeCompare(b.id) || a.projectId.localeCompare(b.projectId);
  const floor = branches.flatMap((hits) => hits.slice(0, 1)).sort(order).slice(0, limit);
  const remaining = branches.flatMap((hits) => hits.slice(1)).sort(order).slice(0, limit - floor.length);
  return [...floor, ...remaining].sort(order);
}

async function searchUnannotated(db: RelationalStore, scope: ReadScope, opts: SearchOptions, resolveSemantic?: () => Promise<SemanticSearch | null>): Promise<SearchAnswer> {
  const { query, words, types, mode, limit } = validated(opts);
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
  const results = (await fullText(db, scope, types, words, opts, limit)).map(({ projectId: _projectId, ...result }) => result);
  return { results, mode: 'fts', provider_unavailable: mode === 'auto', coverage };
}
