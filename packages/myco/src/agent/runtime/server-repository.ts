import type { RepositoryAccess } from '@goondocks/myco-shared/repository';
import type { ServerToolContext } from './server-tools.js';
import { postRunControl } from './run-store-http.js';
import { prepareRepositoryCheckout, type RepositoryCheckout } from './repository-checkout.js';

/** Prepare this run's configured source and persist its commit before exposing files. */
export async function prepareRunRepository(ctx: ServerToolContext, signal: AbortSignal, gitPath?: string): Promise<RepositoryCheckout> {
  const answer = await postRunControl(ctx.client, ctx.budget, '/runs/repository', { runId: ctx.runId });
  if (answer.held !== true) throw new Error('This run no longer holds repository access.');
  if (typeof answer.error === 'string') throw new Error(answer.error);
  const repository = answer.repository as RepositoryAccess | null;
  if (!repository) throw new Error('Configure the project repository in Settings before running a code task.');
  signal.throwIfAborted();
  return prepareRepositoryCheckout({
    url: repository.url, branch: repository.branch, credential: repository.credential, commit: repository.commit, signal, gitPath,
    pin: async (commit) => {
      const result = await postRunControl(ctx.client, ctx.budget, '/runs/repository', {
        runId: ctx.runId, url: repository.url, branch: repository.branch, commit,
      });
      const pin = result.pin as { url?: unknown; branch?: unknown; commit?: unknown } | null;
      if (result.held !== true || pin?.url !== repository.url || pin.branch !== repository.branch || typeof pin.commit !== 'string') {
        throw new Error('The run could not retain its repository commit.');
      }
      return pin.commit;
    },
  });
}
