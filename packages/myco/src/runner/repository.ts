import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KNOWLEDGE_REPOSITORY_TASKS, REPOSITORY_COMMIT_PATTERN, RUN_REPOSITORY_DIGESTS_FILE, RUN_REPOSITORY_DIR, parseRepositoryComparison, parseRepositoryChanges, repositoryUrl, type RepositoryAccess, type RepositoryCheckoutSpec } from '@goondocks/myco-shared/repository';
import { revokeInstallationToken } from '@goondocks/myco-shared/github-api';
import { runnerRequestSignal } from './request.js';
import { removeOwnedRunDirectoryEntry } from './run-directory.js';
import { prepareRepositoryCheckout, CHECKOUT_TIMEOUT_MS, type CheckoutFileDigest, type RepositoryCheckout } from './repository-checkout.js';

/** The digest listing's text: `sha256sum` lines, one per listed file. */
export function digestListing(digests: readonly CheckoutFileDigest[]): string {
  return digests.map((file) => `${file.sha256}  ${file.path}\n`).join('');
}

/**
 * Ends the checkout token a preparation answer carries, if any, on the revoke's own deadline. A failure is logged in
 * fixed words; the token is never logged.
 */
export async function revokeRepositoryToken(answer: unknown, options: Pick<WorkerCheckoutOptions, 'fetchImpl' | 'log'>): Promise<void> {
  const token = ((answer as { repository?: RepositoryAccess | null } | null)?.repository)?.credential?.token;
  if (typeof token === 'string' && !await revokeInstallationToken(options.fetchImpl ?? fetch, token, runnerRequestSignal())) {
    options.log?.('the repository token could not be revoked; it expires within the hour');
  }
}

/** The Deployment settled this attempt during source preparation. */
export class RepositoryAlreadyCurrent extends Error {}

/** Worker checkout task, Git executable, digest listing, optional knowledge cache, the worker's log and GitHub's API transport. */
export interface WorkerCheckoutOptions { gitPath?: string; digests?: boolean; cacheRoot?: string; task?: string; log?: (line: string) => void; fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }

/**
 * Prepare source with credentials held only by the checkout process, and, where asked, write its digest listing beside
 * it. The repository token is revoked as soon as Git no longer needs it, whether the checkout succeeded or not.
 */
export async function prepareWorkerCheckout(
  spec: RepositoryCheckoutSpec, scratchDir: string, signal: AbortSignal,
  request: (input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>, options: WorkerCheckoutOptions = {},
): Promise<RepositoryCheckout> {
  const checkoutSignal = AbortSignal.any([signal, AbortSignal.timeout(CHECKOUT_TIMEOUT_MS)]);
  const answer = await request({}, checkoutSignal);
  const repository = answer.repository as RepositoryAccess | null | undefined;
  const token = repository?.credential?.token;
  const revoke = () => revokeRepositoryToken(answer, options);
  // From here the runner owns the token: every exit before checkout ends, cancellation included, revokes it.
  let checkout: RepositoryCheckout;
  let comparison: ReturnType<typeof parseRepositoryComparison>;
  try {
    if (repository == null || repository.url !== spec.url || repository.branch !== spec.branch) throw new Error('The run repository is unavailable or changed.');
    if (repository.commit !== undefined && !REPOSITORY_COMMIT_PATTERN.test(repository.commit)) throw new Error('The run repository commit is invalid.');
    if (typeof token !== 'string' || typeof repository.credential.username !== 'string') throw new Error('The repository read credential is invalid.');
    const remote = repositoryUrl(String(repository.remote));
    checkoutSignal.throwIfAborted();
    comparison = parseRepositoryComparison(answer.comparison);
    checkout = await prepareRepositoryCheckout({
      url: remote, branch: spec.branch, historyDepth: spec.historyDepth,
      compareCommit: comparison?.commit,
      credential: repository.credential, commit: repository.commit, signal: checkoutSignal, gitPath: options.gitPath, digests: options.digests, cacheRoot:options.task !== undefined && KNOWLEDGE_REPOSITORY_TASKS.includes(options.task) ? options.cacheRoot : undefined,
      destination: join(scratchDir, RUN_REPOSITORY_DIR),
      removeDestination: () => removeOwnedRunDirectoryEntry(scratchDir, RUN_REPOSITORY_DIR),
      pin: async (commit) => {
        const result = await request({ url: spec.url, branch: spec.branch, commit }, checkoutSignal);
        const pin = result.pin as { url?: unknown; branch?: unknown; commit?: unknown } | null;
        if (pin?.url !== spec.url || pin.branch !== spec.branch || typeof pin.commit !== 'string' || !REPOSITORY_COMMIT_PATTERN.test(pin.commit)) {
          throw new Error('The run could not retain its repository commit.');
        }
        return pin.commit;
      },
    });
  } finally { await revoke(); }
  try {
    if (comparison !== null) {
      const candidate = { ...comparison, ...checkout.changes };
      const evidence = parseRepositoryChanges(candidate) ?? { ...comparison, complete: false, changes: [] };
      const result = await request({ url: spec.url, branch: spec.branch, commit: checkout.commit, comparison: evidence }, checkoutSignal);
      if (result.alreadyCurrent === true) throw new RepositoryAlreadyCurrent();
    }
    if (checkout.digests !== undefined) await writeFile(join(scratchDir, RUN_REPOSITORY_DIGESTS_FILE), digestListing(checkout.digests), { mode: 0o600 });
  } catch (error) {
    await checkout.dispose();
    throw error;
  }
  return checkout;
}
