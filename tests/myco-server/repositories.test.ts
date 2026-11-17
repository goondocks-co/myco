import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare/source.js';
import { GitHubAccessRefused, githubAppProjects } from '@myco-server-worker/core/github-app.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import { APP_SECRETS, githubFixture, OPERATOR, SOURCE, SOURCE_URL, STRANGER } from './helpers/github-app.js';

function rig(options: { key?: boolean } = {}) {
  const fixture = sqliteEnv();
  seedMemberRoleAccount(fixture.sqlite);
  const github = githubFixture();
  const server = createServer({ now: Date.now, sourceOf: cloudflareSourceOf, fetchImpl: github.fetchImpl });
  const env = () => ({ ...serverEnvFromBindings({ ...fixture.env, ...OWNER_ENV, ...(options.key === false ? {} : APP_SECRETS) } as never), outbound: github.fetchImpl });
  const call = async (method: string, path: string, body?: unknown) => {
    const request = method === 'GET' ? await asOwner(fixture.db, path) : new Request(await asOwnerPost(fixture.db, path, body ?? {}), { method });
    const response = await server.handleRequest(request, env());
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  const asMember = async (method: string, path: string) => (await server.handleRequest(new Request(`https://s${path}`, { method,
    headers: { cookie: await ownerCookie(fixture.db, Date.now(), MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}' }), env())).status;
  return { ...fixture, github, env, call, asMember };
}

const REPOSITORY = '/api/projects/proj_1/repository';
const choose = (installationId: number, revision: string | null = null) => ({ installationId, repositoryId: SOURCE.id, branch: 'main', revision });

describe('a Project repository connected through the Deployment’s GitHub App', () => {
  it('an admin approves the operator’s account, connects a repository it chose, and no token reaches a response or a stored row', async () => {
    const r = rig();
    const listed = await r.call('GET', '/api/github-app/installations');
    expect(listed.body.installations).toEqual([
      { installationId: OPERATOR.installationId, account: OPERATOR.account, approved: false, suspended: false },
      { installationId: STRANGER.installationId, account: STRANGER.account, approved: false, suspended: false },
    ]);
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
    await expect(githubAppProjects(r.env()).issue(saved, 'checkout')).rejects.toEqual(new GitHubAccessRefused('account_not_approved'));
    expect(r.github.state.issued).toHaveLength(1);
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
