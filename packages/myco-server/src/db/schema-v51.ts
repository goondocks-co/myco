/**
 * Schema v51: a spore vector the vector store never returns is written again, a bounded number of times (#1436).
 *
 * `embedding_receipts.rewrites` counts the times spore calibration sends a receipt's vector back through the embedding
 * write path, each when the vector store still does not return it `VECTOR_LOST_MS` after its write. While it is above
 * zero the spore is left out of calibration, which proceeds over the spores whose vectors the store returns; it drops
 * back to zero when the store returns the vector and the spore joins. The reads that find such receipts join the
 * current sources and use `idx_embedding_receipts_source`, so the column carries no index of its own.
 *
 * `embedding_cursors.hubness_probe` is the last left-out spore vector, among those no longer written again, that
 * calibration looked for; the next look starts after it, so each one is looked for in turn.
 */
export const V51_STATEMENTS: readonly string[] = [
  `ALTER TABLE embedding_receipts ADD COLUMN rewrites INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE embedding_cursors ADD COLUMN hubness_probe TEXT`,
];
