import type { RelationalStore } from '../core/adapters.js';
import type { EmbeddingProvider } from '../core/embedding/provider.js';
import { VECTOR_QUERY_LIMIT, VECTOR_TYPES, vectorMatches, type VectorFilters, type VectorMetadata, type VectorStore, type VectorType } from '../core/embedding/vectors.js';
import { inListChunks, type ReadScope } from './scope.js';
import { SEARCH_PREVIEW_CHARS, type SearchOptions, type SearchResult } from '@goondocks/myco-shared/search-types';
import { notTombstonedSql } from '../core/tombstones.js';
import { CURRENT_EMBEDDING_SOURCES, embeddingSourceSelect } from '../db/embedding-sources.js';

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

export interface SemanticHitCounts { rawMatches: number; joinedHits: number; filteredHits: number }

interface SemanticHitOptions {
  topK: number;
  minScore?: number;
  filters?: VectorFilters;
  preview?: boolean;
  observe?: (counts: SemanticHitCounts) => void;
  during?: <T>(operation: 'vector' | 'sql', work: () => Promise<T>) => Promise<T>;
}

/** Receipt ids drive every source lookup; CROSS JOIN preserves that indexed order. */
function hitHydrationSql(ids: readonly string[], preview: boolean): string {
  const branches = CURRENT_EMBEDDING_SOURCES.map((source) => `SELECT s.*, v.revision,
    COALESCE((SELECT k.state FROM knowledge_release_state k WHERE k.project_id = s.project_id AND k.namespace = s.namespace AND k.record_id = s.record_id ORDER BY k.checked_at DESC, k.id LIMIT 1), '') AS release_state,
    COALESCE((SELECT k.confidence FROM knowledge_release_state k WHERE k.project_id = s.project_id AND k.namespace = s.namespace AND k.record_id = s.record_id ORDER BY k.checked_at DESC, k.id LIMIT 1), '') AS release_confidence,
    r.id AS vector_id, r.neighbor_mean, r.neighbor_std
    FROM hits r CROSS JOIN (${embeddingSourceSelect(source, preview ? `substr(${source.text}, 1, ${SEARCH_PREVIEW_CHARS})` : "''")}) s
    CROSS JOIN embedding_versions v
    WHERE r.type = '${source.type}' AND s.project_id = r.project_id AND s.record_id = r.record_id
      AND v.project_id = r.project_id AND v.type = r.type AND v.record_id = r.record_id AND v.revision = r.revision
      ${source.type === 'session' ? `AND ${notTombstonedSql('s')}` : ''}`);
  return `WITH hits AS MATERIALIZED (SELECT * FROM embedding_receipts
    WHERE project_id = ? AND model_key = ? AND ready = 1 AND id IN (${ids.map(() => '?').join(',')}))
    ${branches.join(' UNION ALL ')}`;
}

/** A vector is readable only while its source revision is still eligible in the same project. */
export async function semanticHits(db: RelationalStore, scope: ReadScope, semantic: SemanticSearch, values: number[], options: SemanticHitOptions): Promise<SemanticHit[]> {
  const partition = { projectId: scope.projectId, modelKey: semantic.provider.modelKey };
  const { observe, preview = false, during = <T>(_operation: 'vector' | 'sql', work: () => Promise<T>) => work(), ...queryOptions } = options;
  const hits = await during('vector', () => semantic.vectors.query(partition, { values, ...queryOptions }));
  observe?.({ rawMatches: hits.length, joinedHits: 0, filteredHits: 0 });
  const byId = new Map(hits.map((h) => [h.id, h.score]));
  const rows: SemanticHit[] = [];
  let joinedHits = 0;
  await during('sql', () => Promise.all(inListChunks(hits.map((h) => h.id)).map(async (ids) => {
    const found = await db.prepare(hitHydrationSql(ids, preview))
      .bind(scope.projectId, partition.modelKey, ...ids).all<Omit<SemanticHit, 'score'>>();
    joinedHits += found.results.length;
    rows.push(...found.results.filter((r) => vectorMatches(r, options.filters)).map((r) => ({ ...r, score: byId.get(r.vector_id)! })));
    observe?.({ rawMatches: hits.length, joinedHits, filteredHits: rows.length });
  })));
  return rows.sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id));
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
    { topK: VECTOR_QUERY_LIMIT, minScore: MIN_SEARCH_SIMILARITY, filters: { ...filters, type }, preview: true })));
  const tools: Partial<Record<VectorType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans' };
  return branches.flat().sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id)).slice(0, limit).map((row) => {
    const tool = tools[row.type];
    return {
      id: row.record_id, type: row.type, title: row.title, preview: row.text.slice(0, SEARCH_PREVIEW_CHARS), score: row.score,
      ...(row.session_id === '' ? {} : { session_id: row.session_id }),
      ...(row.prompt_id === null ? {} : { prompt_id: row.prompt_id }),
      ...(tool === undefined ? {} : { retrieve: { tool, input: { op: 'get', id: row.record_id } } }),
    };
  });
}
