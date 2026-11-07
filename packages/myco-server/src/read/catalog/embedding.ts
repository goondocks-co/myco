import type { RelationalStore as embedding_import_RelationalStore } from "../../core/adapters.js";
import type { EmbeddingProvider as embedding_import_EmbeddingProvider } from "../../core/embedding/provider.js";
import { VECTOR_QUERY_LIMIT as embedding_import_VECTOR_QUERY_LIMIT } from "../../core/embedding/vectors.js";
import { VECTOR_TYPES as embedding_import_VECTOR_TYPES } from "../../core/embedding/vectors.js";
import { vectorMatches as embedding_import_vectorMatches } from "../../core/embedding/vectors.js";
import type { VectorFilters as embedding_import_VectorFilters } from "../../core/embedding/vectors.js";
import type { VectorMetadata as embedding_import_VectorMetadata } from "../../core/embedding/vectors.js";
import type { VectorStore as embedding_import_VectorStore } from "../../core/embedding/vectors.js";
import type { VectorType as embedding_import_VectorType } from "../../core/embedding/vectors.js";
import { inListChunks as embedding_import_inListChunks } from "../scope.js";
import type { ReadScope as embedding_import_ReadScope } from "../scope.js";
import { SEARCH_PREVIEW_CHARS as embedding_import_SEARCH_PREVIEW_CHARS } from "@goondocks/myco-shared/search-types";
import type { SearchOptions as embedding_import_SearchOptions } from "@goondocks/myco-shared/search-types";
import type { SearchResult as embedding_import_SearchResult } from "@goondocks/myco-shared/search-types";
import { notTombstonedSql as embedding_import_notTombstonedSql } from "../../db/session-read-model.js";
import { CURRENT_EMBEDDING_SOURCES as embedding_import_CURRENT_EMBEDDING_SOURCES } from "../../db/embedding-sources.js";
import { EMBEDDING_RELEASE_COLUMNS as embedding_import_EMBEDDING_RELEASE_COLUMNS } from "../../db/embedding-sources.js";
import { embeddingSourceSelect as embedding_import_embeddingSourceSelect } from "../../db/embedding-sources.js";
import { settledAll as embedding_import_settledAll } from "../../core/settled.js";

interface embedding_EmbeddingSource extends embedding_import_VectorMetadata {
  project_id: string;
  namespace: string;
  title: string;
  text: string;
  blob_key: string | null;
  prompt_id: string | null;
}

interface embedding_SemanticSearch {
  provider: embedding_import_EmbeddingProvider;
  vectors: embedding_import_VectorStore;
}

interface embedding_SemanticHit extends embedding_EmbeddingSource { vector_id: string; score: number; neighbor_mean: number | null; neighbor_std: number | null }

const embedding_MIN_SEARCH_SIMILARITY = 0.3;

interface embedding_SemanticHitCounts { rawMatches: number; joinedHits: number; filteredHits: number }

interface embedding_SemanticHitOptions {
  topK: number;
  minScore?: number;
  filters?: embedding_import_VectorFilters;
  preview?: boolean;
  observe?: (counts: embedding_SemanticHitCounts) => void;
  during?: <T>(operation: 'vector' | 'sql', work: () => Promise<T>) => Promise<T>;
}

/** A bounded character prefix, including embedded NULs; blob slicing advances past each NUL. */
function embedding_previewSql(text: string): string {
  return `(WITH RECURSIVE chunks(prefix, rest, remaining) AS (
    SELECT '', ${text}, ${embedding_import_SEARCH_PREVIEW_CHARS}
    UNION ALL SELECT prefix || substr(rest, 1, remaining) || char(0),
      CAST(substr(CAST(rest AS BLOB), instr(CAST(rest AS BLOB), x'00') + 1) AS TEXT),
      remaining - length(substr(rest, 1, remaining)) - 1
    FROM chunks WHERE remaining > 0 AND instr(CAST(rest AS BLOB), x'00') > 0
      AND length(substr(rest, 1, remaining)) < remaining
  ) SELECT prefix || substr(rest, 1, remaining) FROM chunks
    WHERE remaining = 0 OR instr(CAST(rest AS BLOB), x'00') = 0
      OR length(substr(rest, 1, remaining)) = remaining LIMIT 1)`;
}

