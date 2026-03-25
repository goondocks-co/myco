/**
 * SqliteVecVectorStore — vector storage backed by sqlite-vec in a separate vectors.db.
 *
 * Fully decoupled from the record store (myco.db). Owns:
 *   - One vec0 virtual table per embeddable namespace (cosine distance metric)
 *   - A regular `embedding_metadata` table for provider/model/hash tracking
 *
 * All methods are synchronous (better-sqlite3 is sync).
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
import {
  EMBEDDABLE_NAMESPACES,
  type EmbeddableNamespace,
  type VectorStore,
  type VectorSearchResult,
  type VectorStoreStats,
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
  private db: DatabaseType;

  // Cached prepared statements (lazy-initialized per namespace)
  private deleteVecStmts = new Map<string, Statement>();
  private insertVecStmts = new Map<string, Statement>();
  private upsertMetaStmt!: Statement;
  private deleteMetaStmt!: Statement;
  private searchStmts = new Map<string, Statement>();

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? ':memory:');
    sqliteVec.load(this.db);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();
    this.prepareStatements();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private createSchema(): void {
    this.db.exec(METADATA_TABLE);
    this.db.exec(METADATA_MODEL_INDEX);
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
                 em.model, em.provider, em.content_hash, em.embedded_at, em.domain_metadata
          FROM vec_${ns} v
          LEFT JOIN embedding_metadata em
            ON em.namespace = '${ns}' AND em.record_id = v.record_id
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

      // Upsert metadata
      this.upsertMetaStmt.run({
        namespace: ns,
        record_id: id,
        model: (metadata?.['model'] as string) ?? DEFAULT_META_MODEL,
        provider: (metadata?.['provider'] as string) ?? DEFAULT_META_PROVIDER,
        dimensions: embedding.length,
        content_hash: (metadata?.['content_hash'] as string) ?? DEFAULT_META_CONTENT_HASH,
        embedded_at: (metadata?.['embedded_at'] as number) ?? Date.now(),
        domain_metadata: metadata?.['domain_metadata']
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

  stats(namespace?: string): VectorStoreStats {
    const targets = namespace
      ? [this.validatedNamespace(namespace)]
      : [...EMBEDDABLE_NAMESPACES];

    let total = 0;
    const by_namespace: Record<string, { embedded: number; stale: number }> = {};
    const models: Record<string, number> = {};

    for (const ns of targets) {
      // Total embedded for this namespace
      const countRow = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM embedding_metadata WHERE namespace = ?`,
        )
        .get(ns) as { cnt: number };

      // Count per model for this namespace
      const modelRows = this.db
        .prepare(
          `SELECT model, COUNT(*) as cnt FROM embedding_metadata WHERE namespace = ? GROUP BY model`,
        )
        .all(ns) as Array<{ model: string; cnt: number }>;

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
    const rows = this.db
      .prepare(
        `SELECT record_id FROM embedding_metadata WHERE namespace = ? AND model != ? LIMIT ?`,
      )
      .all(namespace, currentModel, limit) as Array<{ record_id: string }>;
    return rows.map((r) => r.record_id);
  }

  getEmbeddedIds(namespace: string): string[] {
    this.validateNamespace(namespace);
    const rows = this.db
      .prepare(
        `SELECT record_id FROM embedding_metadata WHERE namespace = ?`,
      )
      .all(namespace) as Array<{ record_id: string }>;
    return rows.map((r) => r.record_id);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
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
             em.model, em.provider, em.content_hash, em.embedded_at, em.domain_metadata
      FROM knn
      INNER JOIN embedding_metadata em
        ON em.namespace = '${namespace}' AND em.record_id = knn.record_id
      ${whereClause}
    `;

    return { sql, params };
  }
}
