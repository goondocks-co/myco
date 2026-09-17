/**
 * Which catalogued backups retention lets go of, under the Deployment's current policy.
 *
 * One owner decides it for every caller: the prune after a backup is created, and the release of backups a recovery
 * hold kept. The policy is read from the settings leaves each time it is asked, so a decision made after the policy
 * changed follows the policy in force.
 */
import type { RelationalStore } from './adapters.js';
import { leafValues } from './settings.js';

export const KEEP_DAILY_DEFAULT = 14;
export const KEEP_WEEKLY_DEFAULT = 8;

export interface BackupRetentionPolicy { keepDaily: number; keepWeekly: number }

/** A catalogued backup as retention reads it. */
export interface RetainedBackup { id: string; created_at: number; pinned: number }

const leafNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  } catch { return fallback; }
};

/** The retention policy the settings leaves hold now, with the defaults for a leaf never written. */
export async function backupRetentionPolicy(db: RelationalStore): Promise<BackupRetentionPolicy> {
  const leaves = await leafValues(db, ['backup.retention.keep_daily', 'backup.retention.keep_weekly']);
  return {
    keepDaily: leafNumber(leaves.get('backup.retention.keep_daily'), KEEP_DAILY_DEFAULT),
    keepWeekly: leafNumber(leaves.get('backup.retention.keep_weekly'), KEEP_WEEKLY_DEFAULT),
  };
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

/**
 * The ids of every catalogued backup retention lets go of under `policy`, read from the index as it stands. A policy
 * keeping no daily backup is retention turned off: it lets go of nothing.
 */
export async function currentRetentionVictims(db: RelationalStore, policy: BackupRetentionPolicy): Promise<Set<string>> {
  if (policy.keepDaily < 1) return new Set();
  const { results } = await db.prepare(`SELECT id, created_at, pinned FROM backups`).all<RetainedBackup>();
  return new Set(retentionVictims(results, policy.keepDaily, policy.keepWeekly).map((row) => row.id));
}
