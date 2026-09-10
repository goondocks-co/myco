import { REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import { prepareRunRepository } from './run-repository.js';
import { repositoryCheckoutOfRun } from './runs.js';
import { withLeasedRun, type WorkerRunIdentity } from './worker-run.js';

/** Only a source-reading run's lease holder may open or pin its repository. */
export const prepareWorkerRepository = withLeasedRun(async (env, worker, input: WorkerRunIdentity & { body: Record<string, unknown> }, row) => {
  const expected = repositoryCheckoutOfRun(row);
  if (row.task === null || !REPOSITORY_TASKS.includes(row.task) || expected === null) {
    return { persisted: true, held: false, reason: 'the run holds no repository checkout' };
  }
  return prepareRunRepository(env, input.projectId, row, input.body, expected, { tokenId: worker.tokenId, now: worker.clock() });
});
