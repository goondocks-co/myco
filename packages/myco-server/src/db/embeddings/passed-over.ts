import { eligibleEmbeddingSource } from '../embedding-sources.js';
import { INPUT_REFUSAL_RETRY_MS } from '../embedding-due.js';
import { write } from '../index.js';

export const PASSED_OVER_KEYS = `SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS type,
  json_extract(value,'$[2]') AS record_id,json_extract(value,'$[3]') AS model_key FROM json_each(?1)`;

export function reconcilePassedOver(keys: string): string[] {
  const eligible = `SELECT f.* FROM (${keys}) k JOIN embedding_source_failures f
    ON (f.project_id,f.type,f.record_id,f.model_key)=(k.project_id,k.type,k.record_id,k.model_key)
    JOIN embedding_versions v ON (v.project_id,v.type,v.record_id)=(f.project_id,f.type,f.record_id)
    WHERE f.revision=v.revision AND ${eligibleEmbeddingSource('v')}`;
  return [
    `DELETE FROM embedding_passed_over WHERE (project_id,type,record_id,model_key) IN (SELECT project_id,type,record_id,model_key FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM (${eligible}) f WHERE (f.project_id,f.type,f.record_id,f.model_key)=(embedding_passed_over.project_id,embedding_passed_over.type,embedding_passed_over.record_id,embedding_passed_over.model_key))`,
    `INSERT INTO embedding_passed_over(project_id,type,record_id,model_key,revision,reason,recorded_at,expires_at)
      SELECT project_id,type,record_id,model_key,revision,reason,recorded_at,CASE WHEN model_key='' THEN NULL ELSE recorded_at+${INPUT_REFUSAL_RETRY_MS} END FROM (${eligible}) WHERE true
      ON CONFLICT(project_id,type,record_id,model_key) DO UPDATE SET revision=excluded.revision,reason=excluded.reason,recorded_at=excluded.recorded_at,expires_at=excluded.expires_at
      WHERE (embedding_passed_over.revision,embedding_passed_over.reason,embedding_passed_over.recorded_at,embedding_passed_over.expires_at)
        IS NOT (excluded.revision,excluded.reason,excluded.recorded_at,excluded.expires_at)`,
  ];
}

export function passedOverTriggers(): Array<{ name: string; table: string; sql: string }> {
  const keys = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.type AS type,${row}.record_id AS record_id,${row}.model_key AS model_key`;
  const trigger = (name: string, table: string, event: string, body: string) => ({
    name, table, sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} BEGIN ${body}; END`,
  });
  return [
    ...['INSERT', 'UPDATE'].map(event => trigger(`passed_over_failure_${event.toLowerCase()}`, 'embedding_source_failures', event,
      (event === 'UPDATE' ? [`DELETE FROM embedding_passed_over WHERE (project_id,type,record_id,model_key)=(OLD.project_id,OLD.type,OLD.record_id,OLD.model_key)
        AND (OLD.project_id,OLD.type,OLD.record_id,OLD.model_key) IS NOT (NEW.project_id,NEW.type,NEW.record_id,NEW.model_key)`] : []).concat(reconcilePassedOver(keys('NEW'))).join('; '))),
    trigger('passed_over_failure_delete', 'embedding_source_failures', 'DELETE', 'DELETE FROM embedding_passed_over WHERE (project_id,type,record_id,model_key)=(OLD.project_id,OLD.type,OLD.record_id,OLD.model_key)'),
    trigger('passed_over_version_insert', 'embedding_versions', 'INSERT', reconcilePassedOver(
      'SELECT project_id,type,record_id,model_key FROM embedding_source_failures WHERE (project_id,type,record_id)=(NEW.project_id,NEW.type,NEW.record_id)').join('; ')),
    ...['INSERT','UPDATE','DELETE'].map(event => trigger(`passed_over_proof_${event.toLowerCase()}`, 'processed_resources', event,
      (event === 'INSERT' ? ['NEW'] : event === 'DELETE' ? ['OLD'] : ['OLD','NEW']).flatMap(row => reconcilePassedOver(
        `SELECT project_id,type,record_id,model_key FROM embedding_source_failures WHERE ${row}.kind='plan' AND project_id=${row}.project_id AND type='plan' AND record_id=${row}.resource_id`)).join('; '))),
    trigger('passed_over_version_update', 'embedding_versions', 'UPDATE OF revision', 'DELETE FROM embedding_passed_over WHERE (project_id,type,record_id)=(NEW.project_id,NEW.type,NEW.record_id) AND revision<>NEW.revision'),
    trigger('passed_over_version_delete', 'embedding_versions', 'DELETE', 'DELETE FROM embedding_passed_over WHERE (project_id,type,record_id)=(OLD.project_id,OLD.type,OLD.record_id)'),
  ];
}
/**
 * Current passed-over membership under the model keys `models` (a JSON array SQL expression) at the instant `now`:
 * every row no model can read, and each model's rows whose refusal has not expired, sought by model and deadline so
 * an expired refusal is never read. `project` narrows both seeks to one Project.
 */
export function currentPassedOver(models: string, now: string, project?: string): string {
  if (project !== undefined) {
    return `SELECT * FROM embedding_passed_over INDEXED BY idx_embedding_passed_over_current WHERE project_id=${project} AND model_key=''
      UNION ALL SELECT * FROM embedding_passed_over INDEXED BY idx_embedding_passed_over_current
        WHERE project_id=${project} AND model_key IN (SELECT value FROM json_each(${models}) WHERE value<>'') AND expires_at>${now}`;
  }
  return `SELECT * FROM embedding_passed_over INDEXED BY idx_embedding_passed_over_model WHERE model_key=''
    UNION ALL SELECT * FROM embedding_passed_over INDEXED BY idx_embedding_passed_over_model
      WHERE model_key IN (SELECT value FROM json_each(${models}) WHERE value<>'') AND recorded_at>${now}-${INPUT_REFUSAL_RETRY_MS}`;
}

export const PASSED_OVER_RECONCILE = reconcilePassedOver(PASSED_OVER_KEYS).map((sql, i) => write<[string]>({ name: `embedding.passedOverPage${i}`, sql }));
