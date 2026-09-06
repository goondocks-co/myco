import type { RelationalStore } from '../core/adapters.js';
import type { EmbeddingProvider } from '../core/embedding/provider.js';
import { VECTOR_QUERY_LIMIT, VECTOR_TYPES, vectorMatches, type VectorFilters, type VectorMetadata, type VectorStore, type VectorType } from '../core/embedding/vectors.js';
import { inListChunks, type ReadScope } from './scope.js';
import { SEARCH_PREVIEW_CHARS, type SearchOptions, type SearchResult } from './search-types.js';

export interface EmbeddingSource extends VectorMetadata {
  project_id: string;
  namespace: string;
  title: string;
  text: string;
  blob_key: string | null;
  prompt_id: string | null;
}
export interface SemanticSearch {
  provider: EmbeddingProvider;
  vectors: VectorStore;
}
export interface SemanticHit extends EmbeddingSource { vector_id: string; score: number; neighbor_mean: number | null; neighbor_std: number | null }
const MIN_SEARCH_SIMILARITY = 0.3;

/** A vector is readable only while its source revision is still eligible in the same project. */
export async function semanticHits(db: RelationalStore, scope: ReadScope, semantic: SemanticSearch, values: number[], options: { topK: number; minScore?: number; filters?: VectorFilters }): Promise<SemanticHit[]> {
  const partition = { projectId: scope.projectId, modelKey: semantic.provider.modelKey };
  const hits = await semantic.vectors.query(partition, { values, ...options });
  const byId = new Map(hits.map((h) => [h.id, h.score]));
  const rows: SemanticHit[] = [];
  for (const ids of inListChunks(hits.map((h) => h.id))) {
    const found = await db.prepare(`SELECT s.*, r.id AS vector_id, r.neighbor_mean, r.neighbor_std FROM embedding_receipts r
      JOIN embedding_sources s ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
      WHERE r.project_id = ? AND r.model_key = ? AND r.ready = 1 AND r.id IN (${ids.map(() => '?').join(',')})`)
      .bind(scope.projectId, partition.modelKey, ...ids).all<Omit<SemanticHit, 'score'>>();
    rows.push(...found.results.map((r) => ({ ...r, score: byId.get(r.vector_id)! })));
  }
  return rows.filter((r) => vectorMatches(r, options.filters)).sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id));
}

/** Semantic queries use the same metadata filters as full-text queries. */
export async function semanticSearch(db: RelationalStore, scope: ReadScope, semantic: SemanticSearch, types: readonly string[], options: SearchOptions, limit: number): Promise<SearchResult[]> {
  const values = await semantic.provider.embed(options.query);
  const filters: VectorFilters = {};
  for (const key of ['status', 'session_id', 'observation_type', 'release_state', 'release_confidence'] as const) {
    if (options[key] !== undefined) filters[key] = options[key];
  }
  if (options.since !== undefined || options.until !== undefined) filters.created_at = {
    ...(options.since === undefined ? {} : { gte: options.since * 1000 }),
    ...(options.until === undefined ? {} : { lte: options.until * 1000 }),
  };
  const retained = types.filter((t): t is VectorType => (VECTOR_TYPES as readonly string[]).includes(t));
  const branches = await Promise.all(retained.map((type) => semanticHits(db, scope, semantic, values,
    { topK: VECTOR_QUERY_LIMIT, minScore: MIN_SEARCH_SIMILARITY, filters: { ...filters, type } })));
  const tools: Record<VectorType, string> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans', skill: 'myco_skills' };
  return branches.flat().sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id)).slice(0, limit).map((row) => ({
    id: row.record_id, type: row.type, title: row.title, preview: row.text.slice(0, SEARCH_PREVIEW_CHARS), score: row.score,
    ...(row.session_id === '' ? {} : { session_id: row.session_id }),
    ...(row.prompt_id === null ? {} : { prompt_id: row.prompt_id }),
    retrieve: { tool: tools[row.type], input: { op: 'get', id: row.record_id } },
  }));
}
