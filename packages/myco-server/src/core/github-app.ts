import { GITHUB_TOKEN_PERMISSIONS, githubAppAccess, gitHubAppPermissionIssues, type GitHubAppStatus, type GitHubTokenPurpose } from '@goondocks/myco-shared/github-app';
import { GitHubAppError, githubApi, revokeInstallationToken } from '@goondocks/myco-shared/github-api';
import { approveAccount, approvedAccount, approvedAccounts, withdrawAccount, type ApprovedAccount } from '../db/github-app/accounts.js';
import type { ServerEnv } from './adapters.js';
import { emit } from '../telemetry.js';

/**
 * The Deployment's GitHub App, as Project repository access uses it.
 *
 * **An installation is usable only for an approved account.** The App is public so that anyone can sign in through
 * it, so anyone can also install it. Only an installation whose GitHub account id is on this Deployment's approved list
 * is offered, saved or minted for, and the account is re-read from GitHub at each of those moments.
 *
 * **Tokens are narrow and short.** Every token names one purpose's read permissions and, outside discovery, exactly one
 * repository by its numeric id. A token is never stored or logged.
 *
 * **Every token has one owner on every exit.** A token exists only inside `withToken`'s scope, from the moment GitHub's
 * answer carries it: the scope revokes it on any exit unless the work returns it as a `HandedOver` answer, whose
 * receiver then owns revoking it.
 *
 * **What no code here can revoke**, each a read-only token for one repository alive for at most the hour GitHub gives
 * it: a token GitHub issued whose answer a request deadline cut before it reached the Deployment; a handed-over answer
 * the platform failed to send; and an answer a runner stopped waiting for that did not finish arriving within its
 * cleanup allowance.
 */

/** Why repository access is refused, each named in the reader's words. */
export const GITHUB_ACCESS_FAILURES = {
  app_not_configured: 'GitHub repository access needs setup. The server operator runs `myco server github-app` for this server.',
  account_not_approved: 'This installation belongs to a GitHub account this server has not approved. An admin approves it in Project Settings → Repository.',
  installation_unavailable: 'The App installation was removed or suspended in GitHub. Install the App again or unsuspend it, then connect the repository again.',
  repository_not_granted: 'The App installation does not include this repository. Add the repository to the installation in GitHub, then check again.',
  permissions_missing: 'The App installation has not granted the read access this needs. Approve the App’s requested permissions in GitHub, then check again.',
  access_refused: 'GitHub refused access to this repository through the App installation. Check in GitHub that the installation includes it and its requested permissions are approved, then check again.',
  rate_limited: 'GitHub’s rate limit for this App was reached. Check again after it resets.',
  github_unavailable: 'GitHub did not answer as expected. Check again later.',
} as const;
export type GitHubAccessFailure = keyof typeof GITHUB_ACCESS_FAILURES;

export class GitHubAccessRefused extends Error {
  constructor(readonly failure: GitHubAccessFailure) { super(GITHUB_ACCESS_FAILURES[failure]); }
}

export interface InstallationAccount { id: number; login: string; type: 'User' | 'Organization' }
/** One page of the App's installations, and whether GitHub holds another after it. */
export interface InstallationsPage { installations: InstallationView[]; accounts: ApprovedAccount[]; page: number; more: boolean }
export interface InstallationView {
  installationId: number;
  account: InstallationAccount;
  approved: boolean;
  suspended: boolean;
}
export interface RepositoryChoice { id: number; fullName: string; defaultBranch: string; private: boolean }
/** A repository GitHub confirmed through an approved installation. */
export interface VerifiedRepository { id: number; fullName: string; url: string }
export interface IssuedToken { token: string; expiresAt: number; repository: VerifiedRepository }

/** A complete answer carrying a token, whose receiver now owns revoking it. */
export class HandedOver<T> {
  constructor(readonly value: T) {}
}

