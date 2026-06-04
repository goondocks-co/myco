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
  VECTOR_PARTITION_KEYS,
  VECTOR_COLUMN_KEYS,
  VECTOR_INDEXED_KEYS,
  FILTERABLE_DOMAIN_KEYS,
} from '@myco/semantic-search-filters.js';
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

/** `embedding_metadata` columns (NOT domain_metadata keys) filterable post-KNN. */
const FILTERABLE_COLUMNS = new Set(['model', 'provider', 'namespace']);
const FILTER_SUFFIX_TO_OPERATOR: Record<string, string> = {
  _gte: '>=',
  _lte: '<=',
  _gt: '>',
  _lt: '<',
};

/**
 * The vec0 column layout is DERIVED from the single filterable-key registry in
 * `semantic-search-filters.ts` — partition keys + the in-KNN metadata columns —
 * so the filterable-key set is defined in exactly one place. Promoting a key to
 * a column lets the KNN filter on it IN the traversal (curing the
 * over-truncation bug, where post-KNN filtering with a small `k` silently
 * dropped matching rows). Per the registry's contract, every promoted column is
 * TEXT, equality-filtered, and embed-stable; range keys (`created_at`),
 * patched-in-place keys (`release_*`), and long-string keys stay post-KNN.
 */
const VEC0_PARTITION_KEYS: readonly string[] = VECTOR_PARTITION_KEYS;
const VEC0_COLUMN_KEYS: readonly string[] = VECTOR_COLUMN_KEYS;

/**
 * Sentinel for a missing partition/column value. vec0 columns cannot be NULL
 * (sqlite-vec rejects NULL binds). Every promoted column is TEXT and
 * equality-only, so `''` is correct: it never equals a real value, so a record
 * missing the field is excluded by a filter on it — matching both the
 * pre-existing `project_id IS NULL` row scope and `matchesSemanticSearchFilters`
 * (which excludes `undefined`). Range keys are never columns, so the sentinel
 * never participates in a comparison.
 */
const VEC0_MISSING = '';

/** Over-fetch multiplier when a post-KNN (json_extract) filter must run after the KNN. */
const POST_KNN_OVERFETCH_FACTOR = 8;
/**
 * Upper bound on fail-loud re-query widening: when a post-KNN filtered search
 * under-fills AND the candidate pool was fully consumed, `search` widens `k`
 * and re-queries up to this factor before accepting a short result — so a
 * selective long-string filter cannot silently return too few rows.
 */
const POST_KNN_MAX_OVERFETCH_FACTOR = 64;

/**
 * Schema version for `vectors.db`, tracked via `PRAGMA user_version`.
 *
 * v1: vec0 tables gained the `project_id` partition key + the short metadata
 * columns so filtering happens inside the KNN. Existing tables (v0) have only
 * `(record_id, embedding)`, which `CREATE … IF NOT EXISTS` cannot upgrade —
 * vec0 has no `ALTER TABLE`. The migration recreates each table with the new
 * layout, copying the stored vectors and backfilling the columns from
 * `embedding_metadata.domain_metadata`. No re-embedding: vectors are read out
 * of the old table and re-inserted, so the migration is fast and provider-free.
 */
const VEC_STORE_SCHEMA_VERSION = 1;

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

/** vec0 table name for a namespace. */
const vecTable = (namespace: EmbeddableNamespace): string => `vec_${namespace}`;
/** Temp table used during a v0→v1 migration of a namespace. */
const vecMigratingTable = (namespace: EmbeddableNamespace): string => `vec_${namespace}__migrating`;

