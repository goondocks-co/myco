import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare/source.js';
import { GitHubAccessRefused, githubAppProjects } from '@myco-server-worker/core/github-app.js';
import { SUGGESTION_PAGES } from '@myco-server-worker/core/github-app-setup.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import { githubAppChecklist, githubAppHeadline, type GitHubAppSetup } from '@goondocks/myco-shared/github-app-setup';
import { APP, APP_SECRETS, githubFixture, OPERATOR, SOURCE, SOURCE_URL, STRANGER } from './helpers/github-app.js';

const ORIGIN = 'https://myco.example.com';
/** GitHub's public page for an App at the slug `Myco (myco.example.com)` implies. https://docs.github.com/en/rest/apps/apps#get-an-app */
const PUBLIC_PATH = '/apps/myco-myco-example-com';

function rig(options: { key?: boolean } = {}) {
  const fixture = sqliteEnv();
  seedMemberRoleAccount(fixture.sqlite);
  const github = githubFixture();
  const publicPage = { current: { ...APP, slug: 'myco-myco-example-com', name: 'Myco (myco.example.com)', permissions: { metadata: 'read' } } as Record<string, unknown> };
  const outbound: typeof github.fetchImpl = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname !== PUBLIC_PATH) return github.fetchImpl(input, init);
    expect(request.headers.has('authorization')).toBe(false);
    return Response.json(publicPage.current);
  };
  const server = createServer({ now: Date.now, sourceOf: cloudflareSourceOf, fetchImpl: outbound });
  const env = () => ({ ...serverEnvFromBindings({ ...fixture.env, ...OWNER_ENV, MYCO_ORIGIN: ORIGIN, ...(options.key === false ? {} : APP_SECRETS) } as never), outbound });
  const call = async (method: string, path: string, body?: unknown) => {
    const request = method === 'GET' ? await asOwner(fixture.db, path) : new Request(await asOwnerPost(fixture.db, path, body ?? {}), { method });
    const response = await server.handleRequest(request, env());
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  const asMember = async (method: string, path: string) => (await server.handleRequest(new Request(`https://s${path}`, { method,
    headers: { cookie: await ownerCookie(fixture.db, Date.now(), MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}' }), env())).status;
  /** The setup facts, and the checklist and headline the dashboard derives from them. */
  const setup = async () => {
    const answer = await call('GET', '/api/github-app');
    const steps = githubAppChecklist(answer.body as GitHubAppSetup, ORIGIN);
    return { ...answer, headline: githubAppHeadline(steps, answer.body as GitHubAppSetup), step: Object.fromEntries(steps.map(step => [step.id, step])) };
  };
  return { ...fixture, github, env, call, asMember, setup, publicPage };
}

const REPOSITORY = '/api/projects/proj_1/repository';
const choose = (installationId: number, revision: string | null = null) => ({ installationId, repositoryId: SOURCE.id, branch: 'main', revision });

describe('a Project repository connected through the Deployment’s GitHub App', () => {
  it('an admin approves the operator’s account, connects a repository it chose, and no token reaches a response or a stored row', async () => {
    const r = rig();
    const listed = await r.call('GET', '/api/github-app/installations');
    expect(listed.body).toMatchObject({ page: 1, more: false, installations: [
      { installationId: OPERATOR.installationId, account: OPERATOR.account, approved: false, suspended: false },
      { installationId: STRANGER.installationId, account: STRANGER.account, approved: false, suspended: false },
    ] });
    const choices = `/api/github-app/installations/${OPERATOR.installationId}/repositories`;
    expect((await r.call('GET', choices)).body).toMatchObject({ failure: 'account_not_approved' });
    const approved = await r.call('POST', '/api/github-app/accounts', { installationId: OPERATOR.installationId });
    expect(approved.body.account).toMatchObject({ accountId: OPERATOR.account.id, login: 'operator-org', type: 'Organization', approvedBy: 'mem_machine_1' });
    expect((await r.call('GET', choices)).body).toEqual({ repositories: [{ id: SOURCE.id, fullName: 'example/source', defaultBranch: 'main', private: true }], more: false });
    const saved = await r.call('PUT', REPOSITORY, choose(OPERATOR.installationId));
    expect(saved.body.repository).toMatchObject({ url: SOURCE_URL, branch: 'main', repositoryId: SOURCE.id, installationId: OPERATOR.installationId, updatedBy: 'mem_machine_1' });
    expect((await r.call('GET', REPOSITORY)).body).toEqual({ repository: saved.body.repository, appConfigured: true });
    // Discovery reads metadata only; the save's check reads one repository; both end as soon as they are used.
    expect(r.github.state.issued.map(entry => entry.body)).toEqual([
      { permissions: { metadata: 'read' } },
      { permissions: { contents: 'read', metadata: 'read' }, repository_ids: [SOURCE.id] },
    ]);
    expect(r.github.state.revoked).toEqual(r.github.state.issued.map(entry => entry.token));
    const stored = JSON.stringify([r.sqlite.query('SELECT * FROM project_repositories').all(), r.sqlite.query('SELECT * FROM deployment_secrets').all()]);
    for (const { token } of r.github.state.issued) for (const text of [listed.text, saved.text, stored]) expect(text).not.toContain(token);
    for (const [method, path] of [['GET', '/api/github-app/installations'], ['GET', choices], ['POST', '/api/github-app/accounts'], ['PUT', REPOSITORY], ['GET', REPOSITORY]]) {
      expect(await r.asMember(method!, path!)).toBe(403);
    }
  });

  it('never offers, saves or mints for an installation whose account this Deployment has not approved', async () => {
    const r = rig();
    await r.call('POST', '/api/github-app/accounts', { installationId: OPERATOR.installationId });
    expect((await r.call('GET', `/api/github-app/installations/${STRANGER.installationId}/repositories`)).body).toMatchObject({ failure: 'account_not_approved' });
    const refused = await r.call('PUT', REPOSITORY, choose(STRANGER.installationId));
    expect(refused).toMatchObject({ status: 409, body: { failure: 'account_not_approved', reason: expect.stringContaining('has not approved') } });
    expect(r.github.state.issued.filter(entry => entry.installationId === STRANGER.installationId)).toEqual([]);
    const saved = (await r.call('PUT', REPOSITORY, choose(OPERATOR.installationId))).body.repository;
    expect((await r.call('DELETE', `/api/github-app/accounts/${OPERATOR.account.id}`)).body).toEqual({ withdrawn: true });
    await expect(githubAppProjects(r.env()).withToken(saved, 'checkout', async () => 'used')).rejects.toEqual(new GitHubAccessRefused('account_not_approved'));
    expect(r.github.state.issued).toHaveLength(1);
  });

  it('pages installations by number on GitHub’s own origin, and names what to fix in GitHub before any token exists', async () => {
    const r = rig();
    const later = { installationId: 77, account: { id: 7700, login: 'second-page-org', type: 'Organization' as const } };
    r.github.state.laterInstallations.push(later);
    expect((await r.call('GET', '/api/github-app/installations')).body).toMatchObject({ page: 1, more: true });
    expect((await r.call('GET', '/api/github-app/installations?page=2')).body).toMatchObject({ page: 2, more: false, installations: [{ installationId: 77, account: later.account }] });
    expect(r.github.state.requests.filter(line => line.startsWith('GET /app/installations?'))).toEqual(['GET /app/installations?per_page=100&page=1', 'GET /app/installations?per_page=100&page=2']);
    expect((await r.call('GET', '/api/github-app/installations?page=0')).status).toBe(400);
    await r.call('POST', '/api/github-app/accounts', { installationId: OPERATOR.installationId });
    r.github.state.granted = { metadata: 'read' };
    expect(await r.call('PUT', REPOSITORY, choose(OPERATOR.installationId))).toMatchObject({ status: 409, body: { failure: 'permissions_missing', reason: expect.stringContaining('Approve the App’s requested permissions') } });
    expect(r.github.state.issued).toEqual([]);
    r.github.state.granted = { contents: 'read', pull_requests: 'read', metadata: 'read' };
    r.github.state.mintStatus = 422;
    const refused = await r.call('PUT', REPOSITORY, choose(OPERATOR.installationId));
    expect(refused).toMatchObject({ status: 409, body: { failure: 'access_refused' } });
    expect(refused.text).not.toContain('upstream validation detail');
  });

  it('derives each setup step live: finds the App before its key, names what remains, and says set up only once a Project reads its repository', async () => {
    const keyless = rig({ key: false });
    const before = await keyless.setup();
    expect(before.body).toMatchObject({ target: 'cloudflare', origin: ORIGIN, key: { state: 'key_absent' }, installations: null, repository: null,
      app: { slug: 'myco-myco-example-com', owner: { login: 'operator-org', type: 'Organization' }, source: 'public' } });
    expect(before.step.permissions).toMatchObject({ state: 'todo', title: 'Repository permissions need changes: contents must be read-only (currently absent); pull_requests must be read-only (currently absent).',
      links: [{ label: 'Open the App’s permissions', href: 'https://github.com/organizations/operator-org/settings/apps/myco-myco-example-com/permissions' }] });
    expect(before.step['sign-in'].title).toBe('Sign-in is configured: this server holds the App’s Client ID and secret.');
    expect(before.step.key).toMatchObject({ state: 'todo', commands: [`myco server github-app --target cloudflare --url ${ORIGIN} --private-key-file <downloaded.pem>`] });
    expect(before.step.installed).toMatchObject({ state: 'waiting', links: [{ href: 'https://github.com/apps/myco-myco-example-com/installations/new' }] });
    expect(before.headline).toBe('Repository access is not set up yet: 5 of 6 steps remain. Next: Repository permissions need changes: contents must be read-only (currently absent); pull_requests must be read-only (currently absent).');
    keyless.publicPage.current = { ...keyless.publicPage.current, client_id: 'another-app' };
    expect((await keyless.setup()).body).toMatchObject({ app: null, expectedName: 'Myco (myco.example.com)' });
    keyless.publicPage.current = { ...keyless.publicPage.current, client_id: OWNER_ENV.GITHUB_CLIENT_ID, name: 'x'.repeat(70_000) };
    expect((await keyless.setup()).body).toMatchObject({ app: null, lookupError: expect.stringContaining('at most 65536 are read') });

    const r = rig();
    const installed = await r.setup();
    expect(installed.step.installed.title).toBe('Installed on operator-org (an organization), operat0r-org (an organization).');
    expect(installed.step.approved.state).toBe('todo');
    expect(installed.headline).toBe('Repository access is not set up yet: 2 of 6 steps remain. Next: Approve an account that installed the App.');
    await r.call('POST', '/api/github-app/accounts', { installationId: OPERATOR.installationId });
    expect((await r.setup()).step.connected).toMatchObject({ state: 'todo', title: 'Connect a repository to a Project.' });
    await r.call('PUT', REPOSITORY, choose(OPERATOR.installationId));
    r.github.state.installationGranted = { contents: 'read', metadata: 'read' };
    const done = await r.setup();
    expect(done.headline).toBe('Repository access is set up: a reads example/source.');
    expect(done.step.installed.detail).toContain('operator-org (an organization) has not accepted the new permissions. It accepts them in GitHub, in its installation’s settings.');
    r.github.state.installationGranted = null;
    r.github.state.suspended.add(OPERATOR.installationId);
    expect((await r.setup()).step.connected).toMatchObject({ state: 'failed', title: expect.stringContaining('a’s repository can’t be read: The App installation was removed or suspended') });
    expect(r.github.state.revoked).toEqual(r.github.state.issued.map(entry => entry.token));
    for (const { token } of r.github.state.issued) expect(done.text).not.toContain(token);
    expect(done.text).not.toContain(APP_SECRETS.GITHUB_APP_PRIVATE_KEY);
    expect(await r.asMember('GET', '/api/github-app')).toBe(403);
  });

  it('calls a failed sample of connections inconclusive, and keeps a throttled App check from reading as a rejected key', async () => {
    const r = rig();
    await r.call('POST', '/api/github-app/accounts', { installationId: OPERATOR.installationId });
    await r.call('POST', '/api/github-app/accounts', { installationId: STRANGER.installationId });
    await r.call('PUT', REPOSITORY, choose(OPERATOR.installationId));
    await Bun.sleep(5);
    for (const id of ['proj_c', 'proj_d']) expect((await r.call('POST', '/api/projects', { projectId: id, name: id.slice(-1) })).status).toBe(201);
    for (const id of ['proj_2', 'proj_c', 'proj_d']) await r.call('PUT', `/api/projects/${id}/repository`, { installationId: STRANGER.installationId, repositoryId: 7770001, branch: 'main', revision: null });
    r.github.state.suspended.add(STRANGER.installationId);
    const sampled = await r.setup();
    expect(sampled.headline).toMatch(/^Repository access could not be confirmed for the Projects checked: (?=.*\bb\b)(?=.*\bc\b)(?=.*\bd\b)[bcd, ]+\. To check another, open that Project’s Settings → Repository and save its repository again; saving checks it with GitHub\.$/);
    expect(sampled.step.connected.detail).toContain('1 other connected Project was not checked. To check another, open that Project’s Settings → Repository and save its repository again; saving checks it with GitHub.');
    r.github.state.appLimitedUntil = Date.UTC(2026, 10, 19, 14, 5) / 1000;
    const throttled = await r.setup();
    expect(throttled.body.key).toEqual({ state: 'rate_limited', reason: 'GitHub’s rate limit was reached; try again after 14:05 UTC.' });
    expect(throttled.step.key).toMatchObject({ state: 'waiting', title: 'GitHub’s rate limit was reached; try again after 14:05 UTC.', commands: [] });
    expect(throttled.step.installed.title).toBe('GitHub did not list the App’s installations: GitHub’s rate limit was reached; try again after 14:05 UTC.');
    expect((await r.call('GET', '/api/github-app/installations')).body).toMatchObject({ failure: 'rate_limited' });
  });

  it('proposes the one same-named repository for each Project with none, and connects nothing itself', async () => {
    const r = rig();
    expect((await r.call('POST', '/api/projects', { projectId: 'proj_source', name: 'Source' })).status).toBe(201);
    const proposals = () => r.call('GET', '/api/github-app/suggestions');
    expect((await proposals()).body).toEqual({ suggestions: [], complete: true, withheld: [] });
    await r.call('POST', '/api/github-app/accounts', { installationId: OPERATOR.installationId });
    const proposal = { projectId: 'proj_source', project: 'Source', installationId: OPERATOR.installationId, repositoryId: SOURCE.id, fullName: 'example/source', defaultBranch: 'main' };
    expect((await proposals()).body).toEqual({ suggestions: [proposal], complete: true, withheld: [] });
    const withheld = { suggestions: [], complete: false, withheld: [{ projectId: 'proj_source', project: 'Source' }] };
    // A second match on an installation page that was not read.
    const later = { installationId: 77, account: { id: 7700, login: 'later-org', type: 'Organization' as const } };
    r.github.state.laterInstallations.push(later);
    r.github.repositories.set(later.installationId, [{ id: 7700001, full_name: 'later-org/source', default_branch: 'main', private: true }]);
    await r.call('POST', '/api/github-app/accounts', { installationId: later.installationId });
    expect((await proposals()).body).toEqual(withheld);
    r.github.state.laterInstallations.length = 0;
    // A second match past the repository pages read.
    const filler = Array.from({ length: SUGGESTION_PAGES * 100 }, (_, index) => ({ id: 8_000_000 + index, full_name: `operat0r-org/filler-${index}`, default_branch: 'main', private: true }));
    r.github.repositories.set(STRANGER.installationId, [...filler, { id: 7770001, full_name: 'operat0r-org/source', default_branch: 'main', private: false }]);
    await r.call('POST', '/api/github-app/accounts', { installationId: STRANGER.installationId });
    expect((await proposals()).body).toEqual(withheld);
    r.github.repositories.set(STRANGER.installationId, [{ id: 7770001, full_name: 'operat0r-org/source', default_branch: 'main', private: false }]);
    expect((await r.call('GET', '/api/projects/proj_source/repository')).body.repository).toBeNull();
    expect((await proposals()).body).toEqual({ suggestions: [], complete: true, withheld: [] });
    await r.call('DELETE', `/api/github-app/accounts/${STRANGER.account.id}`);
    await r.call('PUT', '/api/projects/proj_source/repository', { installationId: proposal.installationId, repositoryId: proposal.repositoryId, branch: proposal.defaultBranch, revision: null });
    expect((await proposals()).body.suggestions).toEqual([]);
    expect(await r.asMember('GET', '/api/github-app/suggestions')).toBe(403);
  });

  it('refuses the token-era body by name, a stale writer and a keyless Deployment, and disconnects only the current revision', async () => {
    const r = rig();
    await r.call('POST', '/api/github-app/accounts', { installationId: OPERATOR.installationId });
    for (const field of ['url', 'credential']) {
      const refused = await r.call('PUT', REPOSITORY, { ...choose(OPERATOR.installationId), [field]: field === 'url' ? SOURCE_URL : { username: 'x', token: 'y' } });
      expect(refused).toMatchObject({ status: 400, body: { reason: expect.stringContaining(`\`${field}\` is no longer accepted`) } });
    }
    const saved = (await r.call('PUT', REPOSITORY, choose(OPERATOR.installationId))).body.repository;
    expect((await r.call('PUT', REPOSITORY, choose(OPERATOR.installationId, 'stale'))).status).toBe(409);
    expect((await r.call('DELETE', REPOSITORY, { revision: 'stale' })).status).toBe(409);
    expect((await r.call('DELETE', REPOSITORY, { revision: saved.revision })).body).toEqual({ removed: true });
    expect((await r.call('GET', REPOSITORY)).body.repository).toBeNull();
    const keyless = rig({ key: false });
    expect((await keyless.call('GET', REPOSITORY)).body).toEqual({ repository: null, appConfigured: false });
    expect((await keyless.call('PUT', REPOSITORY, choose(OPERATOR.installationId))).body).toMatchObject({ failure: 'app_not_configured', reason: expect.stringContaining('myco server github-app') });
    expect(keyless.github.state.requests).toEqual([]);
  });
});
