/**
 * SqliteVecVectorStore — vector storage backed by sqlite-vec in a separate vectors.db.
 *
 * Fully decoupled from the record store (myco.db). Owns:
 *   - One vec0 virtual table per embeddable namespace (cosine distance metric)
 *   - A regular `embedding_metadata` table for provider/model/hash tracking
 *
 * All methods are synchronous (bun:sqlite is sync).
 */

import { Database } from 'bun:sqlite';
import type { Statement } from 'bun:sqlite';
import { getVec0Path, resolveDevNativeDeps } from '../../runtime/native-deps.js';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
import {
  EMBEDDABLE_NAMESPACES,
  type DomainMetadata,
  type EmbeddableNamespace,
  type VectorStore,
  type VectorSearchResult,
  type VectorStoreStats,
  type HubnessStat,
} from '@myco/daemon/embedding/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default search result limit when none is specified. */
const DEFAULT_SEARCH_LIMIT = 10;

/** Default similarity threshold — results below this are excluded. */
const DEFAULT_SIMILARITY_THRESHOLD = 0;

/** Fallback model name when metadata omits it. */
const DEFAULT_META_MODEL = 'unknown';

/** Fallback provider name when metadata omits it. */
const DEFAULT_META_PROVIDER = 'unknown';

/** Fallback content hash when metadata omits it. */
const DEFAULT_META_CONTENT_HASH = '';

/** Metadata columns safe to filter on in search queries (prevents SQL injection via key names). */
const FILTERABLE_COLUMNS = new Set(['model', 'provider', 'namespace']);
const FILTERABLE_DOMAIN_METADATA_KEYS = new Set([
  'status',
  'session_id',
  'observation_type',
  'project_root',
  'name',
  'source_path',
  'created_at',
  'project_id',
  'path',
  'language',
  'release_state',
  'release_confidence',
  'release_basis_kind',
  'release_checked_at',
]);
const FILTER_SUFFIX_TO_OPERATOR: Record<string, string> = {
  _gte: '>=',
  _lte: '<=',
  _gt: '>',
  _lt: '<',
};

/**
 * Convert cosine *distance* (0 = identical, 2 = opposite) to a similarity
 * score in [−1, 1]. Cosine distance = 1 − cosine_similarity.
 */
