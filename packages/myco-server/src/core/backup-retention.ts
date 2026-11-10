/**
 * Which catalogued backups retention lets go of, under the Deployment's current policy.
 *
 * One owner decides it for every caller: the prune after a backup is created, a drain continuing a pass, and the release
 * of backups a recovery hold kept. The policy is read from the settings leaves each time it is asked, so a decision made
 * after the policy changed follows the policy in force. A page of victims is chosen from week heads and the newest rows,
 * never from every backup, and the rule is evaluated again against the current rows in the commit that releases them.
 */
import type { RelationalStore } from './adapters.js';
import { classify, emit } from '../telemetry.js';
import { observedSettingsGuard, storedSettings } from './settings.js';
import { refused } from '../db/index.js';
import { SETTINGS_REVISION_CONFLICT } from '../db/meta/settings-observation.js';
import { recordBackupPrune, type BackupPruneOutcome } from '../db/meta/backup-prune.js';
import { BACKUP_RETENTION_CHANGED, RETENTION_PAGE, commitRetentionPage, readRetentionPage,
  retentionBacklogged, setRetentionBacklog, type RetentionPage, type RetentionPolicy } from '../db/storage/backup-retention.js';

const RETENTION_LEAVES = ['backup.retention.keep_daily','backup.retention.keep_weekly'] as const;
const KEEP_DAILY_DEFAULT = 14;
const KEEP_WEEKLY_DEFAULT = 8;
/** Pages one prune after a backup takes before leaving the rest to the drain. */
const PRUNE_PAGES = 4;

/** The retention policy the settings leaves hold now, with the defaults for a leaf never written. */
export async function backupRetentionPolicy(db: RelationalStore): Promise<RetentionPolicy> {
  const leaves = await storedSettings(db,RETENTION_LEAVES);
  if ([...leaves.values()].some(leaf=>leaf.violation!==null)) return {keepDaily:0,keepWeekly:0};
  return {keepDaily:(leaves.get(RETENTION_LEAVES[0])?.value ?? KEEP_DAILY_DEFAULT) as number,
    keepWeekly:(leaves.get(RETENTION_LEAVES[1])?.value ?? KEEP_WEEKLY_DEFAULT) as number};
}

export type RetentionDecision = RetentionPage & { policy: RetentionPolicy; policyAssertion: Awaited<ReturnType<typeof observedSettingsGuard>>['assertion'] };

/** A page of victims under the policy in force, with the revisions that must still hold when it is released. */
export async function retentionDecision(db: RelationalStore, limit = RETENTION_PAGE): Promise<RetentionDecision> {
  const settings = await observedSettingsGuard(db,RETENTION_LEAVES,true);
  const policy = await backupRetentionPolicy(settings.view);
  return {...await readRetentionPage(db,policy,limit), policy, policyAssertion: settings.assertion};
}

type ReadyDecision = RetentionDecision & { ready: true };

/** Releases one decided page through the release owner. */
export function releaseRetentionPage(db: RelationalStore, decision: ReadyDecision, now: number, ids: readonly string[] = decision.victims) {
  return commitRetentionPage(db,{ids,policy:decision.policy,policyAssertion:decision.policyAssertion,generation:decision.generation,now,
    backlog:ids===decision.victims ? decision.victims.length===RETENTION_PAGE : undefined});
}

/** The rows or the policy moved under a decision: the commit stopped, nothing changed, and a later pass decides again. */
export const retentionMoved = (error: unknown): boolean => refused(error,BACKUP_RETENTION_CHANGED) || refused(error,SETTINGS_REVISION_CONFLICT);

async function retentionPages(db: RelationalStore, now: number, pages: number): Promise<BackupPruneOutcome> {
  let pruned = 0;
  let deferred = 0;
  for (let page = 0; page < pages; page += 1) {
    const decision = await retentionDecision(db);
    if (!decision.ready) {
      await setRetentionBacklog(db,true);
      return {state:'deferred',reason:'building'};
    }
    if (decision.victims.length === 0) {
      if (decision.backlog) await setRetentionBacklog(db,false);
      break;
    }
    const released = await releaseRetentionPage(db,decision,now);
    pruned += released.released;
    deferred += released.deferred;
    if (decision.victims.length < RETENTION_PAGE || released.deferred > 0) break;
    if (page === pages - 1) return {state:'pruned',pruned,deferred,remaining:true};
  }
  return {state:'pruned',pruned,deferred};
}

/**
 * Prunes under one revision-bound policy and keep-set observation per page, recording what happened for Health. A failed
 * decision preserves the index and records a typed failure; the release owner journals each victim's object and removes
 * its row in one transaction, or keeps it recorded while a recovery hold is open.
 */
export async function pruneBackups(db: RelationalStore, now: number, pages = PRUNE_PAGES): Promise<BackupPruneOutcome> {
  let outcome: BackupPruneOutcome;
  try { outcome = await retentionPages(db,now,pages); }
  catch (error) {
    outcome = retentionMoved(error) ? { state: 'changed', reason: 'retention_changed' } : { state: 'failed', errorClass: classify(error) };
  }
  return recordRetentionOutcome(db,now,outcome);
}

/** Stores what a pass did for Health. The answer carries a store failure so the caller can say the status went unrecorded. */
async function recordRetentionOutcome(db: RelationalStore, now: number, outcome: BackupPruneOutcome): Promise<BackupPruneOutcome> {
  try { await recordBackupPrune(db,now,outcome); return outcome; }
  catch (error) {
    const recordingErrorClass = classify(error);
    emit({ kind: 'backup_prune_record_failed', error_class: recordingErrorClass });
    return { ...outcome, recordingErrorClass };
  }
}

/** Decides backups a held prune recorded, under the policy in force now, and states the result on Health. Answers how many were decided. */
export async function decideBackupCandidates(db: RelationalStore, ids: readonly string[], now: number): Promise<number> {
  try {
    const decision = await retentionDecision(db,0);
    if (!decision.ready) {
      await recordRetentionOutcome(db,now,{state:'deferred',reason:'building'});
      return 0;
    }
    const released = await releaseRetentionPage(db,decision,now,ids);
    const page = {state:'pruned' as const,pruned:released.released,deferred:released.deferred};
    await recordRetentionOutcome(db,now,decision.backlog || ids.length === RETENTION_PAGE ? {...page,remaining:true} : page);
    return ids.length - released.deferred;
  } catch (error) {
    if (retentionMoved(error)) return 0;
    await recordRetentionOutcome(db,now,{state:'failed',errorClass:classify(error)});
    throw error;
  }
}

/** One page of a retention pass a prune left unfinished, so a large backlog is released a page per drain. */
export async function continueBackupRetention(db: RelationalStore, now: number): Promise<void> {
  if (!await retentionBacklogged(db)) return;
  await pruneBackups(db,now,1);
}