/** Receipt ids drive every source lookup; CROSS JOIN preserves that indexed order. */
function embedding_hitHydrationSql(ids: readonly string[], preview: boolean): string {
  const branches = embedding_import_CURRENT_EMBEDDING_SOURCES.map((source) => `SELECT s.*, v.revision,
    ${embedding_import_EMBEDDING_RELEASE_COLUMNS},
    r.id AS vector_id, r.neighbor_mean, r.neighbor_std
    FROM hits r CROSS JOIN (${embedding_import_embeddingSourceSelect(source, preview ? embedding_previewSql(source.text) : "''")}) s
    CROSS JOIN embedding_versions v
    WHERE r.type = '${source.type}' AND s.project_id = r.project_id AND s.record_id = r.record_id
      AND v.project_id = r.project_id AND v.type = r.type AND v.record_id = r.record_id AND v.revision = r.revision
      ${source.type === 'session' ? `AND ${embedding_import_notTombstonedSql('s')}` : ''}`);
  return `WITH hits AS MATERIALIZED (SELECT * FROM embedding_receipts
    WHERE project_id = ? AND model_key = ? AND ready = 1 AND id IN (${ids.map(() => '?').join(',')}))
    ${branches.join(' UNION ALL ')}`;
}

/** A vector is readable only while its source revision is still eligible in the same project. */
async function embedding_semanticHits(db: embedding_import_RelationalStore, scope: embedding_import_ReadScope, semantic: embedding_SemanticSearch, values: number[], options: embedding_SemanticHitOptions): Promise<embedding_SemanticHit[]> {
  const partition = { projectId: scope.projectId, modelKey: semantic.provider.modelKey };
  const { observe, preview = false, during = <T>(_operation: 'vector' | 'sql', work: () => Promise<T>) => work(), ...queryOptions } = options;
  const hits = await during('vector', () => semantic.vectors.query(partition, { values, ...queryOptions }));
  observe?.({ rawMatches: hits.length, joinedHits: 0, filteredHits: 0 });
  const byId = new Map(hits.map((h) => [h.id, h.score]));
  const rows: embedding_SemanticHit[] = [];
  let joinedHits = 0;
  await during('sql', () => embedding_import_settledAll(embedding_import_inListChunks(hits.map((h) => h.id)).map(async (ids) => {
    const found = await db.prepare(embedding_hitHydrationSql(ids, preview))
      .bind(scope.projectId, partition.modelKey, ...ids).all<Omit<embedding_SemanticHit, 'score'>>();
    joinedHits += found.results.length;
    rows.push(...found.results.filter((r) => embedding_import_vectorMatches(r, options.filters)).map((r) => ({ ...r, score: byId.get(r.vector_id)! })));
    observe?.({ rawMatches: hits.length, joinedHits, filteredHits: rows.length });
  })));
  return rows.sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id));
}

/** Semantic queries use the same metadata filters as full-text queries. */
async function embedding_semanticSearch(db: embedding_import_RelationalStore, scope: embedding_import_ReadScope, semantic: embedding_SemanticSearch, types: readonly string[], options: embedding_import_SearchOptions, limit: number): Promise<embedding_import_SearchResult[]> {
  const values = await semantic.provider.embed(options.query);
  const filters: embedding_import_VectorFilters = {};
  for (const key of ['status', 'session_id', 'observation_type', 'release_state', 'release_confidence'] as const) {
    if (options[key] !== undefined) filters[key] = options[key];
  }
  if (options.since !== undefined || options.until !== undefined) filters.created_at = {
    ...(options.since === undefined ? {} : { gte: options.since * 1000 }),
    ...(options.until === undefined ? {} : { lte: options.until * 1000 }),
  };
  const retained = types.filter((t): t is embedding_import_VectorType => (embedding_import_VECTOR_TYPES as readonly string[]).includes(t));
  const branches = await Promise.all(retained.map((type) => embedding_semanticHits(db, scope, semantic, values,
    { topK: embedding_import_VECTOR_QUERY_LIMIT, minScore: embedding_MIN_SEARCH_SIMILARITY, filters: { ...filters, type }, preview: true })));
  const tools: Partial<Record<embedding_import_VectorType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans' };
  return branches.flat().sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id)).slice(0, limit).map((row) => {
    const tool = tools[row.type];
    return {
      id: row.record_id, type: row.type, title: row.title, preview: row.text.slice(0, embedding_import_SEARCH_PREVIEW_CHARS), score: row.score, created_at: row.created_at,
      ...(row.session_id === '' ? {} : { session_id: row.session_id }),
      ...(row.prompt_id === null ? {} : { prompt_id: row.prompt_id }),
      ...(tool === undefined ? {} : { retrieve: { tool, input: { op: 'get', id: row.record_id } } }),
    };
  });
}

export { type embedding_EmbeddingSource, type embedding_SemanticSearch, type embedding_SemanticHit, type embedding_SemanticHitCounts, embedding_semanticHits, embedding_semanticSearch };
