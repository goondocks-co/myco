import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export interface VectorSearchResult {
  id: string;
  similarity: number;
  metadata: Record<string, string>;
}

export interface VectorSearchOptions {
  limit?: number;
  /** Drop results below this fraction of the top result's score (0-1). Default 0.5. */
  relativeThreshold?: number;
  type?: string;
  importance?: string;
}

export class VectorIndex {
  private db: Database.Database;
  private dimensions: number;

  constructor(dbPath: string, dimensions: number) {
    this.dimensions = dimensions;
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_metadata (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT '',
        importance TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}]
      );
    `);
  }

  upsert(id: string, embedding: number[], metadata: Record<string, string> = {}): void {
    this.db.prepare('DELETE FROM vec_metadata WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM vec_embeddings WHERE id = ?').run(id);

    this.db.prepare(
      'INSERT INTO vec_metadata (id, type, importance, session_id, file_path, branch) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, metadata.type ?? '', metadata.importance ?? '', metadata.session_id ?? '', metadata.file_path ?? '', metadata.branch ?? '');

    this.db.prepare('INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)').run(id, new Float32Array(embedding));
  }

  search(query: number[], options: VectorSearchOptions = {}): VectorSearchResult[] {
    const limit = options.limit ?? 10;

    // vec0 KNN queries require LIMIT to be a direct constraint on the virtual table.
    // JOINs with additional WHERE filters confuse the query planner, so we use a
    // subquery to get KNN candidates first, then filter by metadata in the outer query.
    const knnParams: unknown[] = [new Float32Array(query), limit * 4];
    const knnRows = this.db.prepare(`
      SELECT id, distance
      FROM vec_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(...knnParams) as Array<{ id: string; distance: number }>;

    if (knnRows.length === 0) return [];

    // Now fetch metadata for the candidates and apply optional filters
    const metaConditions: string[] = ['id IN (' + knnRows.map(() => '?').join(',') + ')'];
    const metaParams: unknown[] = knnRows.map((r) => r.id);

    if (options.type) { metaConditions.push('type = ?'); metaParams.push(options.type); }
    if (options.importance) { metaConditions.push('importance = ?'); metaParams.push(options.importance); }

    const metaRows = this.db.prepare(`
      SELECT id, type, importance, session_id, file_path, branch
      FROM vec_metadata
      WHERE ${metaConditions.join(' AND ')}
    `).all(...metaParams) as Array<{ id: string; type: string; importance: string; session_id: string; file_path: string; branch: string }>;

    const metaMap = new Map(metaRows.map((m) => [m.id, m]));

    const scored = knnRows
      .filter((r) => metaMap.has(r.id))
      .map((r) => {
        const m = metaMap.get(r.id)!;
        return {
          id: r.id,
          similarity: 1 - r.distance,
          metadata: { type: m.type, importance: m.importance, session_id: m.session_id, file_path: m.file_path, branch: m.branch },
        };
      });

    if (scored.length === 0) return [];

    // Relative threshold: drop results below a fraction of the best score.
    // Adapts automatically to any embedding model's score distribution.
    const topScore = scored[0].similarity;
    const threshold = options.relativeThreshold ?? 0.5;
    const floor = topScore * threshold;

    return scored
      .filter((r) => r.similarity >= floor)
      .slice(0, limit);
  }

  /** Retrieve the stored embedding for a given ID, or null if not found. */
  getEmbedding(id: string): number[] | null {
    const row = this.db.prepare('SELECT embedding FROM vec_embeddings WHERE id = ?').get(id) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
  }

  /** Check whether an embedding exists for the given ID. */
  has(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM vec_metadata WHERE id = ?').get(id);
    return row !== undefined;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM vec_metadata WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM vec_embeddings WHERE id = ?').run(id);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM vec_metadata').get() as { c: number }).c;
  }

  close(): void { this.db.close(); }
}
