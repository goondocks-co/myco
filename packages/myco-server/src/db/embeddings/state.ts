import { eligibleEmbeddingSource } from '../embedding-sources.js';
import { write } from '../index.js';

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
export function reconcileSourceState(keys: string): string[] {
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
export function reconcileEligibleSources(keys: string): string[] {
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
export const SOURCE_STATE_KEYS = `SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS type,json_extract(value,'$[2]') AS record_id FROM json_each(?1)`;

/** One catch-up page: the keys' current state under every active model, read inside the caller's commit. */
export const SOURCE_STATE_RECONCILE = reconcileSource(SOURCE_STATE_KEYS)
  .map((sql, i) => write<[string]>({ name: `embedding.sourceStatePage${i}`, sql }));

/**
 * The triggers that keep `embedding_source_state` and `embedding_model_totals` current: version, receipt and plan proof
 * mutations reconcile only the one source key they name, and each state row moves its model total by `-old +new`.
 */
export function sourceStateTriggers(): Array<{ name: string; table: string; sql: string }> {
  const trigger = (name: string, table: string, event: string, when: string | null, body: string[]) => ({
    name, table, sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}${when === null ? '' : ` WHEN ${when}`} BEGIN ${body.join('; ')}; END`,
  });
  const changed = (columns: readonly string[]) => columns.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  const versionKey = ['project_id', 'type', 'record_id'];
  const receiptColumns = ['project_id', 'model_key', 'type', 'record_id', 'revision', 'ready', 'rewrites'];
  const proofColumns = ['project_id', 'kind', 'resource_id', 'blob_key', 'classification'];
  const proof = (row: string) => rowKey(row, "'plan'", `${row}.resource_id`) + ` WHERE ${row}.kind='plan'`;
  const total = (row: string, delta: '+1' | '-1') => `INSERT INTO embedding_model_totals(project_id,model_key,state,n) VALUES(${row}.project_id,${row}.model_key,${row}.state,${delta === '+1' ? 1 : -1})
      ON CONFLICT(project_id,model_key,state) DO UPDATE SET n=n${delta}`;
  return [
    trigger('embedding_state_version_insert', 'embedding_versions', 'INSERT', null, reconcileSource(rowKey('NEW'))),
    trigger('embedding_state_version_update', 'embedding_versions', `UPDATE OF ${[...versionKey, 'revision'].join(',')}`, changed([...versionKey, 'revision']),
      [...reconcileSource(rowKey('OLD')), ...reconcileSource(rowKey('NEW'))]),
    trigger('embedding_state_version_delete', 'embedding_versions', 'DELETE', null, reconcileSource(rowKey('OLD'))),
    trigger('embedding_state_receipt_insert', 'embedding_receipts', 'INSERT', null, reconcileSourceState(rowKey('NEW'))),
    trigger('embedding_state_receipt_update', 'embedding_receipts', `UPDATE OF ${receiptColumns.join(',')}`, changed(receiptColumns),
      [...reconcileSourceState(rowKey('OLD')), ...reconcileSourceState(rowKey('NEW'))]),
    trigger('embedding_state_receipt_delete', 'embedding_receipts', 'DELETE', null, reconcileSourceState(rowKey('OLD'))),
    trigger('embedding_state_proof_insert', 'processed_resources', 'INSERT', "NEW.kind='plan'", reconcileSource(proof('NEW'))),
    trigger('embedding_state_proof_update', 'processed_resources', `UPDATE OF ${proofColumns.join(',')}`, `(OLD.kind='plan' OR NEW.kind='plan') AND (${changed(proofColumns)})`,
      [...reconcileSource(proof('OLD')), ...reconcileSource(proof('NEW'))]),
    trigger('embedding_state_proof_delete', 'processed_resources', 'DELETE', "OLD.kind='plan'", reconcileSource(proof('OLD'))),
    trigger('embedding_model_totals_insert', 'embedding_source_state', 'INSERT', null, [total('NEW', '+1')]),
    trigger('embedding_model_totals_update', 'embedding_source_state', 'UPDATE OF state', 'OLD.state IS NOT NEW.state', [total('OLD', '-1'), total('NEW', '+1')]),
    trigger('embedding_model_totals_delete', 'embedding_source_state', 'DELETE', null, [total('OLD', '-1')]),
  ];
}

/**
 * The schema the source state lives in: a derived per-source row and its per-model totals; the model epoch a reset
 * advances; the Deployment's attempt clock and the attempt each receipt, failure and provider hold records; and the
 * Projects whose reset is still retiring rows recorded before it, with the generation every catch-up restart advances
 * so a page selected before a restart never settles it.
 */
export function sourceStateSchema(projectIdCheck: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS embedding_source_state(project_id TEXT NOT NULL CHECK (${projectIdCheck}),model_key TEXT NOT NULL,type TEXT NOT NULL,record_id TEXT NOT NULL,
      revision TEXT NOT NULL,state TEXT NOT NULL CHECK (state IN (${SOURCE_STATES.map(s => `'${s}'`).join(',')})),
      PRIMARY KEY(project_id,model_key,type,record_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS embedding_model_totals(project_id TEXT NOT NULL CHECK (${projectIdCheck}),model_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (${SOURCE_STATES.map(s => `'${s}'`).join(',')})),n INTEGER NOT NULL,
      PRIMARY KEY(project_id,model_key,state)) WITHOUT ROWID`,
    'ALTER TABLE embedding_models ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE embedding_provider_holds ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE embedding_receipts ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE embedding_source_failures ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE projection_catchup ADD COLUMN generation INTEGER NOT NULL DEFAULT 0',
    'CREATE TABLE IF NOT EXISTS embedding_attempt_clock(slot INTEGER PRIMARY KEY CHECK (slot=1),seq INTEGER NOT NULL)',
    'INSERT INTO embedding_attempt_clock(slot,seq) VALUES(1,0)',
    `CREATE TABLE IF NOT EXISTS embedding_eligible_sources(project_id TEXT NOT NULL CHECK (${projectIdCheck}),type TEXT NOT NULL,record_id TEXT NOT NULL,
      PRIMARY KEY(project_id,type,record_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS embedding_resets(project_id TEXT PRIMARY KEY CHECK (${projectIdCheck}),seq INTEGER NOT NULL) WITHOUT ROWID`,
  ];
}
