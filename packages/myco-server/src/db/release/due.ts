import type { RelationalStore } from '../../core/adapters.js';
import { commitNamed, read, rows, write, type Bound } from '../index.js';

/** The identity one check holds a Project under; every state it writes and its settlement re-assert it in their commit. */
export interface ReleaseClaim { readonly projectId: string; readonly leaseId: string; readonly revision: string }

const LEASE_HELD = 'EXISTS (SELECT 1 FROM release_check_due d WHERE d.project_id=?1 AND d.lease_id=?2 AND d.revision=?3)';

const dueHead = read<[countedBefore: number, now: number, limit: number], { project_id: string }>({ name: 'releaseDue.head', sql:
  'SELECT project_id FROM release_check_due WHERE next_at<=?1 AND (lease_id IS NULL OR lease_until<=?2) ORDER BY next_at,project_id LIMIT ?3' });

/**
 * The Projects due a check, soonest first. `next_at` is the instant a row's interval counts from, so the Deployment's
 * interval applies the moment it changes: `countedBefore` is now less that interval. A row asked for counts from 0, and
 * a held lease counts from one interval before the lease ends and is never read while it lasts, whatever the interval.
 */
export async function dueReleaseChecks(db: RelationalStore, at: { countedBefore: number; now: number; limit: number }): Promise<string[]> {
  return (await rows(db, dueHead.bind(at.countedBefore, at.now, at.limit))).map(row => row.project_id);
}

const upsertDue = write<[project: string, revision: string]>({ name: 'releaseDue.schedule', sql:
  'INSERT INTO release_check_due(project_id,next_at,revision) VALUES(?1,0,?2) ON CONFLICT(project_id) DO UPDATE SET next_at=0,revision=?2,lease_id=NULL,lease_until=NULL' });
const removeDue = write<[project: string]>({ name: 'releaseDue.remove', sql: 'DELETE FROM release_check_due WHERE project_id=?1' });

/** The due row a settings save leaves, committed with it: a save clears any check in flight and asks for a new one. */
export const releaseDueAfterSave = (input: { projectId: string; revision: string; tracked: boolean }): Bound =>
  input.tracked ? upsertDue.bind(input.projectId, input.revision) : removeDue.bind(input.projectId);

const claimDue = write<[project: string, lease: string, revision: string, until: number, now: number, countsFrom: number], { lease_id: string }>({ name: 'releaseDue.claim', sql:
  'UPDATE release_check_due SET lease_id=?2,lease_until=?4,next_at=?6 WHERE project_id=?1 AND revision=?3 AND (lease_id IS NULL OR lease_until<=?5) RETURNING lease_id' });
const startCheck = write<[project: string, lease: string, revision: string, now: number], { generation: number }>({ name: 'releaseDue.start', sql:
  `UPDATE project_release_provenance SET check_started_at=?4 WHERE project_id=?1 AND revision=?3 AND enabled=1 AND github_repo IS NOT NULL AND ${LEASE_HELD} RETURNING work_generation AS generation` });

/** Takes the Project for one check. Answers the work generation it opened at, or null when another check holds it or the settings moved. */
export async function claimReleaseCheck(db: RelationalStore, claim: ReleaseClaim, lease: { until: number; now: number; intervalMs: number }): Promise<number | null> {
  const { until, now } = lease;
  const { taken, started } = await commitNamed(db, {
    taken: claimDue.bind(claim.projectId, claim.leaseId, claim.revision, until, now, until - lease.intervalMs),
    started: startCheck.bind(claim.projectId, claim.leaseId, claim.revision, now),
  });
  return taken.results.length === 1 ? (started.results[0]?.generation ?? null) : null;
}

/** Moves the Project's work generation when the refs differ from those last checked, or when no fingerprint could be taken; each moved generation makes every open session due. */
const openGeneration = write<[project: string, lease: string, revision: string, fingerprint: string | null], { generation: number }>({ name: 'releaseDue.openGeneration', sql:
  `UPDATE project_release_provenance SET work_generation=work_generation+CASE WHEN ?4 IS NULL OR check_fingerprint IS NOT ?4 THEN 1 ELSE 0 END,check_fingerprint=?4
   WHERE project_id=?1 AND revision=?3 AND ${LEASE_HELD} RETURNING work_generation AS generation` });

export async function openReleaseGeneration(db: RelationalStore, claim: ReleaseClaim, fingerprint: string | null): Promise<number | null> {
  return (await rows(db, openGeneration.bind(claim.projectId, claim.leaseId, claim.revision, fingerprint)))[0]?.generation ?? null;
}

const recordOutcome = write<[project: string, lease: string, revision: string, finished: number, status: string, failure: string | null, counts: string, lookups: number], { recorded: number }>({ name: 'releaseDue.record', sql:
  `UPDATE project_release_provenance SET check_finished_at=?4,check_status=?5,check_failure=?6,check_counts=?7,check_lookups=?8,last_complete_at=CASE WHEN ?5='complete' THEN ?4 ELSE last_complete_at END
   WHERE project_id=?1 AND revision=?3 AND ${LEASE_HELD} RETURNING 1 AS recorded` });
const clearLease = write<[project: string, lease: string, revision: string, now: number]>({ name: 'releaseDue.clear', sql:
  `UPDATE release_check_due SET lease_id=NULL,lease_until=NULL,
     next_at=CASE WHEN EXISTS (SELECT 1 FROM project_release_provenance p WHERE p.project_id=?1 AND p.check_requested_at>p.check_started_at) THEN 0 ELSE ?4 END
   WHERE project_id=?1 AND lease_id=?2 AND revision=?3` });

/** Settles a check, publishing its outcome only while its claim stands; answers whether the claim did. */
export async function settleReleaseCheck(db: RelationalStore, claim: ReleaseClaim, outcome: { now: number; status: string; failure: string | null; counts: string; lookups: number }): Promise<boolean> {
  const { recorded } = await commitNamed(db, {
    recorded: recordOutcome.bind(claim.projectId, claim.leaseId, claim.revision, outcome.now, outcome.status, outcome.failure, outcome.counts, outcome.lookups),
    cleared: clearLease.bind(claim.projectId, claim.leaseId, claim.revision, outcome.now),
  });
  return recorded.results.length === 1;
}
