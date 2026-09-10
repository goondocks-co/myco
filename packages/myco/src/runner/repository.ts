import { join } from 'node:path';
import { REPOSITORY_COMMIT_PATTERN, RUN_REPOSITORY_DIR, type RepositoryAccess, type RepositoryCheckoutSpec } from '@goondocks/myco-shared/repository';
import { prepareRepositoryCheckout, CHECKOUT_TIMEOUT_MS, type RepositoryCheckout } from './repository-checkout.js';

/** Prepare source with credentials held only by the checkout process. */
export async function prepareWorkerCheckout(
  spec: RepositoryCheckoutSpec, scratchDir: string, signal: AbortSignal,
  request: (input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>, gitPath?: string,
): Promise<RepositoryCheckout> {
  const checkoutSignal = AbortSignal.any([signal, AbortSignal.timeout(CHECKOUT_TIMEOUT_MS)]);
  const answer = await request({}, checkoutSignal);
  const repository = answer.repository as RepositoryAccess | null | undefined;
  if (repository == null || repository.url !== spec.url || repository.branch !== spec.branch) throw new Error('The run repository is unavailable or changed.');
  if (repository.commit !== undefined && !REPOSITORY_COMMIT_PATTERN.test(repository.commit)) throw new Error('The run repository commit is invalid.');
  if (repository.credential !== undefined && (repository.credential === null || typeof repository.credential.username !== 'string' || typeof repository.credential.token !== 'string')) {
    throw new Error('The repository read credential is invalid.');
  }
  checkoutSignal.throwIfAborted();
  return prepareRepositoryCheckout({
    url: spec.url, branch: spec.branch, historyDepth: spec.historyDepth,
    credential: repository.credential, commit: repository.commit, signal: checkoutSignal, gitPath,
    destination: join(scratchDir, RUN_REPOSITORY_DIR),
    pin: async (commit) => {
      const result = await request({ url: spec.url, branch: spec.branch, commit }, checkoutSignal);
      const pin = result.pin as { url?: unknown; branch?: unknown; commit?: unknown } | null;
      if (pin?.url !== spec.url || pin.branch !== spec.branch || typeof pin.commit !== 'string' || !REPOSITORY_COMMIT_PATTERN.test(pin.commit)) {
        throw new Error('The run could not retain its repository commit.');
      }
      return pin.commit;
    },
  });
}
