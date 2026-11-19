import type { OutboundFetch, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { approveAccount } from '@myco-server-worker/db/github-app/accounts.js';
import { APP_KEY } from '../../setup/fixtures/github.js';
import { OWNER_ENV } from './owner.js';

/** The operator's own installation, and one by an account this Deployment never approved. */
export const OPERATOR = { installationId: 41, account: { id: 9001, login: 'operator-org', type: 'Organization' as const } };
export const STRANGER = { installationId: 666, account: { id: 6660, login: 'operat0r-org', type: 'Organization' as const } };
/** https://docs.github.com/en/rest/repos/repos#get-a-repository (the fields Myco reads). */
export const SOURCE = { id: 1296269, full_name: 'example/source', default_branch: 'main', private: true };
export const SOURCE_URL = 'https://github.com/example/source';
const STRANGER_SOURCE = { id: 7770001, full_name: 'operat0r-org/source', default_branch: 'main', private: false };

/** The secrets a Deployment with an App key holds. */
export const APP_SECRETS = { GITHUB_CLIENT_ID: OWNER_ENV.GITHUB_CLIENT_ID, GITHUB_APP_PRIVATE_KEY: APP_KEY };

/**
 * GitHub's App and installation endpoints answering documented shapes, with no network fallback. Like Workers, it
 * refuses a request that does not leave redirects to the caller. Every token it mints is long and opaque.
 */
export function githubFixture() {
  const installations = [OPERATOR, STRANGER];
  const repositories = new Map<number, Array<typeof SOURCE>>([[OPERATOR.installationId, [SOURCE]], [STRANGER.installationId, [STRANGER_SOURCE]]]);
  const state = {
    issued: [] as Array<{ token: string; installationId: number; body: { permissions: Record<string, string>; repository_ids?: number[] } }>,
    revoked: [] as string[],
    requests: [] as string[],
    /** Answers `/app/installations/{id}/access_tokens` with this status instead of a token. */
    mintStatus: 201,
    /** The permissions GitHub grants each token. */
    granted: { contents: 'read', pull_requests: 'read', metadata: 'read' } as Record<string, string>,
    /** The name GitHub reports for a repository id now. */
    names: new Map<number, string>(),
    suspended: new Set<number>(),
    /** Installations GitHub lists on its second page, after the first. */
    laterInstallations: [] as Array<typeof OPERATOR>,
    /** The `expires_at` GitHub answers with instead of an hour from now. */
    expiresAt: null as string | null,
  };
  const repositoryAnswer = (repository: typeof SOURCE) => ({ ...repository, full_name: state.names.get(repository.id) ?? repository.full_name });
  const fetchImpl: OutboundFetch = async (input, init) => {
    if (init?.redirect !== 'manual') throw new TypeError('the fixture refuses a request Workers would refuse: GitHub requests leave redirects to the caller');
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.github.com') throw new Error(`fixture GitHub: unexpected origin ${url.origin}`);
    state.requests.push(`${request.method} ${url.pathname}${url.search}`);
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const installation = (id: number) => [...installations, ...state.laterInstallations].find(entry => entry.installationId === id);
    // https://docs.github.com/en/rest/apps/apps#get-an-installation-for-the-authenticated-app
    const installationBody = (entry: typeof OPERATOR) => ({ id: entry.installationId, account: entry.account, repository_selection: 'selected',
      permissions: state.granted, suspended_at: state.suspended.has(entry.installationId) ? '2026-11-01T00:00:00Z' : null });
    // https://docs.github.com/en/rest/apps/apps#list-installations-for-the-authenticated-app
    if (request.method === 'GET' && url.pathname === '/app/installations') {
      const later = url.searchParams.get('page') === '2';
      return Response.json((later ? state.laterInstallations : installations).map(installationBody),
        { headers: !later && state.laterInstallations.length > 0 ? { link: '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next"' } : {} });
    }
    let match = /^\/app\/installations\/(\d+)$/.exec(url.pathname);
    if (request.method === 'GET' && match) {
      const entry = installation(Number(match[1]));
      return entry === undefined ? Response.json({ message: 'Not Found' }, { status: 404 }) : Response.json(installationBody(entry));
    }
    // https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
    match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (request.method === 'POST' && match) {
      const installationId = Number(match[1]);
      const body = await request.json() as { permissions: Record<string, string>; repository_ids?: number[] };
      const held = repositories.get(installationId) ?? [];
      if (state.mintStatus !== 201) return Response.json({ message: 'upstream validation detail' }, { status: state.mintStatus });
      if (body.repository_ids?.some(id => !held.some(repository => repository.id === id))) return Response.json({ message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' }, { status: 422 });
      const token = `ghs_${'f'.repeat(36)}${state.issued.length}`;
      state.issued.push({ token, installationId, body });
      const named = body.repository_ids === undefined ? held : held.filter(repository => body.repository_ids!.includes(repository.id));
      return Response.json({ token, expires_at: state.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
        permissions: Object.fromEntries(Object.keys(body.permissions).filter(name => state.granted[name] === 'read').map(name => [name, 'read'])),
        repository_selection: 'selected', repositories: named.map(repositoryAnswer) }, { status: 201 });
    }
    const minted = state.issued.find(entry => entry.token === bearer && !state.revoked.includes(bearer));
    // https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token
    if (request.method === 'DELETE' && url.pathname === '/installation/token') {
      if (minted === undefined) return Response.json({ message: 'Bad credentials' }, { status: 401 });
      state.revoked.push(bearer);
      return new Response(null, { status: 204 });
    }
    // https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation
    if (request.method === 'GET' && url.pathname === '/installation/repositories' && minted !== undefined) {
      const held = repositories.get(minted.installationId) ?? [];
      return Response.json({ total_count: held.length, repositories: held.map(repositoryAnswer) });
    }
    throw new Error(`fixture GitHub: unexpected request ${request.method} ${url.pathname}`);
  };
  return { fetchImpl, state };
}

/** A Deployment environment holding the App key, whose outbound requests reach the fixture. */
export const withApp = <Env extends Pick<ServerEnv, 'secrets' | 'outbound'>>(env: Env, github: ReturnType<typeof githubFixture>): Env =>
  ({ ...env, secrets: { ...env.secrets, ...APP_SECRETS }, outbound: github.fetchImpl });

/** Connects `projectId` to the fixture's source the way an admin does: approve the operator's account, then save. */
export async function connectRepository(env: Pick<ServerEnv, 'db' | 'secrets' | 'outbound'>, projectId: string, options: { branch?: string; actor?: string; now?: number } = {}) {
  const now = options.now ?? Date.now();
  await approveAccount(env.db, { accountId: OPERATOR.account.id, login: OPERATOR.account.login, type: OPERATOR.account.type }, options.actor ?? 'mem_machine_1', now);
  return (await projectRepositories(env).save(projectId, { installationId: OPERATOR.installationId, repositoryId: SOURCE.id, branch: options.branch ?? 'main', revision: null }, options.actor ?? 'mem_machine_1', now))!;
}

/** As `withApp`, with repository reads (anything outside GitHub's App and installation endpoints) answered by `reads`. */
export const withReads = <Env extends Pick<ServerEnv, 'secrets' | 'outbound'>>(env: Env, github: ReturnType<typeof githubFixture>, reads: OutboundFetch): Env => ({
  ...withApp(env, github),
  outbound: (input, init) => /^\/(app|installation)\//.test(new URL(input instanceof Request ? input.url : String(input)).pathname) ? github.fetchImpl(input, init) : reads(input, init),
});

/** A configured App key that cannot sign: local readiness holds, and no request can reach GitHub. */
export const UNSIGNED_APP = { GITHUB_CLIENT_ID: OWNER_ENV.GITHUB_CLIENT_ID, GITHUB_APP_PRIVATE_KEY: 'configured-app-key-that-cannot-sign' };

/** The row an admin's App connection leaves, for tests that only read the stored connection. */
export const storedConnection = (projectId: string, source: { url?: string; branch?: string; revision?: string; updatedAt?: number } = {}): [string, Array<string | number>] => [
  `INSERT OR REPLACE INTO project_repositories(project_id,revision,url,branch,github_repository_id,github_installation_id,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,'fixture')`,
  [projectId, source.revision ?? 'r1', source.url ?? SOURCE_URL, source.branch ?? 'main', SOURCE.id, OPERATOR.installationId, source.updatedAt ?? 0],
];
