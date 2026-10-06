import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from './adapters.js';
import { pinMapRepositoryAtCommit } from './canopy.js';
import { prepareRunRepository } from './run-repository.js';
import { repositoryCheckoutOfRun, repositoryPinOfRun, type RunRow } from './runs.js';
import { withLeasedRunCommit, withLeasedRunSecret, type WorkerLeaseOwner, type WorkerRunIdentity } from './worker-run.js';

/**
 * Only a source-reading run's lease holder may open or pin its repository. A
 * map run's input is pinned with its commit, so the map it may write and the
 * source it read are one pin.
 */
const prepare = async (env: ServerEnv, worker: WorkerLeaseOwner, input: WorkerRunIdentity & { body: Record<string, unknown> }, row: RunRow & { dispatchedBy: string }) => {
  const expected = repositoryCheckoutOfRun(row);
  if (row.task === null || !REPOSITORY_TASKS.includes(row.task) || expected === null) {
    return { persisted: true, held: false, reason: 'the run holds no repository checkout' };
  }
  const lease = { tokenId: worker.tokenId, now: worker.clock() };
  const hadRepositoryPin = row.task === MAP_TASK && repositoryPinOfRun(row) !== null;
  const answer = await prepareRunRepository(env, input.projectId, row, input.body, expected, lease,
    row.task === MAP_TASK
      ? (pin) => pinMapRepositoryAtCommit(env.db, { projectId: input.projectId }, row, pin, lease)
      : undefined);
  return hadRepositoryPin && 'pin' in answer && answer.pin === null
    ? { persisted: true, held: false, reason: 'the run no longer holds its map input' }
    : answer;
};

const prepareRead = withLeasedRunSecret(prepare);
const preparePin = withLeasedRunCommit(prepare);

export const prepareWorkerRepository = (env: ServerEnv, worker: WorkerLeaseOwner, input: WorkerRunIdentity & { body: Record<string, unknown> }) =>
  input.body.commit === undefined ? prepareRead(env, worker, input) : preparePin(env, worker, input);
