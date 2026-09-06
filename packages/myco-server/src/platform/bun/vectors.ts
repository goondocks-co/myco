import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { load } from 'sqlite-vec';
import { PROJECT_ID_GRAMMAR } from '../../db/project-id.js';
import { normalizedVector, validateStoredVectors, validateVectorReferences, validateVectorQuery, type StoredVector, type VectorMetadata, type VectorStore } from '../../core/embedding/vectors.js';

interface Row { id: string; embedding: Uint8Array; metadata_json: string }
const encode = (values: number[]): Uint8Array => new Uint8Array(new Float32Array(normalizedVector(values)).buffer);
const decode = (row: Row): StoredVector => ({
  id: row.id,
  values: Array.from(new Float32Array(row.embedding.slice().buffer)),
  metadata: JSON.parse(row.metadata_json) as VectorMetadata,
});

/** sqlite-vec ranks the filtered partition using native cosine distance. */
export function sqliteVectorStore(sqlite: Database): VectorStore {
  let initialized = false;
  const initialize = (): void => {
    if (initialized) return;
    load(sqlite);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS local_vectors (
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), model_key TEXT NOT NULL, id TEXT NOT NULL,
      embedding BLOB NOT NULL, metadata_json TEXT NOT NULL,
      PRIMARY KEY (project_id, model_key, id)
    )`);
    initialized = true;
  };
  return {
    async upsert(scope, vectors) {
      if (vectors.length === 0) return;
      await validateStoredVectors(scope, vectors);
      const encoded = vectors.map((v) => ({ ...v, embedding: encode(v.values) }));
      initialize();
      const insert = sqlite.query(`INSERT INTO local_vectors(project_id, model_key, id, embedding, metadata_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, model_key, id) DO UPDATE SET embedding=excluded.embedding, metadata_json=excluded.metadata_json`);
      sqlite.transaction(() => {
        for (const v of encoded) insert.run(scope.projectId, scope.modelKey, v.id, v.embedding, JSON.stringify(v.metadata));
      })();
    },
    async query(scope, query) {
      validateVectorQuery(query);
      const params: SQLQueryBindings[] = [encode(query.values), scope.projectId, scope.modelKey];
      const where = ['project_id = ?', 'model_key = ?'];
      for (const [key, value] of Object.entries(query.filters ?? {})) {
        const field = `json_extract(metadata_json, '$.${key}')`;
        if (typeof value === 'string') { where.push(`${field} = ?`); params.push(value); }
        else {
          if (value.gte !== undefined) { where.push(`${field} >= ?`); params.push(value.gte); }
          if (value.lte !== undefined) { where.push(`${field} <= ?`); params.push(value.lte); }
        }
      }
      params.push(query.minScore ?? -1, query.topK);
      initialize();
      return sqlite.query<{ id: string; score: number }, SQLQueryBindings[]>(`SELECT id, 1 - vec_distance_cosine(embedding, ?) AS score
        FROM local_vectors WHERE ${where.join(' AND ')} AND score >= ? ORDER BY score DESC, id LIMIT ?`).all(...params);
    },
    async get(scope, ids) {
      if (ids.length === 0) return [];
      initialize();
      return sqlite.query<Row, SQLQueryBindings[]>(`SELECT id, embedding, metadata_json FROM local_vectors
        WHERE project_id = ? AND model_key = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .all(scope.projectId, scope.modelKey, ...ids).map(decode);
    },
    async delete(scope, references) {
      if (references.length === 0) return;
      await validateVectorReferences(scope, references);
      initialize();
      const remove = sqlite.query('DELETE FROM local_vectors WHERE project_id = ? AND model_key = ? AND id = ?');
      sqlite.transaction(() => { for (const { id } of references) remove.run(scope.projectId, scope.modelKey, id); })();
    },
  };
}
