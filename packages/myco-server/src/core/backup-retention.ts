/**
 * Which catalogued backups retention lets go of, under the Deployment's current policy.
 *
 * One owner decides it for every caller: the prune after a backup is created, and the release of backups a recovery
 * hold kept. The policy is read from the settings leaves each time it is asked, so a decision made after the policy
 * changed follows the policy in force.
 */
import type { RelationalStore } from './adapters.js';
import { observedSettingsGuard, storedSettings } from './settings.js';
import { readRetentionIndex } from '../db/storage/backup-retention.js';

const RETENTION_LEAVES = ['backup.retention.keep_daily','backup.retention.keep_weekly'] as const;
const KEEP_DAILY_DEFAULT = 14;
const KEEP_WEEKLY_DEFAULT = 8;

interface BackupRetentionPolicy { keepDaily: number; keepWeekly: number }

/** A catalogued backup as retention reads it. */
interface RetainedBackup { id: string; created_at: number; pinned: number }

/** The retention policy the settings leaves hold now, with the defaults for a leaf never written. */
export async function backupRetentionPolicy(db: RelationalStore): Promise<BackupRetentionPolicy> {
  const leaves = await storedSettings(db,RETENTION_LEAVES);
  if ([...leaves.values()].some(leaf=>leaf.violation!==null)) return {keepDaily:0,keepWeekly:0};
  return {keepDaily:(leaves.get(RETENTION_LEAVES[0])?.value ?? KEEP_DAILY_DEFAULT) as number,
    keepWeekly:(leaves.get(RETENTION_LEAVES[1])?.value ?? KEEP_WEEKLY_DEFAULT) as number};
}

/**
 * Which unpinned index rows retention lets go of: keep the newest `keepDaily` rows, plus the newest row of each of the
 * `keepWeekly` most recent week windows. Pinned rows are exempt and consume no slot. Pure, so the rule is testable
 * without a store.
 */
export function retentionVictims<Row extends RetainedBackup>(rows: readonly Row[], keepDaily: number, keepWeekly: number): Row[] {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const unpinned = rows.filter((r) => r.pinned === 0).sort((a, b) => b.created_at - a.created_at);
  const keep = new Set<string>(unpinned.slice(0, Math.max(0, keepDaily)).map((r) => r.id));
  const weeksKept = new Set<number>();
  for (const row of unpinned) {
    const week = Math.floor(row.created_at / WEEK_MS);
    if (weeksKept.has(week)) continue;
    if (weeksKept.size >= Math.max(0, keepWeekly)) continue;
    weeksKept.add(week);
    keep.add(row.id);
  }
  return unpinned.filter((r) => !keep.has(r.id));
}

/** Both policy revisions and complete keep-set evidence must still hold when release commits. */
export async function retentionDecision(db: RelationalStore) {
  const settings = await observedSettingsGuard(db,RETENTION_LEAVES,true);
  const observed = {rows:await readRetentionIndex(db),policyAssertion:settings.assertion};
  const policy = await backupRetentionPolicy(settings.view);
  const victims = policy.keepDaily < 1 ? new Set<string>()
    : new Set(retentionVictims(observed.rows,policy.keepDaily,policy.keepWeekly).map(row => row.id));
  return { observed, victims };
}

/** The current index victims under an explicitly supplied policy, for policy inspection. */
export async function currentRetentionVictims(db: RelationalStore, policy: BackupRetentionPolicy): Promise<Set<string>> {
  if (policy.keepDaily<1) return new Set();
  const rows = await readRetentionIndex(db);
  return new Set(retentionVictims(rows,policy.keepDaily,policy.keepWeekly).map(row=>row.id));
}
