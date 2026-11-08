import type { RelationalStore } from '../../core/adapters.js';
import type { MaintenanceOutcome } from '../../core/store-maintenance.js';
import { assertion, commit, write } from '../index.js';
const held = assertion<[key: string, id: string, at: number]>({ name: 'meta.maintenanceProgressHeld', sql:
  `SELECT CASE WHEN EXISTS(SELECT 1 FROM schema_meta WHERE key=?1 AND json_extract(value,'$.runId')=?2
    AND json_extract(value,'$.state')='running'
    AND (json_extract(value,'$.claimExpiresAt') IS NULL OR json_extract(value,'$.claimExpiresAt')>?3))
    THEN 1 ELSE json_extract('[]','$[maintenance_claim_lost]') END` });
const put = write<[value: string, key: string, id: string], { key: string }>({ name: 'meta.completeMaintenance', sql:
  `UPDATE schema_meta SET value=? WHERE key=? AND json_extract(value,'$.runId')=? RETURNING key` });
export async function recordMaintenanceProgress(db: RelationalStore, key: string, record: MaintenanceOutcome, now: number) {
  await commit(db,held.bind(key,record.runId,now),put.bind(JSON.stringify(record),key,record.runId));
}
export async function completeMaintenance(db: RelationalStore, key: string, record: MaintenanceOutcome) {
  const [result] = await commit(db,put.bind(JSON.stringify(record),key,record.runId)); return result.results.length===1;
}