function cosineDistanceToSimilarity(distance: number): number {
  return 1 - distance;
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const METADATA_TABLE = `
  CREATE TABLE IF NOT EXISTS embedding_metadata (
    namespace       TEXT NOT NULL,
    record_id       TEXT NOT NULL,
    model           TEXT NOT NULL,
    provider        TEXT NOT NULL,
    dimensions      INTEGER NOT NULL,
    content_hash    TEXT NOT NULL,
    embedded_at     INTEGER NOT NULL,
    domain_metadata TEXT,
    PRIMARY KEY (namespace, record_id)
  )`;

const METADATA_MODEL_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_emb_meta_model
  ON embedding_metadata (namespace, model)`;

// Per-record corpus distance distribution (hubness baseline). Recomputed
// periodically by the reconcile loop; consumed by hubness-aware relevance
// selection so central "hub" vectors are demoted unless unusually relevant.
const HUBNESS_TABLE = `
  CREATE TABLE IF NOT EXISTS hubness_stats (
    namespace   TEXT NOT NULL,
    record_id   TEXT NOT NULL,
    dist_mean   REAL NOT NULL,
    dist_std    REAL NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, record_id)
  )`;

/** Build the DDL for a single vec0 virtual table. */
function vecTableDDL(namespace: EmbeddableNamespace): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_${namespace} USING vec0(
    record_id TEXT PRIMARY KEY,
    embedding float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
  )`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SqliteVecVectorStore implements VectorStore {
  private db: Database;

  // Cached prepared statements (lazy-initialized per namespace)
  private deleteVecStmts = new Map<string, Statement>();
  private insertVecStmts = new Map<string, Statement>();
  private upsertMetaStmt!: Statement;
  private deleteMetaStmt!: Statement;
  private searchStmts = new Map<string, Statement>();
  private statsCountStmt!: Statement;
  private statsModelsStmt!: Statement;
  private staleIdsStmt!: Statement;
  private embeddedIdsStmt!: Statement;
  private upsertHubnessStmt!: Statement;

  constructor(dbPath?: string) {
    // Ensure Database.setCustomSQLite has fired (libsqlite3 with extension support).
    resolveDevNativeDeps();
    this.db = new Database(dbPath ?? ':memory:');
    this.db.loadExtension(getVec0Path());
    this.db.run('PRAGMA journal_mode = WAL');
    this.createSchema();
    this.prepareStatements();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private createSchema(): void {
    this.db.exec(METADATA_TABLE);
    this.db.exec(METADATA_MODEL_INDEX);
    this.db.exec(HUBNESS_TABLE);
    for (const ns of EMBEDDABLE_NAMESPACES) {
      this.db.exec(vecTableDDL(ns));
    }
  }

  private prepareStatements(): void {
    this.upsertMetaStmt = this.db.prepare(`
      INSERT INTO embedding_metadata (namespace, record_id, model, provider, dimensions, content_hash, embedded_at, domain_metadata)
      VALUES (@namespace, @record_id, @model, @provider, @dimensions, @content_hash, @embedded_at, @domain_metadata)
      ON CONFLICT (namespace, record_id) DO UPDATE SET
        model = excluded.model,
        provider = excluded.provider,
        dimensions = excluded.dimensions,
        content_hash = excluded.content_hash,
        embedded_at = excluded.embedded_at,
        domain_metadata = excluded.domain_metadata
    `);

    this.deleteMetaStmt = this.db.prepare(
      `DELETE FROM embedding_metadata WHERE namespace = ? AND record_id = ?`
    );
    this.statsCountStmt = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM embedding_metadata WHERE namespace = ?`
    );
    this.statsModelsStmt = this.db.prepare(
      `SELECT model, COUNT(*) AS cnt FROM embedding_metadata WHERE namespace = ? GROUP BY model`
    );
    this.staleIdsStmt = this.db.prepare(
      `SELECT record_id FROM embedding_metadata WHERE namespace = ? AND model != ? LIMIT ?`
    );
    this.embeddedIdsStmt = this.db.prepare(
      `SELECT record_id FROM embedding_metadata WHERE namespace = ?`
    );
    this.upsertHubnessStmt = this.db.prepare(`
      INSERT INTO hubness_stats (namespace, record_id, dist_mean, dist_std, computed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (namespace, record_id) DO UPDATE SET
        dist_mean = excluded.dist_mean,
        dist_std = excluded.dist_std,
        computed_at = excluded.computed_at
    `);

    // Per-namespace statements
    for (const ns of EMBEDDABLE_NAMESPACES) {
      this.deleteVecStmts.set(
        ns,
        this.db.prepare(`DELETE FROM vec_${ns} WHERE record_id = ?`)
      );
      this.insertVecStmts.set(
        ns,
        this.db.prepare(`INSERT INTO vec_${ns}(record_id, embedding) VALUES (?, ?)`)
      );
      this.searchStmts.set(
        ns,
        this.db.prepare(`
          SELECT v.record_id, v.distance,
                 em.model, em.provider, em.content_hash, em.embedded_at, em.domain_metadata,
                 hs.dist_mean, hs.dist_std
          FROM vec_${ns} v
          LEFT JOIN embedding_metadata em
            ON em.namespace = '${ns}' AND em.record_id = v.record_id
          LEFT JOIN hubness_stats hs
            ON hs.namespace = '${ns}' AND hs.record_id = v.record_id
          WHERE v.embedding MATCH ?
            AND k = ?
          ORDER BY v.distance
        `)
      );
    }
  }

  // -------------------------------------------------------------------------
  // VectorStore interface
  // -------------------------------------------------------------------------

  upsert(
    namespace: string,
    id: string,
    embedding: number[],
    metadata?: Record<string, unknown>,
  ): void {
    this.validateNamespace(namespace);
    const ns = namespace as EmbeddableNamespace;

    const vec = new Float32Array(embedding);

    const txn = this.db.transaction(() => {
      // Delete-then-insert for vec0 (INSERT OR REPLACE not fully supported)
      this.deleteVecStmts.get(ns)!.run(id);
      this.insertVecStmts.get(ns)!.run(id, vec);

      // Upsert metadata. bun:sqlite requires the @-prefix in binding keys to
      // match @name placeholders in the SQL (better-sqlite3 accepted either).
      this.upsertMetaStmt.run({
        '@namespace': ns,
        '@record_id': id,
        '@model': (metadata?.['model'] as string) ?? DEFAULT_META_MODEL,
        '@provider': (metadata?.['provider'] as string) ?? DEFAULT_META_PROVIDER,
        '@dimensions': embedding.length,
        '@content_hash': (metadata?.['content_hash'] as string) ?? DEFAULT_META_CONTENT_HASH,
        '@embedded_at': (metadata?.['embedded_at'] as number) ?? Date.now(),
        '@domain_metadata': metadata?.['domain_metadata']
          ? JSON.stringify(metadata['domain_metadata'])
          : null,
      });
    });

    txn();
  }

  remove(namespace: string, id: string): void {
    this.validateNamespace(namespace);
    const ns = namespace as EmbeddableNamespace;

    const txn = this.db.transaction(() => {
      this.deleteVecStmts.get(ns)!.run(id);
      this.deleteMetaStmt.run(ns, id);
    });

    txn();
  }

  patchDomainMetadata(namespace: string, id: string, patch: Partial<DomainMetadata>): boolean {
    this.validateNamespace(namespace);
    if (!patch || Object.keys(patch).length === 0) return false;
    // json_patch merges objects; null values delete keys. Build a partial
    // JSON literal that only contains the fields we want to overwrite.
    const patchJson = JSON.stringify(patch);
    const result = this.db.prepare(
      `UPDATE embedding_metadata
          SET domain_metadata = json_patch(COALESCE(domain_metadata, '{}'), ?)
        WHERE namespace = ? AND record_id = ?`,
    ).run(patchJson, namespace, id);
    return result.changes > 0;
  }

  clear(namespace?: string): { cleared: number } {
    let cleared = 0;

    const targets = namespace
      ? [this.validatedNamespace(namespace)]
      : [...EMBEDDABLE_NAMESPACES];

    const txn = this.db.transaction(() => {
      for (const ns of targets) {
        // Count rows before clearing
        const countRow = this.db
          .prepare(`SELECT COUNT(*) as cnt FROM embedding_metadata WHERE namespace = ?`)
          .get(ns) as { cnt: number };
        cleared += countRow.cnt;

        // Delete all vectors in this namespace's vec table
        this.db.exec(`DELETE FROM vec_${ns}`);

        // Delete metadata for this namespace
        this.db
          .prepare(`DELETE FROM embedding_metadata WHERE namespace = ?`)
          .run(ns);
      }
    });

    txn();
    return { cleared };
  }

  /**
   * KNN similarity search across one or all namespaces.
   *
   * Threshold filtering is applied **post-KNN**: sqlite-vec returns the top-k
   * nearest neighbors first, then results below `threshold` are discarded.
   * This means fewer than `limit` results may be returned when a threshold is set.
   * This is standard KNN behavior, not a bug.
   */
  search(
    query: number[],
    options?: {
      namespace?: string;
      limit?: number;
      threshold?: number;
      filters?: Record<string, unknown>;
    },
  ): VectorSearchResult[] {
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    const threshold = options?.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const queryVec = new Float32Array(query);

    const targets = options?.namespace
      ? [this.validatedNamespace(options.namespace)]
      : [...EMBEDDABLE_NAMESPACES];

    const hasFilters = options?.filters && Object.keys(options.filters).length > 0;
    const results: VectorSearchResult[] = [];

    for (const ns of targets) {
      let rows: Array<Record<string, unknown>>;

      if (hasFilters) {
        // Build a filtered query that JOINs with embedding_metadata
        const { sql, params } = this.buildFilteredSearchQuery(
          ns,
          options!.filters!,
          limit,
        );
        const stmt = this.db.prepare(sql);
        rows = stmt.all(queryVec, limit, ...params) as Array<Record<string, unknown>>;
      } else {
        rows = this.searchStmts.get(ns)!.all(queryVec, limit) as Array<Record<string, unknown>>;
      }

      for (const row of rows) {
        const similarity = cosineDistanceToSimilarity(row.distance as number);
        if (similarity >= threshold) {
          results.push({
            id: row.record_id as string,
            namespace: ns,
            similarity,
            metadata: {
              model: row.model,
              provider: row.provider,
              content_hash: row.content_hash,
              embedded_at: row.embedded_at,
              ...(row.dist_mean != null ? { neighbor_mean: row.dist_mean } : {}),
              ...(row.dist_std != null ? { neighbor_std: row.dist_std } : {}),
              ...(row.domain_metadata ? JSON.parse(row.domain_metadata as string) : {}),
            },
          });
        }
      }
    }

    // Sort by similarity DESC across all namespaces, then truncate to limit
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  stats(options: { namespace?: string; projectId?: string | null } = {}): VectorStoreStats {
    // NOTE: `projectId` is reserved on the signature for the future
    // namespace-aware project narrowing pass, but `embedding_metadata`
    // doesn't carry a project_id column today — vector totals come back
    // Grove-wide regardless of scope. The Operations pill keeps the
    // option visible so the wiring is in place; the values match
    // Grove totals in single-project Groves and across all projects
    // in the same Grove. Cross-Grove fan-out (`all-groves`) is the
    // next step.
    void options.projectId;
    const { namespace } = options;
    const targets = namespace
      ? [this.validatedNamespace(namespace)]
      : [...EMBEDDABLE_NAMESPACES];

    let total = 0;
    const by_namespace: Record<string, { embedded: number; stale: number }> = {};
    const models: Record<string, number> = {};

    for (const ns of targets) {
      const countRow = this.statsCountStmt.get(ns) as { cnt: number };
      const modelRows = this.statsModelsStmt.all(ns) as Array<{ model: string; cnt: number }>;

      // "stale" = count of rows whose model is NOT the most common model.
      // Without knowing the "current model" (which stats() doesn't receive),
      // we approximate by treating the majority model as current.
      let stale = 0;
      let maxModelCount = 0;
      for (const mr of modelRows) {
        models[mr.model] = (models[mr.model] ?? 0) + mr.cnt;
        if (mr.cnt > maxModelCount) maxModelCount = mr.cnt;
      }
      stale = countRow.cnt - maxModelCount;
      if (stale < 0) stale = 0;

      by_namespace[ns] = { embedded: countRow.cnt, stale };
      total += countRow.cnt;
    }

    return { total, by_namespace, models };
  }

  getStaleIds(namespace: string, currentModel: string, limit: number): string[] {
    this.validateNamespace(namespace);
    const rows = this.staleIdsStmt.all(namespace, currentModel, limit) as Array<{ record_id: string }>;
    return rows.map((r) => r.record_id);
  }

  getEmbeddedIds(namespace: string): string[] {
    this.validateNamespace(namespace);
    const rows = this.embeddedIdsStmt.all(namespace) as Array<{ record_id: string }>;
    return rows.map((r) => r.record_id);
  }

  /**
   * Compute pairwise cosine similarity between all vectors in a namespace.
   * Returns pairs above the threshold, sorted by similarity DESC.
   *
   * Uses sqlite-vec's KNN search: for each vector, find the top-K nearest
   * neighbors within the same namespace. O(n * K) where K is small.
   */
  pairwiseSimilarity(
    namespace: string,
    threshold: number = 0.5,
  ): Array<{ idA: string; idB: string; similarity: number }> {
    this.validateNamespace(namespace);
    const ns = namespace as EmbeddableNamespace;

    // Get all record IDs and their vectors
    const allRows = this.db.prepare(
      `SELECT record_id, embedding FROM vec_${ns}`,
    ).all() as Array<{ record_id: string; embedding: Buffer }>;

    if (allRows.length < 2) return [];

    const pairs: Array<{ idA: string; idB: string; similarity: number }> = [];
    const seen = new Set<string>();

    // For each vector, search for similar ones in the same namespace
    const searchStmt = this.searchStmts.get(ns)!;
    for (const row of allRows) {
      const results = searchStmt.all(
        row.embedding, // Use the raw embedding as the query vector
        allRows.length, // K = all rows to get exhaustive comparison
      ) as Array<{ record_id: string; distance: number }>;

      for (const match of results) {
        if (match.record_id === row.record_id) continue; // skip self
        const pairKey = [row.record_id, match.record_id].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const similarity = cosineDistanceToSimilarity(match.distance);
        if (similarity >= threshold) {
          pairs.push({
            idA: row.record_id,
            idB: match.record_id,
            similarity: Math.round(similarity * 1000) / 1000,
          });
        }
      }
    }

    pairs.sort((a, b) => b.similarity - a.similarity);
    return pairs;
  }

  async computeHubnessStats(namespace: string): Promise<HubnessStat[]> {
    this.validateNamespace(namespace);
    const ns = namespace as EmbeddableNamespace;

    const allRows = this.db.prepare(
      `SELECT record_id, embedding FROM vec_${ns}`,
    ).all() as Array<{ record_id: string; embedding: Buffer }>;

    if (allRows.length < 2) return [];

    const searchStmt = this.searchStmts.get(ns)!;
    const stats: HubnessStat[] = [];
    // Process KNN queries in chunks, yielding between chunks to bound event-loop lag.
    // Each chunk is ~32 synchronous sqlite-vec queries; at 870 spores that is
    // ~28 yields, keeping per-chunk wall time well under 200 ms.
    const CHUNK = 32;
    for (let i = 0; i < allRows.length; i++) {
      if (i > 0 && i % CHUNK === 0) await new Promise<void>((r) => setImmediate(r));
      const row = allRows[i];
      // KNN against the whole namespace; the row's distance to itself (~0) is
      // dropped so the distribution reflects only the rest of the corpus.
      const results = searchStmt.all(row.embedding, allRows.length) as Array<{
        record_id: string;
        distance: number;
      }>;
      const distances: number[] = [];
      for (const match of results) {
        if (match.record_id === row.record_id) continue;
        distances.push(match.distance);
      }
      if (distances.length === 0) continue;
      const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
      const variance =
        distances.reduce((a, b) => a + (b - mean) ** 2, 0) / distances.length;
      stats.push({ recordId: row.record_id, mean, std: Math.sqrt(variance) });
    }
    return stats;
  }

  upsertHubnessStats(namespace: string, stats: HubnessStat[]): void {
    this.validateNamespace(namespace);
    const now = Date.now();
    const tx = this.db.transaction((rows: HubnessStat[]) => {
      for (const s of rows) {
        this.upsertHubnessStmt.run(namespace, s.recordId, s.mean, s.std, now);
      }
    });
    tx(stats);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    // bun:sqlite's `db.close()` is a no-op while prepared statements are still
    // alive — subsequent `stmt.all(...)` calls succeed even after the supposed
    // close. Finalize all cached statements first so the handle closes for
    // real, matching better-sqlite3's behavior.
    const stmts: Array<{ finalize?: () => void } | undefined> = [
      this.upsertMetaStmt,
      this.deleteMetaStmt,
      this.statsCountStmt,
      this.statsModelsStmt,
      this.staleIdsStmt,
      this.embeddedIdsStmt,
      this.upsertHubnessStmt,
    ];
    for (const stmt of stmts) {
      try { stmt?.finalize?.(); } catch { /* already finalized */ }
    }
    for (const stmt of this.deleteVecStmts.values()) {
      try { (stmt as unknown as { finalize?: () => void }).finalize?.(); } catch { /* */ }
    }
    for (const stmt of this.insertVecStmts.values()) {
      try { (stmt as unknown as { finalize?: () => void }).finalize?.(); } catch { /* */ }
    }
    for (const stmt of this.searchStmts.values()) {
      try { (stmt as unknown as { finalize?: () => void }).finalize?.(); } catch { /* */ }
    }
    this.deleteVecStmts.clear();
    this.insertVecStmts.clear();
    this.searchStmts.clear();
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private validateNamespace(namespace: string): void {
    if (!(EMBEDDABLE_NAMESPACES as readonly string[]).includes(namespace)) {
      throw new Error(
        `Invalid namespace "${namespace}". Must be one of: ${EMBEDDABLE_NAMESPACES.join(', ')}`,
      );
    }
  }

  private validatedNamespace(namespace: string): EmbeddableNamespace {
    this.validateNamespace(namespace);
    return namespace as EmbeddableNamespace;
  }

  /**
   * Build a filtered KNN query that JOINs vec results with embedding_metadata.
   * Filters are applied as WHERE conditions on the metadata table.
   */
  private buildFilteredSearchQuery(
    namespace: EmbeddableNamespace,
    filters: Record<string, unknown>,
    _limit: number,
  ): { sql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(filters)) {
      if (FILTERABLE_COLUMNS.has(key)) {
        conditions.push(`em.${key} = ?`);
        params.push(value);
        continue;
      }

      let metadataKey = key;
      let operator = '=';
      for (const [suffix, sqlOperator] of Object.entries(FILTER_SUFFIX_TO_OPERATOR)) {
        if (key.endsWith(suffix)) {
          metadataKey = key.slice(0, -suffix.length);
          operator = sqlOperator;
          break;
        }
      }

      if (FILTERABLE_DOMAIN_METADATA_KEYS.has(metadataKey)) {
        conditions.push(`json_extract(em.domain_metadata, '$.${metadataKey}') ${operator} ?`);
        params.push(value);
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      WITH knn AS (
        SELECT record_id, distance
        FROM vec_${namespace}
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      )
      SELECT knn.record_id, knn.distance,
             em.model, em.provider, em.content_hash, em.embedded_at, em.domain_metadata,
             hs.dist_mean, hs.dist_std
      FROM knn
      INNER JOIN embedding_metadata em
        ON em.namespace = '${namespace}' AND em.record_id = knn.record_id
      LEFT JOIN hubness_stats hs
        ON hs.namespace = '${namespace}' AND hs.record_id = knn.record_id
      ${whereClause}
    `;

    return { sql, params };
  }
}
