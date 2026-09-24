import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import { pinMapSourceAtCommit } from './canopy.js';
import { prepareRunRepository } from './run-repository.js';
import { repositoryCheckoutOfRun } from './runs.js';
import { withLeasedRun, type WorkerRunIdentity } from './worker-run.js';

/**
 * Only a source-reading run's lease holder may open or pin its repository. A
 * map run's input is pinned with its commit, so the map it may write and the
 * source it read are one pin.
 */
export const prepareWorkerRepository = withLeasedRun(async (env, worker, input: WorkerRunIdentity & { body: Record<string, unknown> }, row) => {
  const expected = repositoryCheckoutOfRun(row);
  if (row.task === null || !REPOSITORY_TASKS.includes(row.task) || expected === null) {
    return { persisted: true, held: false, reason: 'the run holds no repository checkout' };
  }
  const lease = { tokenId: worker.tokenId, now: worker.clock() };
  const answer = await prepareRunRepository(env, input.projectId, row, input.body, expected, lease);
  if (row.task !== MAP_TASK || !('pin' in answer) || answer.pin == null) return answer;
  const source = await pinMapSourceAtCommit(env.db, { projectId: input.projectId }, row, answer.pin, lease);
  return source === null ? { persisted: true, held: false, reason: 'the run no longer holds its map input' } : answer;
});