/** Up to this many installations, and repositories per page, are read in one request; GitHub's own page ceiling. */
const GITHUB_PAGE_SIZE = 100;
/** The last page of installations or of one installation's repositories an admin can ask for. */
export const MAX_REPOSITORY_PAGE = 100;
const OWNER_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** Local readiness: the App key and sign-in client id are configured. GitHub is not asked. */
export const githubAppConfigured = (env: Pick<ServerEnv, 'secrets'>): boolean =>
  Boolean(env.secrets.GITHUB_APP_PRIVATE_KEY) && Boolean(env.secrets.GITHUB_CLIENT_ID);

/** Explicit admin refresh, with no persisted identity or token. */
export async function githubAppStatus(env: ServerEnv, now: number): Promise<GitHubAppStatus> {
  const privateKey = env.secrets.GITHUB_APP_PRIVATE_KEY;
  if (!privateKey) return { state: 'key_absent' };
  const clientId = env.secrets.GITHUB_CLIENT_ID;
  if (!clientId) return { state: 'unavailable', reason: 'GitHub sign-in is not configured. Run myco server github-app first.' };
  try {
    const app = await githubAppAccess({ privateKey, clientId, fetchImpl: env.outbound, now: () => now }).identity();
    const missing = gitHubAppPermissionIssues(app);
    return { state: missing.length === 0 ? 'ready' : 'permissions_missing', app, missing };
  } catch (error) {
    if (error instanceof GitHubAppError) return { state: 'unavailable', reason: error.message };
    throw error;
  }
}

const NEXT = 'Check again later.';
/** How long one installation-token request to GitHub may take. */
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** A refused GitHub answer, named. https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api */
async function refusalOf(response: Response, notFound: GitHubAccessFailure): Promise<GitHubAccessRefused> {
  const { status, headers } = response;
  if (status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') || /rate limit/i.test(await response.text().catch(() => ''))))) {
    return new GitHubAccessRefused('rate_limited');
  }
  if (status === 404) return new GitHubAccessRefused(notFound);
  // A validation refusal names no cause Myco can rely on; it is never read as a repository leaving the installation.
  if (status === 422) return new GitHubAccessRefused('access_refused');
  return new GitHubAccessRefused('github_unavailable');
}

async function bodyOf(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new GitHubAccessRefused('github_unavailable'); }
}

/** https://docs.github.com/en/rest/apps/apps#get-an-installation-for-the-authenticated-app */
function installationOf(value: unknown): { installationId: number; account: InstallationAccount; suspended: boolean; permissions: Record<string, unknown> } {
  const account = isRecord(value) ? value.account : null;
  if (!isRecord(value) || !positiveId(value.id) || !isRecord(account) || !positiveId(account.id) || typeof account.login !== 'string'
    || (account.type !== 'User' && account.type !== 'Organization')) throw new GitHubAccessRefused('github_unavailable');
  return { installationId: value.id, account: { id: account.id, login: account.login, type: account.type }, suspended: value.suspended_at != null,
    permissions: isRecord(value.permissions) ? value.permissions : {} };
}

/** An installation as an admin's list shows it, without the grant it carries. */
const viewOf = ({ installationId, account, suspended }: ReturnType<typeof installationOf>) => ({ installationId, account, suspended });

/** https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation */
function repositoryOf(value: unknown): RepositoryChoice {
  if (!isRecord(value) || !positiveId(value.id) || typeof value.full_name !== 'string' || !OWNER_NAME.test(value.full_name)
    || typeof value.default_branch !== 'string') throw new GitHubAccessRefused('github_unavailable');
  return { id: value.id, fullName: value.full_name, defaultBranch: value.default_branch, private: value.private === true };
}

const verified = (repository: { id: number; fullName: string }): VerifiedRepository =>
  ({ id: repository.id, fullName: repository.fullName, url: `https://github.com/${repository.fullName}` });

/**
 * The App capability for one request. Its operations take ids from storage or from an admin's choice, and check each
 * one with GitHub before any token names it.
 */
