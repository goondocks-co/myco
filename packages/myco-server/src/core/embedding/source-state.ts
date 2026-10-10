import { CURRENT_EMBEDDING_SOURCES } from '../../db/embedding-sources.js';
import { RECEIPT } from './receipt-state.js';

/** A version's source is eligible, read through the source table's identity index. */
export const eligibleSource = (row: string): string => `(${CURRENT_EMBEDDING_SOURCES.map((source) =>
  `(${row}.type = '${source.type}' AND EXISTS (SELECT 1 FROM ${source.table}
    WHERE project_id = ${row}.project_id AND ${source.id} = ${row}.record_id AND (${source.eligible})))`).join(' OR ')})`;

/** A receipt names an eligible source's current revision. */
export const currentSource = (row: string): string => `EXISTS (SELECT 1 FROM embedding_versions v
  WHERE v.project_id = ${row}.project_id AND v.type = ${row}.type AND v.record_id = ${row}.record_id
    AND v.revision = ${row}.revision AND ${eligibleSource('v')})`;

/** A calibration member names a current indexed spore receipt that is included in calibration. */
export const currentHubnessMember = (row: string): string => `EXISTS (SELECT 1 FROM embedding_receipts r
  WHERE r.project_id = ${row}.project_id AND r.model_key = ${row}.model_key AND r.id = ${row}.id
    AND r.type = 'spore' AND r.ready = ${RECEIPT.ready} AND r.rewrites = 0 AND ${currentSource('r')})`;
