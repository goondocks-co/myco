import { eligibleEmbeddingSource } from './embedding-sources.js';

/** A receipt names an eligible source's current revision. */
export const currentEmbeddingSourceSql = (row: string): string => `EXISTS (SELECT 1 FROM embedding_versions v
  WHERE v.project_id=${row}.project_id AND v.type=${row}.type AND v.record_id=${row}.record_id
    AND v.revision=${row}.revision AND ${eligibleEmbeddingSource('v')})`;

const staleReceiptSql = (row: string): string => `${row}.ready>=0 AND NOT ${currentEmbeddingSourceSql(row)}
  AND NOT EXISTS(SELECT 1 FROM embedding_models k WHERE k.project_id=${row}.project_id AND k.model_key=${row}.model_key AND k.active=0)`;

/** The affected identities retain only stale, unclaimed receipts under active or not-yet-registered models. */
export function queueRetirementSql(where: string): string {
  return `DELETE FROM embedding_retirement_queue WHERE (project_id,model_key,id) IN
    (SELECT project_id,model_key,id FROM embedding_receipts WHERE ${where});
    INSERT INTO embedding_retirement_queue(project_id,model_key,id,updated_at)
    SELECT r.project_id,r.model_key,r.id,r.updated_at FROM embedding_receipts r WHERE ${where}
      AND ${staleReceiptSql('r')};`;
}

