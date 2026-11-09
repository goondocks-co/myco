import { eligibleEmbeddingSource } from '../embedding-sources.js';
import { write } from '../index.js';
import { changed, jsonKeys, trigger, type Trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * Where one current source stands under one active model, read from its receipt for the source's current revision:
 * `unwritten` (no receipt), `journaled` (written, not yet confirmed), `rewriting` (written again after the vector store
 * did not return it), `ready` (indexed) or `unavailable` (its receipt is claimed for deletion; it is written afresh
 * once retired). Passed-over sources are not a state here: `embedding_passed_over` alone holds them.
 */
export const SOURCE_STATES = ['unwritten', 'journaled', 'rewriting', 'ready', 'unavailable'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

const stateOf = `COALESCE((SELECT CASE WHEN r.ready<0 THEN 'unavailable' WHEN r.ready=1 THEN 'ready' WHEN r.rewrites>0 THEN 'rewriting' ELSE 'journaled' END
    FROM embedding_receipts r WHERE r.project_id=v.project_id AND r.model_key=k.model_key AND r.type=v.type AND r.record_id=v.record_id AND r.revision=v.revision
    ORDER BY r.ready DESC LIMIT 1),'unwritten')`;

/**
 * Re-derive the absolute state of the source keys `keys` (columns `project_id,type,record_id`) under every active model
 * of their Project: a key whose version is gone, ineligible, or whose model is no longer active loses its row; every
 * other key holds exactly one row per active model. Replaying it, or interleaving it with triggers, never double-counts.
 */
function reconcileSourceState(keys: string): string[] {
  return [
    `DELETE FROM embedding_source_state WHERE (project_id,model_key,type,record_id) IN
      (SELECT key.project_id,m.model_key,key.type,key.record_id FROM (${keys}) key JOIN embedding_models m ON m.project_id=key.project_id)
      AND NOT EXISTS (SELECT 1 FROM embedding_versions v JOIN embedding_models k ON k.project_id=v.project_id AND k.model_key=embedding_source_state.model_key AND k.active=1
        WHERE v.project_id=embedding_source_state.project_id AND v.type=embedding_source_state.type AND v.record_id=embedding_source_state.record_id
          AND ${eligibleEmbeddingSource('v')})`,
    `INSERT INTO embedding_source_state(project_id,model_key,type,record_id,revision,state)
      SELECT v.project_id,k.model_key,v.type,v.record_id,v.revision,${stateOf}
      FROM (${keys}) key JOIN embedding_versions v ON v.project_id=key.project_id AND v.type=key.type AND v.record_id=key.record_id
        JOIN embedding_models k ON k.project_id=v.project_id AND k.active=1
      WHERE ${eligibleEmbeddingSource('v')}
      ON CONFLICT(project_id,model_key,type,record_id) DO UPDATE SET revision=excluded.revision,state=excluded.state
        WHERE (embedding_source_state.revision,embedding_source_state.state) IS NOT (excluded.revision,excluded.state)`,
  ];
}

/**
 * Re-derive whether the source keys `keys` are current eligible sources, model-independently: one presence row per
 * eligible source, so whether a Project holds anything to embed is one key seek, whatever its ineligible history.
 */
function reconcileEligibleSources(keys: string): string[] {
  return [
    `DELETE FROM embedding_eligible_sources WHERE (project_id,type,record_id) IN (SELECT project_id,type,record_id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM embedding_versions v WHERE v.project_id=embedding_eligible_sources.project_id AND v.type=embedding_eligible_sources.type
        AND v.record_id=embedding_eligible_sources.record_id AND ${eligibleEmbeddingSource('v')})`,
    `INSERT INTO embedding_eligible_sources(project_id,type,record_id)
      SELECT v.project_id,v.type,v.record_id FROM (${keys}) key JOIN embedding_versions v ON v.project_id=key.project_id AND v.type=key.type AND v.record_id=key.record_id
      WHERE ${eligibleEmbeddingSource('v')} ON CONFLICT(project_id,type,record_id) DO NOTHING`,
  ];
}

/** A key's source state and its eligibility together: what version and plan-proof changes reconcile. */
const reconcileSource = (keys: string): string[] => [...reconcileSourceState(keys), ...reconcileEligibleSources(keys)];

const rowKey = (row: string, type = `${row}.type`, id = `${row}.record_id`) =>
  `SELECT ${row}.project_id AS project_id,${type} AS type,${id} AS record_id`;

/** The source keys carried as one JSON array of `[project_id, type, record_id]`. */
const SOURCE_STATE_KEYS = jsonKeys(['project_id', 'type', 'record_id']);

/** One catch-up page: the keys' current state under every active model, read inside the caller's commit. */
export const SOURCE_STATE_RECONCILE = reconcileSource(SOURCE_STATE_KEYS)
  .map((sql, i) => write<[string]>({ name: `embedding.sourceStatePage${i}`, sql }));
export const SOURCE_STATE_CATCHUP = {
  projection: 'embedding_state',
  phases: { versions: { source: { table: 'embedding_versions', columns: ['project_id', 'type', 'record_id'] }, reconcile: SOURCE_STATE_RECONCILE } },
} as const satisfies CatchupFamily;

/**
 * The triggers that keep `embedding_source_state` and `embedding_model_totals` current: version, receipt and plan proof
 * mutations reconcile only the one source key they name, and each state row moves its model total by `-old +new`.
 */
export function sourceStateTriggers(): Trigger[] {
  const versionKey = ['project_id', 'type', 'record_id'];
  const receiptColumns = ['project_id', 'model_key', 'type', 'record_id', 'revision', 'ready', 'rewrites'];
  const proofColumns = ['project_id', 'kind', 'resource_id', 'blob_key', 'classification'];
  const proof = (row: string) => rowKey(row, "'plan'", `${row}.resource_id`) + ` WHERE ${row}.kind='plan'`;
  const total = (row: string, delta: '+1' | '-1') => `INSERT INTO embedding_model_totals(project_id,model_key,state,n) VALUES(${row}.project_id,${row}.model_key,${row}.state,${delta === '+1' ? 1 : -1})
      ON CONFLICT(project_id,model_key,state) DO UPDATE SET n=n${delta}`;
  return [
    trigger('embedding_state_version_insert', 'embedding_versions', 'INSERT', reconcileSource(rowKey('NEW'))),
    trigger('embedding_state_version_update', 'embedding_versions', `UPDATE OF ${[...versionKey, 'revision'].join(',')}`, [...reconcileSource(rowKey('OLD')), ...reconcileSource(rowKey('NEW'))], changed([...versionKey, 'revision'])),
    trigger('embedding_state_version_delete', 'embedding_versions', 'DELETE', reconcileSource(rowKey('OLD'))),
    trigger('embedding_state_receipt_insert', 'embedding_receipts', 'INSERT', reconcileSourceState(rowKey('NEW'))),
    trigger('embedding_state_receipt_update', 'embedding_receipts', `UPDATE OF ${receiptColumns.join(',')}`, [...reconcileSourceState(rowKey('OLD')), ...reconcileSourceState(rowKey('NEW'))], changed(receiptColumns)),
    trigger('embedding_state_receipt_delete', 'embedding_receipts', 'DELETE', reconcileSourceState(rowKey('OLD'))),
    trigger('embedding_state_proof_insert', 'processed_resources', 'INSERT', reconcileSource(proof('NEW')), "NEW.kind='plan'"),
    trigger('embedding_state_proof_update', 'processed_resources', `UPDATE OF ${proofColumns.join(',')}`, [...reconcileSource(proof('OLD')), ...reconcileSource(proof('NEW'))], `(OLD.kind='plan' OR NEW.kind='plan') AND (${changed(proofColumns)})`),
    trigger('embedding_state_proof_delete', 'processed_resources', 'DELETE', reconcileSource(proof('OLD')), "OLD.kind='plan'"),
    trigger('embedding_model_totals_insert', 'embedding_source_state', 'INSERT', [total('NEW', '+1')]),
    trigger('embedding_model_totals_update', 'embedding_source_state', 'UPDATE OF state', [total('OLD', '-1'), total('NEW', '+1')], 'OLD.state IS NOT NEW.state'),
    trigger('embedding_model_totals_delete', 'embedding_source_state', 'DELETE', [total('OLD', '-1')]),
  ];
}