/** Build the DDL for a vec0 virtual table under the given name. */
function vecTableDDL(tableName: string): string {
  // Column order sqlite-vec expects (confirmed on 0.1.9): primary key,
  // partition key(s), the vector, then metadata columns. All promoted columns
  // are TEXT (see the registry contract).
  const partitionCols = VEC0_PARTITION_KEYS.map((k) => `    ${k} TEXT partition key`).join(',\n');
  const metaCols = VEC0_COLUMN_KEYS.map((k) => `    ${k} TEXT`).join(',\n');
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
    record_id TEXT PRIMARY KEY,
${partitionCols},
    embedding float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine,
${metaCols}
  )`;
}

/** Ordered `INSERT INTO vec_<ns>` column list: id, partitions, vector, columns. */
function vecInsertColumns(): string[] {
  return ['record_id', ...VEC0_PARTITION_KEYS, 'embedding', ...VEC0_COLUMN_KEYS];
}

/**
 * `SELECT` clause that reads a v0 vec table joined to `embedding_metadata` and
 * projects each partition/metadata column out of `domain_metadata` — in
 * `vecInsertColumns()` order. `CAST(... AS TEXT)` + `COALESCE(..., '')` make
 * the projection total and correctly-typed (mirrors `vecColumnValues`), so the
 * migration is a pure in-engine `INSERT … SELECT` with no JS round-trip.
 */
function vecBackfillSelect(namespace: EmbeddableNamespace): string {
  const fromMetadata = (key: string): string =>
    `COALESCE(CAST(json_extract(em.domain_metadata, '$.${key}') AS TEXT), '')`;
  const selectExprs = [
    'v.record_id',
    ...VEC0_PARTITION_KEYS.map(fromMetadata),
    'v.embedding',
    ...VEC0_COLUMN_KEYS.map(fromMetadata),
  ];
  return `SELECT ${selectExprs.join(', ')}
          FROM ${vecTable(namespace)} v
          LEFT JOIN embedding_metadata em
            ON em.namespace = '${namespace}' AND em.record_id = v.record_id`;
}

/**
 * Project a record's `domain_metadata` onto its vec0 column values, returning
 * the partition values and metadata-column values separately so the caller can
 * interleave the embedding between them (per `vecInsertColumns` order).
 *
 * Every value is coerced to a string (all promoted columns are TEXT — coercion
 * means a mistyped field can't throw at the vec0 bind boundary) and a missing
 * value binds {@link VEC0_MISSING}.
 */
function vecColumnValues(domainMetadata: Record<string, unknown> | undefined): {
  partitionValues: string[];
  columnValues: string[];
} {
  const dm = domainMetadata ?? {};
  const coerce = (key: string): string => {
    const v = dm[key];
    return v === undefined || v === null ? VEC0_MISSING : String(v);
  };
  return {
    partitionValues: VEC0_PARTITION_KEYS.map(coerce),
    columnValues: VEC0_COLUMN_KEYS.map(coerce),
  };
}

/** Map a hydrated search row (vec join + embedding_metadata) to a result. */
function toSearchResult(
  row: Record<string, unknown>,
  namespace: EmbeddableNamespace,
  similarity: number,
): VectorSearchResult {
  return {
    id: row.record_id as string,
    namespace,
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
  };
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
  /** Cache of filtered/candidate-count prepared statements, keyed by SQL text. */
  private filteredStmtCache = new Map<string, Statement>();
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
    // Upgrade any pre-existing v0 vec tables BEFORE the IF NOT EXISTS creates
    // below (which can't alter an existing table). Reads domain_metadata, so it
    // must run after embedding_metadata exists.
    this.migrateVecTables();
    for (const ns of EMBEDDABLE_NAMESPACES) {
      this.db.exec(vecTableDDL(vecTable(ns)));
    }
  }

  /**
   * Bring `vectors.db` up to {@link VEC_STORE_SCHEMA_VERSION}. No-op when the
   * store is already current (including fresh databases, whose tables are
   * created new-schema by `createSchema`). See {@link VEC_STORE_SCHEMA_VERSION}.
   */
  private migrateVecTables(): void {
    const { user_version: version } = this.db
      .query('PRAGMA user_version')
      .get() as { user_version: number };
    if (version >= VEC_STORE_SCHEMA_VERSION) return;

    // Drop any temp table left by an interrupted prior run. The original vec
    // table (if it still exists) is the authority; a half-built temp is stale.
    for (const ns of EMBEDDABLE_NAMESPACES) {
      this.db.run(`DROP TABLE IF EXISTS ${vecMigratingTable(ns)}`);
    }
    for (const ns of EMBEDDABLE_NAMESPACES) {
      this.migrateVecTableToV1(ns);
    }
    this.db.run(`PRAGMA user_version = ${VEC_STORE_SCHEMA_VERSION}`);
  }

  /**
   * Recreate one v0 vec table with the v1 layout — vectors copied and the
   * partition/metadata columns backfilled from `embedding_metadata` — entirely
   * in the engine via `INSERT … SELECT` (no JS materialization, no per-row
   * queries). No-op when the table is missing (createSchema makes it v1) or
   * already v1.
   *
   * Atomicity without `ALTER … RENAME` (which vec0 lacks): build the migrated
   * copy in a temp table while the original stays intact, verify the row count
   * matches before dropping the original, then rebuild the original name from
   * the verified copy inside a transaction. A crash before the count check
   * leaves the original untouched (retried next start); the vectors are also
   * re-embeddable via `myco rebuild` as a backstop.
   */
  private migrateVecTableToV1(ns: EmbeddableNamespace): void {
    const existing = this.db
      .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(vecTable(ns)) as { sql: string } | undefined;
    if (!existing) return; // missing — will be created new-schema
    if (existing.sql.includes('partition key')) return; // already v1

    const tmp = vecMigratingTable(ns);
    const cols = vecInsertColumns().join(', ');

    // 1. Build the migrated copy from the still-intact original.
    this.db.exec(vecTableDDL(tmp));
    this.db.run(`INSERT INTO ${tmp}(${cols}) ${vecBackfillSelect(ns)}`);

    // 2. Verify completeness BEFORE destroying the original. A short copy means
    //    a bad backfill — fail loud, keep the original, don't bump the version.
    const count = (table: string): number =>
      (this.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const srcCount = count(vecTable(ns));
    const migCount = count(tmp);
    if (migCount !== srcCount) {
      this.db.run(`DROP TABLE IF EXISTS ${tmp}`);
      throw new Error(
        `vec migration ${vecTable(ns)}: copied ${migCount}/${srcCount} rows; aborting `
        + 'with the original intact (re-embed via `myco rebuild` if this persists)',
      );
    }

    // 3. Swap: rebuild the original name from the verified copy, then drop temp.
    const swap = this.db.transaction(() => {
      this.db.run(`DROP TABLE ${vecTable(ns)}`);
      this.db.exec(vecTableDDL(vecTable(ns)));
      this.db.run(`INSERT INTO ${vecTable(ns)}(${cols}) SELECT ${cols} FROM ${tmp}`);
      this.db.run(`DROP TABLE ${tmp}`);
    });
    swap();
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
      const insertCols = vecInsertColumns();
      this.insertVecStmts.set(
        ns,
        this.db.prepare(
          `INSERT INTO vec_${ns}(${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`,
        )
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
    // Project partition + metadata columns from domain_metadata so the KNN can
    // filter on them in-traversal (see the filterable-key registry).
    const { partitionValues, columnValues } = vecColumnValues(
      metadata?.['domain_metadata'] as Record<string, unknown> | undefined,
    );

    const txn = this.db.transaction(() => {
      // Delete-then-insert for vec0 (INSERT OR REPLACE not fully supported)
      this.deleteVecStmts.get(ns)!.run(id);
      this.insertVecStmts.get(ns)!.run(id, ...partitionValues, vec, ...columnValues);

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
      const rows = hasFilters
        ? this.filteredKnn(ns, options!.filters!, limit, queryVec)
        : (this.searchStmts.get(ns)!.all(queryVec, limit) as Array<Record<string, unknown>>);

      for (const row of rows) {
        const similarity = cosineDistanceToSimilarity(row.distance as number);
        if (similarity >= threshold) results.push(toSearchResult(row, ns, similarity));
      }
    }

    // Sort by similarity DESC across all namespaces, then truncate to limit
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * Run a filtered KNN. In-KNN filters (partition + metadata columns) narrow
   * the traversal; post-KNN filters (`json_extract` over `domain_metadata`)
   * run on the joined rows afterward. When post-KNN filters are present the
   * candidate pool is over-fetched; and if it still under-fills `limit` while
   * the KNN pool remains CAPPED (a `COUNT(*)` of candidates equals `k`, so more
   * matches may lie deeper), `k` is widened and the query re-run — up to
   * {@link POST_KNN_MAX_OVERFETCH_FACTOR}× — so a selective post-KNN filter
   * cannot silently return fewer rows than exist. Widening stops as soon as the
   * candidate pool is exhausted (`< k`), which is the true "fewer than limit"
   * answer.
   */
  private filteredKnn(
    ns: EmbeddableNamespace,
    filters: Record<string, unknown>,
    limit: number,
    queryVec: Float32Array,
  ): Array<Record<string, unknown>> {
    const build = this.buildFilteredSearchQuery(ns, filters);
    const run = (k: number) =>
      this.prepareCached(build.sql).all(queryVec, k, ...build.knnParams, ...build.postParams) as Array<Record<string, unknown>>;

    if (!build.hasPostFilter) return run(limit); // in-KNN-only: top-k IS top-k-of-matching

    const maxK = limit * POST_KNN_MAX_OVERFETCH_FACTOR;
    let k = limit * POST_KNN_OVERFETCH_FACTOR;
    let rows = run(k);
    while (rows.length < limit && k < maxK) {
      const { n } = this.prepareCached(build.candidateSql).get(queryVec, k, ...build.knnParams) as { n: number };
      if (n < k) break; // candidate pool exhausted — this IS the full match set
      k = Math.min(k * 2, maxK);
      rows = run(k);
    }
    return rows;
  }

  /** Prepared-statement cache for filtered/candidate queries, keyed by SQL text
   *  (the SQL is deterministic per filter-key shape; `k` and values are binds). */
  private prepareCached(sql: string): Statement {
    let stmt = this.filteredStmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.filteredStmtCache.set(sql, stmt);
    }
    return stmt;
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
   * Build the SQL for a filtered KNN. Filters route via the registry:
   *
   *   - **In-KNN** — equality on a promoted partition/metadata column. Applied
   *     inside the KNN CTE on the vec0 table, so the traversal returns the
   *     top-`k` OF MATCHING rows (the over-truncation cure). Range ops fall
   *     through to post-KNN: promoted columns are equality-only, and
   *     `json_extract` gives the correct NULL semantics for ranges that the
   *     `''` sentinel would not.
   *   - **Post-KNN** — every other recognized domain key (ranges, patched, and
   *     long-string keys), applied as `json_extract` conditions on the joined
   *     `embedding_metadata` after the KNN. The caller over-fetches `k` (and
   *     widens on under-fill) so these can't silently truncate.
   *
   * `k` is bound by the caller (a `?`), so one prepared statement serves every
   * over-fetch width. Returns the main query, a candidate-count query (the KNN
   * pool size at `k`, used to detect a capped pool for fail-loud widening), and
   * the param lists for each.
   */
  private buildFilteredSearchQuery(
    namespace: EmbeddableNamespace,
    filters: Record<string, unknown>,
  ): {
    sql: string;
    candidateSql: string;
    knnParams: unknown[];
    postParams: unknown[];
    hasPostFilter: boolean;
  } {
    const knnConditions: string[] = [];
    const knnParams: unknown[] = [];
    const postConditions: string[] = [];
    const postParams: unknown[] = [];

    for (const [key, value] of Object.entries(filters)) {
      // Range suffixes (_gte/_lte/…) map to comparison operators on the base key.
      let baseKey = key;
      let operator = '=';
      for (const [suffix, sqlOperator] of Object.entries(FILTER_SUFFIX_TO_OPERATOR)) {
        if (key.endsWith(suffix)) {
          baseKey = key.slice(0, -suffix.length);
          operator = sqlOperator;
          break;
        }
      }

      if (operator === '=' && VECTOR_INDEXED_KEYS.has(baseKey)) {
        knnConditions.push(`${baseKey} = ?`);
        knnParams.push(value);
      } else if (FILTERABLE_COLUMNS.has(key)) {
        // `embedding_metadata` columns (model/provider/namespace) — post-KNN.
        postConditions.push(`em.${key} = ?`);
        postParams.push(value);
      } else if (FILTERABLE_DOMAIN_KEYS.has(baseKey)) {
        postConditions.push(`json_extract(em.domain_metadata, '$.${baseKey}') ${operator} ?`);
        postParams.push(value);
      }
    }

    const knnWhere = knnConditions.length > 0 ? `AND ${knnConditions.join(' AND ')}` : '';
    const postWhere = postConditions.length > 0 ? `WHERE ${postConditions.join(' AND ')}` : '';
    const knnCte = `
      SELECT record_id, distance
      FROM vec_${namespace}
      WHERE embedding MATCH ?
        AND k = ?
        ${knnWhere}
      ORDER BY distance`;

    const sql = `
      WITH knn AS (${knnCte})
      SELECT knn.record_id, knn.distance,
             em.model, em.provider, em.content_hash, em.embedded_at, em.domain_metadata,
             hs.dist_mean, hs.dist_std
      FROM knn
      INNER JOIN embedding_metadata em
        ON em.namespace = '${namespace}' AND em.record_id = knn.record_id
      LEFT JOIN hubness_stats hs
        ON hs.namespace = '${namespace}' AND hs.record_id = knn.record_id
      ${postWhere}
    `;
    const candidateSql = `SELECT COUNT(*) AS n FROM (${knnCte})`;

    return { sql, candidateSql, knnParams, postParams, hasPostFilter: postConditions.length > 0 };
  }
}