export function githubAppProjects(env: Pick<ServerEnv, 'db' | 'secrets' | 'outbound'>, now: () => number = Date.now) {
  const app = () => {
    const privateKey = env.secrets.GITHUB_APP_PRIVATE_KEY;
    const clientId = env.secrets.GITHUB_CLIENT_ID;
    if (!privateKey || !clientId) throw new GitHubAccessRefused('app_not_configured');
    return githubAppAccess({ privateKey, clientId, fetchImpl: env.outbound, now });
  };
  const asApp = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    try { return await app().app(path, { ...init, next: NEXT }); }
    catch (error) { if (error instanceof GitHubAppError) throw new GitHubAccessRefused('github_unavailable'); throw error; }
  };
  const asInstallation = async (token: string, path: string) => {
    try { return await githubApi(env.outbound, path, { bearer: token, signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS), next: NEXT }); }
    catch (error) { if (error instanceof GitHubAppError) throw new GitHubAccessRefused('github_unavailable'); throw error; }
  };

  /** The installation as GitHub answers now, refused unless its account is approved here and it is not suspended. */
  const approvedInstallation = async (installationId: number) => {
    const response = await asApp(`/app/installations/${installationId}`);
    if (response.status !== 200) throw await refusalOf(response, 'installation_unavailable');
    const installation = installationOf(await bodyOf(response));
    if (installation.installationId !== installationId) throw new GitHubAccessRefused('github_unavailable');
    if (await approvedAccount(env.db, installation.account.id) === null) throw new GitHubAccessRefused('account_not_approved');
    if (installation.suspended) throw new GitHubAccessRefused('installation_unavailable');
    return installation;
  };

  const revoke = async (token: string, purpose: GitHubTokenPurpose) => {
    if (!await revokeInstallationToken(env.outbound, token, AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS))) emit({ kind: 'github_token_revoke_failed', purpose });
  };

  /**
   * Runs `work` with a token for one purpose, on an installation re-read and approved at this moment, whose grant
   * covers the purpose. With a repository, the token names exactly that one, and GitHub must confirm the same id.
   * The token is revoked on every exit from this scope, its own validation included, unless `work` hands it over.
   * https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
   */
  const scoped = async <T>(installationId: number, purpose: GitHubTokenPurpose, repositoryId: number | undefined,
    work: (issued: { token: string; expiresAt: number; repository: VerifiedRepository | null }) => Promise<T | HandedOver<T>>): Promise<T | HandedOver<T>> => {
    const installation = await approvedInstallation(installationId);
    const requested = GITHUB_TOKEN_PERMISSIONS[purpose];
    if (Object.keys(requested).some(permission => installation.permissions[permission] !== 'read')) throw new GitHubAccessRefused('permissions_missing');
    const response = await asApp(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST', body: { permissions: requested, ...(repositoryId === undefined ? {} : { repository_ids: [repositoryId] }) },
    });
    if (response.status !== 201) throw await refusalOf(response, 'installation_unavailable');
    const body = await bodyOf(response);
    if (!isRecord(body) || typeof body.token !== 'string' || body.token === '') throw new GitHubAccessRefused('github_unavailable');
    const token = body.token;
    let handedOver = false;
    try {
      const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
      if (!Number.isFinite(expiresAt)) throw new GitHubAccessRefused('github_unavailable');
      const granted = isRecord(body.permissions) ? body.permissions : {};
      if (Object.keys(requested).some(permission => granted[permission] !== 'read')) throw new GitHubAccessRefused('permissions_missing');
      let repository: VerifiedRepository | null = null;
      if (repositoryId !== undefined) {
        let named = Array.isArray(body.repositories) ? body.repositories : null;
        if (named === null) {
          // GitHub's answer lists the repositories only conditionally; the token itself is then asked which one it reads.
          const read = await asInstallation(token, `/repositories/${repositoryId}`);
          if (read.status !== 200) throw await refusalOf(read, 'repository_not_granted');
          named = [await bodyOf(read)];
        }
        const repositories = named.map(repositoryOf);
        if (repositories.length !== 1 || repositories[0]!.id !== repositoryId) throw new GitHubAccessRefused('repository_not_granted');
        repository = verified(repositories[0]!);
      }
      const result = await work({ token, expiresAt, repository });
      handedOver = result instanceof HandedOver;
      return result;
    } finally {
      if (!handedOver) await revoke(token, purpose);
    }
  };
  const used = async <T>(result: Promise<T | HandedOver<T>>): Promise<T> => {
    const value = await result;
    if (value instanceof HandedOver) throw new Error('a token used inside the Deployment is never handed over');
    return value;
  };

  return {
    /**
     * One page of the App's installations, with each account's approval here. Admin refresh only. The next page is
     * asked for by number on the fixed origin; GitHub's own link only says whether one exists.
     * https://docs.github.com/en/rest/apps/apps#list-installations-for-the-authenticated-app
     */
    async installations(page = 1): Promise<InstallationsPage> {
      const response = await asApp(`/app/installations?per_page=${GITHUB_PAGE_SIZE}&page=${page}`);
      if (response.status !== 200) throw await refusalOf(response, 'github_unavailable');
      const body = await bodyOf(response);
      if (!Array.isArray(body)) throw new GitHubAccessRefused('github_unavailable');
      const accounts = await approvedAccounts(env.db);
      const approved = new Set(accounts.map(account => account.accountId));
      return {
        installations: body.map(installationOf).map(installation => ({ ...viewOf(installation), approved: approved.has(installation.account.id) })),
        accounts, page, more: /rel="next"/.test(response.headers.get('link') ?? '') && page < MAX_REPOSITORY_PAGE,
      };
    },
    /** Approves the account that holds `installationId`, as GitHub names it now; the request names only the installation. */
    async approve(installationId: number, actor: string, at: number): Promise<ApprovedAccount> {
      const response = await asApp(`/app/installations/${installationId}`);
      if (response.status !== 200) throw await refusalOf(response, 'installation_unavailable');
      const { account } = installationOf(await bodyOf(response));
      return approveAccount(env.db, { accountId: account.id, login: account.login, type: account.type }, actor, at);
    },
    withdraw: (accountId: number) => withdrawAccount(env.db, accountId),
    /** One page of an approved installation's repositories, read with a metadata-only token that never leaves here. */
    repositories: (installationId: number, page: number): Promise<{ repositories: RepositoryChoice[]; more: boolean }> =>
      used(scoped(installationId, 'discovery', undefined, async ({ token }) => {
        const response = await asInstallation(token, `/installation/repositories?per_page=${GITHUB_PAGE_SIZE}&page=${page}`);
        if (response.status !== 200) throw await refusalOf(response, 'installation_unavailable');
        const body = await bodyOf(response);
        if (!isRecord(body) || !Array.isArray(body.repositories) || !Number.isSafeInteger(body.total_count)) throw new GitHubAccessRefused('github_unavailable');
        return { repositories: body.repositories.map(repositoryOf), more: page * GITHUB_PAGE_SIZE < Number(body.total_count) && page < MAX_REPOSITORY_PAGE };
      })),
    /** Confirms an admin's choice before it is saved: an approved installation, granting reads on exactly this repository. */
    verify: (installationId: number, repositoryId: number): Promise<VerifiedRepository> =>
      used(scoped(installationId, 'checkout', repositoryId, async ({ repository }) => repository!)),
    /**
     * Runs `work` with a token for a stored connection's one repository. The token is revoked when `work` ends, however
     * it ends, unless `work` returns a complete answer as `HandedOver`, whose receiver then owns revoking it.
     */
    withToken: <T>(connection: { installationId: number; repositoryId: number }, purpose: Exclude<GitHubTokenPurpose, 'discovery'>,
      work: (issued: IssuedToken) => Promise<T | HandedOver<T>>): Promise<T | HandedOver<T>> =>
      scoped(connection.installationId, purpose, connection.repositoryId, (issued) => work({ ...issued, repository: issued.repository! })),
    /** Ends a token a `HandedOver` receiver could not deliver. */
    revoke,
  };
}
