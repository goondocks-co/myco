import type { RelationalStore } from '../../core/adapters.js';
import { SQL_NOW_MS } from '../../core/run-deadline.js';
import { HARNESS_MEMBER_ID } from '../../constants.js';
import { retireEndedAttemptCredentialWrite } from '../identity/member-credential-retirement.js';
import { assertion, commit, first, read, refusalCode, refused, write, type Bound } from '../index.js';
import { SETTINGS_REVISION_CONFLICT } from '../meta/settings-observation.js';
import { DISPATCH_ACTOR_SQL } from '../run-context.js';

const MAP_CARRY_CONFLICT = refusalCode('map_carry_conflict');

const scheduled = read<[project: string, run: string], { one: number }>({ name: 'canopyMap.scheduledPreparation', sql:
  `SELECT 1 AS one FROM agent_runs WHERE project_id=?1 AND id=?2 AND task='canopy-map'
    AND status='running' AND dry_run=0 AND ${DISPATCH_ACTOR_SQL}='clock'
    AND COALESCE(json_extract(run_context,'$.fresh'),0)=0
    AND COALESCE(json_extract(run_context,'$.counts.fresh'),0)=0` });

export const scheduledMapPreparation = (db: RelationalStore, project: string, run: string) => first(db, scheduled.bind(project, run));

/** A carry is conditional on the exact map, connection, exclusions and attempt that were read. */
const carryGuard = assertion<[project: string, run: string, attempt: string, context: string, revision: string,
  oldHash: string, oldCommit: string, repositoryRevision: string, url: string, branch: string, now: number, maxContentAgeMs: number]>({
  name: 'canopyMap.carryGuard', refusal: MAP_CARRY_CONFLICT, when:
    `EXISTS(SELECT 1 FROM canopy_maps WHERE project_id=?1 AND revision=?5 AND input_hash=?6 AND repository_commit=?7
      AND repository_url=?9 AND repository_branch=?10 AND generated_at>=MAX(?11, ${SQL_NOW_MS})-?12)
    AND EXISTS(SELECT 1 FROM project_repositories WHERE project_id=?1 AND revision=?8 AND url=?9 AND branch=?10)
    AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=?1 AND id=?2 AND dispatched_by=?3 AND run_context=?4
      AND status='running' AND dry_run=0 AND task='canopy-map' AND ${DISPATCH_ACTOR_SQL}='clock')`,
});

const carryMap = write<[project: string, prior: string, revision: string, commit: string, hash: string], { revision: string }>({
  name: 'canopyMap.carry', sql: `UPDATE canopy_maps SET revision=?3,repository_commit=?4,input_hash=?5
    WHERE project_id=?1 AND revision=?2 RETURNING revision`,
});

/** Every companion rolls back if the live lease could not close this exact attempt. */
const carryClosed = assertion<[project: string, run: string, attempt: string, context: string, at: number, revision: string]>({
  name: 'canopyMap.carryClosed', refusal: MAP_CARRY_CONFLICT, when:
    `EXISTS(SELECT 1 FROM agent_runs WHERE project_id=?1 AND id=?2 AND dispatched_by=?3 AND status='skipped'
      AND run_context=?4 AND completed_at=?5)
    AND EXISTS(SELECT 1 FROM canopy_maps WHERE project_id=?1 AND revision=?6)`,
});

/** Guard the whole carry, close and retirement as one indivisible transition. */
export async function commitMapCarry(db: RelationalStore, options: {
  projectId: string; runId: string; attemptId: string; context: string; priorRevision: string;
  oldHash: string; oldCommit: string; repositoryRevision: string; url: string; branch: string;
  settingsGuard: Bound; revision: string; commit: string; inputHash: string; closedContext: string;
  now: number; maxContentAgeMs: number; settlement: Bound; end: Bound;
}): Promise<boolean> {
  const o = options;
  try {
    await commit(db, o.settingsGuard,
      carryGuard.bind(o.projectId, o.runId, o.attemptId, o.context, o.priorRevision, o.oldHash, o.oldCommit,
        o.repositoryRevision, o.url, o.branch, o.now, o.maxContentAgeMs),
      carryMap.bind(o.projectId, o.priorRevision, o.revision, o.commit, o.inputHash),
      o.settlement, o.end,
      carryClosed.bind(o.projectId, o.runId, o.attemptId, o.closedContext, o.now, o.revision),
      retireEndedAttemptCredentialWrite(o.now, HARNESS_MEMBER_ID, { tokenId: o.attemptId, projectId: o.projectId, runId: o.runId }));
    return true;
  } catch (error) {
    if (refused(error, MAP_CARRY_CONFLICT) || refused(error, SETTINGS_REVISION_CONFLICT)) return false;
    throw error;
  }
}
