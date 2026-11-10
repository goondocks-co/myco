import { backupSnapshot, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { ESTIMATE_PUBLISH_PAGE, estimateForClaim, estimateRefreshDue, refreshEstimates } from '@myco-server-worker/core/budget-estimates.js';
import type { BlobStore, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { createProject } from '@myco-server-worker/db/storage/projects.js';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { issueMemberToken } from './member-token.js';
import { check, equal, interleaveAt, lockstep, MACHINE, MEMBER, seedDeployment, sweep } from './store-race.js';

/** The budget estimator's refresh racing a restore of the attempts it reads, and racing another refresh. */

const PROFILE: ExecutionProfile = { tier: 'low', model: 'gpt-fixture', effort: 'low', sources: { tier: 'task', model: 'configured' } };
const TASK = 'title-summary';
const ACTIVATED = 1_000_000;

/** A content store the estimator's backups never reach: their tables hold no content references. */
const NO_CONTENT = new Proxy({}, { get: () => () => { throw new Error('an estimator backup reads no content'); } }) as BlobStore;

async function estimator(db: RelationalStore) {
  await seedDeployment(db);
  const { tokenId } = await issueMemberToken(db, { memberId: MEMBER, machineId: MACHINE }, ACTIVATED);
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES ('myco-agent','Agent','built-in',1,0)").run();
  check((await completeBudgetMigration(db, ACTIVATED)).active === true, 'the budget governor activates');
  let at = ACTIVATED;
  return {
    /** A settled, priced attempt of its own run, as a worker leaves one. */
    settle: async (project: string, run: string, claimedAt: number, cost: number) => {
      await db.batch([
        db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dispatched_by,cost_usd,origin)
          VALUES (?1,?2,'myco-agent',?3,'completed',?4,?4,?5,?6,'automatic')`).bind(project, run, TASK, claimedAt, tokenId, cost),
        db.prepare(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd,cost_source,profile_json)
          VALUES (?1,?2,?2,?3,?4,0.1,?5,'actual',?6)`).bind(project, run, tokenId, claimedAt, cost, JSON.stringify({ harness: 'codex', profile: PROFILE })),
      ]);
    },
    estimate: async (project: string) => (await estimateForClaim(db, project, TASK, 'codex', PROFILE)).estimate,
    /** Moves the clock to the next instant the estimator calls a refresh due. */
    due: async () => { while (!(await estimateRefreshDue(db, at))) at += 60_000; return at; },
    refresh: (s: RelationalStore) => refreshEstimates(s, at),
    finish: async () => { while ((await refreshEstimates(db, at)).more) { /* the rest of the cycle */ } },
  };
}

const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9;

const refreshRestoreRaces = async (db: RelationalStore): Promise<void> => {
  const e = await estimator(db);
  // An attempt claimed before activation counts only once a restore lowers the floor; costs 1, 3 and 8 make each
  // possible sample distinct: before the race 3, from reads the restore made stale 5.5, after the restore 4.
  for (let round = 1, inside = true; inside; round += 1) {
    const project = `p${round}`;
    check(await createProject(db, project, project, 0), 'the round\'s Project is created');
    await e.settle(project, `${project}-old`, ACTIVATED - 1000 - round, 1);
    await e.settle(project, `${project}-kept`, ACTIVATED + round, 3);
    const backup = new TextDecoder().decode((await backupSnapshot(db, NO_CONTENT, { producer: 'race', now: ACTIVATED })).bytes);
    await e.due();
    await e.finish();
    equal(await e.estimate(project), 3, 'an attempt claimed before activation is not in the estimate');
    await db.prepare('DELETE FROM agent_run_attempts WHERE project_id=?1 AND run_id=?2').bind(project, `${project}-old`).run();
    await e.settle(project, `${project}-new`, ACTIVATED + round, 8);
    await e.due();
    const restore = (s: RelationalStore) => restoreArtifact(s, { text: backup, authorization: { kind: 'recovery' }, now: ACTIVATED });
    ({ inside } = await interleaveAt(db, e.refresh, restore, round - 1));
    const raced = await e.estimate(project);
    check(inside ? near(raced, 3) || near(raced, 4) : near(raced, 5.5),
      `a refresh racing a restore publishes no estimate from attempts the restore replaced (restore before the refresh's call ${round - 1}): ${raced}`);
    await e.finish();
    equal(await e.estimate(project), 4, `after a restore the estimator rebuilds from every restored attempt, its original order and claim kept (restore before the refresh's call ${round - 1})`);
  }
};

const refreshRefreshRaces = async (db: RelationalStore): Promise<void> => {
  const e = await estimator(db);
  // Three pages of attempts, the first published before the race, so the racing refreshes contend for one held page.
  const attempts = 2 * ESTIMATE_PUBLISH_PAGE + 8;
  const settleAll = async (project: string) => {
    check(await createProject(db, project, project, 0), 'the Project is created');
    for (let i = 1; i <= attempts; i += 1) await e.settle(project, `${project}-${i}`, ACTIVATED + i, i);
  };
  await settleAll('alone');
  await e.due();
  await e.finish();
  const alone = await e.estimate('alone');
  const raced = async (project: string, at: string) => {
    await e.finish();
    equal(await e.estimate(project), alone, `two racing refreshes publish the estimate one refresh alone publishes (${at})`);
  };
  const start = async (run: number) => {
    await settleAll(`race-${run}`);
    await e.due();
    check((await e.refresh(db)).more, 'the first page is published and more remain');
  };
  for (const order of [0, 1]) {
    await start(100 + order);
    await lockstep(db, e.refresh, e.refresh);
    await raced(`race-${100 + order}`, `alternating, order ${order}`);
  }
  await sweep(db, { before: start, left: () => e.refresh, right: () => e.refresh, after: (run, _, at) => raced(`race-${run}`, at) });
};

export const ESTIMATE_RACES: Record<string, (db: RelationalStore) => Promise<void>> = {
  'a refresh racing a restore never keeps estimates from the attempts the restore replaced': refreshRestoreRaces,
  'two racing refreshes publish the estimate one refresh alone publishes': refreshRefreshRaces,
};
