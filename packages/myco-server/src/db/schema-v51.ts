/**
 * Schema v51: a spore vector the vector store never returns is written again, a bounded number of times (#1436).
 *
 * `embedding_receipts.rewrites` counts the times spore calibration sends a receipt's vector back through the embedding
 * write path, each when the vector store still does not return it `VECTOR_LOST_MS` after its write. While it is above zero the spore is
 * left out of calibration, which proceeds over the spores whose vectors the store returns; it drops back to zero when
 * the store returns the vector and the spore joins. The partial index serves the reads that look for such receipts.
 */
export const V51_STATEMENTS: readonly string[] = [
  `ALTER TABLE embedding_receipts ADD COLUMN rewrites INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_receipts_rewrites ON embedding_receipts(project_id, model_key, id) WHERE rewrites > 0`,
];
