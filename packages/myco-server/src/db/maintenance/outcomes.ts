/**
 * The latest outcome of each store check, one row per check. A check is the only way to name a row, so no caller can
 * reach any other key, and every decision reads a RETURNING row or an in-batch assertion.
 */
import type { RelationalStore } from '../../core/adapters.js';
import type { MaintenanceCheck, MaintenanceOutcome } from '../../core/store-maintenance.js';
import { assertion, commit, read, readSet, write } from '../index.js';

const OUTCOME_KEY: Readonly<Record<MaintenanceCheck, string>> = { optimize: 'maintenance.optimize', integrity: 'maintenance.integrity' };

const stored = read<[key: string], { value: string }>({ name: 'maintenance.outcome', sql: 'SELECT value FROM schema_meta WHERE key=?1' });
const claim = write<[key: string, record: string, bounded: number, claimedAt: number, notBefore: number | null], { value: string }>({
  name: 'maintenance.claimOutcome',
  sql: `INSERT OR REPLACE INTO schema_meta(key,value) SELECT ?1,?2 WHERE NOT EXISTS(SELECT 1 FROM schema_meta WHERE key=?1 AND (
      (?3=1 AND json_extract(value,'$.state')='running' AND CAST(json_extract(value,'$.claimExpiresAt') AS INTEGER)>?4)
      OR (?5 IS NOT NULL AND CAST(json_extract(value,'$.startedAt') AS INTEGER)>?5)))
    RETURNING value`,
});
const held = assertion<[key: string, runId: string, at: number]>({
  name: 'maintenance.progressHeld',
  sql: `SELECT CASE WHEN EXISTS(SELECT 1 FROM schema_meta WHERE key=?1 AND json_extract(value,'$.runId')=?2
      AND json_extract(value,'$.state')='running'
      AND (json_extract(value,'$.claimExpiresAt') IS NULL OR json_extract(value,'$.claimExpiresAt')>?3))
    THEN 1 ELSE json_extract('[]','$[maintenance_claim_lost]') END`,
});
const replace = write<[record: string, key: string, runId: string], { key: string }>({
  name: 'maintenance.replaceOwnOutcome',
  sql: `UPDATE schema_meta SET value=?1 WHERE key=?2 AND json_extract(value,'$.runId')=?3 RETURNING key`,
});

/** The stored outcome text of one check, or null when it never ran. */
export async function maintenanceOutcomeText(db: RelationalStore, check: MaintenanceCheck): Promise<string | null> {
  const [[row]] = await readSet(db, stored.bind(OUTCOME_KEY[check]));
  return row?.value ?? null;
}

export interface MaintenanceClaim {
  /** Refuse while a running record's bound has not passed. */
  bounded: boolean;
  claimedAt: number;
  /** Refuse while the last run started after this instant; null skips the cadence. */
  notBefore: number | null;
}

/** Writes a new run's record unless a holder or the cadence blocks it. Answers whether this run holds the record. */
export async function claimMaintenanceOutcome(db: RelationalStore, record: MaintenanceOutcome, gate: MaintenanceClaim): Promise<boolean> {
  const [claimed] = await commit(db, claim.bind(OUTCOME_KEY[record.check], JSON.stringify(record), gate.bounded ? 1 : 0, gate.claimedAt, gate.notBefore));
  return claimed.results.length === 1;
}

/** Records a checkpoint, refused with `maintenance_claim_lost` once this run no longer holds a live claim. */
export async function recordMaintenanceProgress(db: RelationalStore, record: MaintenanceOutcome, now: number): Promise<void> {
  const key = OUTCOME_KEY[record.check];
  await commit(db, held.bind(key, record.runId, now), replace.bind(JSON.stringify(record), key, record.runId));
}

/** Records a finished run, only over the record that run created. Answers whether it landed. */
export async function completeMaintenanceOutcome(db: RelationalStore, record: MaintenanceOutcome): Promise<boolean> {
  const [replaced] = await commit(db, replace.bind(JSON.stringify(record), OUTCOME_KEY[record.check], record.runId));
  return replaced.results.length === 1;
}
