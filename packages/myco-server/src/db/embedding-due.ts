import { eligibleEmbeddingSource } from './embedding-sources.js';

export const INPUT_REFUSAL_RETRY_MS = 24 * 60 * 60_000;

/** Rebuilds only the named source identities for registered models, in the source mutation's transaction. */
export function embeddingDueInsert(where: string): string {
  return `INSERT OR REPLACE INTO embedding_due(project_id,model_key,type,record_id,revision,stale,retry_at,attempted_at)
    SELECT v.project_id,k.model_key,v.type,v.record_id,v.revision,
      EXISTS(SELECT 1 FROM embedding_receipts r WHERE r.project_id=v.project_id AND r.type=v.type AND r.record_id=v.record_id),
      COALESCE((SELECT f.recorded_at+${INPUT_REFUSAL_RETRY_MS} FROM embedding_source_failures f
        WHERE f.project_id=v.project_id AND f.type=v.type AND f.record_id=v.record_id AND f.model_key=k.model_key AND f.revision=v.revision),0),v.attempted_at
    FROM embedding_versions v JOIN embedding_models k ON k.project_id=v.project_id
    WHERE k.active=1 AND ${where} AND ${eligibleEmbeddingSource('v')}
      AND NOT EXISTS(SELECT 1 FROM embedding_receipts r WHERE r.project_id=v.project_id AND r.model_key=k.model_key AND r.type=v.type
        AND r.record_id=v.record_id AND r.revision=v.revision AND r.ready<>0)
      AND NOT EXISTS(SELECT 1 FROM embedding_source_failures f WHERE f.project_id=v.project_id AND f.type=v.type
        AND f.record_id=v.record_id AND f.model_key='' AND f.revision=v.revision);`;
}

export function refreshEmbeddingDue(row: string, type = `${row}.type`, id = `${row}.record_id`): string {
  return `DELETE FROM embedding_due WHERE (project_id,model_key,type,record_id) IN
      (SELECT k.project_id,k.model_key,${type},${id} FROM embedding_models k WHERE k.project_id=${row}.project_id AND k.active=1);
    ${embeddingDueInsert(`v.project_id=${row}.project_id AND v.type=${type} AND v.record_id=${id}`)}`;
}
