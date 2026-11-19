import { describe, expect, it, spyOn } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { issueIdentityLinkAuthority, spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { tryNameMemberFromLogin } from '@myco-server-worker/auth/members-admin.js';
import { memberNamingFailures } from '@myco-server-worker/db/meta/member-naming-failure.js';
import { unarchiveProject, createProject } from '@myco-server-worker/db/storage/projects.js';
import { handleUnarchiveProject } from '@myco-server-worker/api/projects.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { OWNER_ENV, PRINCIPAL, ownerCookie } from './helpers/owner.js';
import { saveReleaseSettings, type ReleaseSettingsValues } from '@myco-server-worker/db/settings/release-connection.js';
import { releaseDueAfterSave } from '@myco-server-worker/db/release/due.js';
import { deploymentIdentity } from '@myco-server-worker/auth/authorization.js';
import { MAX_PROJECTS } from '@myco-server-worker/constants.js';
import type { OwnerContext } from '@myco-server-worker/context.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';

const NOW = 1_800_000_000_000;
describe('identity and Project atomic writes', () => {
  it('keeps a link usable when the bind fails after spending, then commits its identity and owner together', async () => {
    const r = sqliteEnv();
    r.sqlite.run("UPDATE members SET github_id=NULL; UPDATE deployment_ownership SET member_id=NULL,bootstrap_mode='fresh'");
    const key = (await issueIdentityLinkAuthority(r.db, 'mem_machine_1', NOW))!;
    r.sqlite.run("CREATE TRIGGER fail_bind BEFORE UPDATE OF github_id ON members BEGIN SELECT RAISE(ABORT,'fixture bind failure'); END");
    await expect(spendIdentityLinkAuthority(r.db, key.key, '9001', NOW)).rejects.toThrow('fixture bind failure');
    expect(r.sqlite.query('SELECT used_at,used_by FROM identity_link_authorities WHERE id=?').get(key.id)).toEqual({
      used_at: null,
      used_by: null,
    });
    expect(r.sqlite.query("SELECT github_id FROM members WHERE id='mem_machine_1'").get()).toEqual({ github_id: null });
    expect(r.sqlite.query('SELECT member_id FROM deployment_ownership').get()).toEqual({ member_id: null });
    r.sqlite.run('DROP TRIGGER fail_bind');
    expect(await spendIdentityLinkAuthority(r.db, key.key, '9001', NOW)).toMatchObject({ ok: true });
    expect(r.sqlite.query('SELECT member_id FROM deployment_ownership').get()).toEqual({ member_id: 'mem_machine_1' });
    expect(r.sqlite.query("SELECT member_id FROM deployment_ownership_audit WHERE member_id='mem_machine_1'").all()).toHaveLength(1);
  });

  it('refuses a restore when a competing creation fills Project capacity', async () => {
    const r = sqliteEnv();
    r.sqlite.query("UPDATE projects SET archived_at=1,archived_by='fixture' WHERE project_id='proj_1'").run();
    const active = (r.sqlite.query('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL').get() as { n: number }).n;
    r.sqlite
      .query(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO projects(project_id,name,created_at) SELECT 'capacity_'||i,'Capacity',1 FROM n`,
      )
      .run(MAX_PROJECTS - active - 1);
    const racing: RelationalStore = {
      prepare: (sql) => r.db.prepare(sql),
      batch: (statements) =>
        r.db.batch([r.db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('last_slot','Last',1)"), ...statements]),
    };
    const url = new URL('https://s/api/projects/proj_1/unarchive');
    const context: OwnerContext = {
      request: new Request(url, { method: 'POST' }), url,
      params: { projectId: 'proj_1' }, member: PRINCIPAL, now: NOW, source: '192.0.2.5',
      session: { aud: await deploymentIdentity(r.db), sub: '583231', login: 'octocat', iat: NOW, exp: NOW + 60_000 },
      config: { clientId: OWNER_ENV.GITHUB_CLIENT_ID, clientSecret: OWNER_ENV.GITHUB_CLIENT_SECRET, sessionSecret: OWNER_ENV.SESSION_SECRET },
    };
    const response = await handleUnarchiveProject({ ...r.serverEnv, db: racing }, context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'project_limit', active: MAX_PROJECTS, limit: MAX_PROJECTS,
      reason: `Project was not restored: ${MAX_PROJECTS} of ${MAX_PROJECTS} active Projects. Archive a Project, then call POST /api/projects/proj_1/unarchive again.`,
      nextCall: 'POST /api/projects/proj_1/unarchive',
    });
    expect(r.sqlite.query("SELECT archived_at,archived_by FROM projects WHERE project_id='proj_1'").get()).toEqual({
      archived_at: 1,
      archived_by: 'fixture',
    });
    expect(r.sqlite.query("SELECT project_id FROM projects WHERE project_id='last_slot'").get()).toBeNull();
    expect(await unarchiveProject(r.db, 'proj_1')).toBe('restored');
    expect(await createProject(r.db, 'over_capacity', 'Over capacity', NOW)).toBe(false);
  });

  it('preserves naming and authentication outcomes while classifying the bounded diagnostic on every sign-in surface', async () => {
    for (const operation of ['direct', 'me', 'link', 'approve'] as const) {
      const r = sqliteEnv();
      const now = Date.now();
      const memberId = operation === 'link' ? 'mem_machine_2' : 'mem_machine_1';
      const githubId = operation === 'link' ? '770001' : '583231';
      // Labelled only by its own id, the member names nobody, so every surface attempts the naming write.
      r.sqlite.query('UPDATE members SET label=id WHERE id=?').run(memberId);
      r.sqlite.run("CREATE TRIGGER fail_login BEFORE INSERT ON schema_meta WHEN NEW.key LIKE 'github_login:%' BEGIN SELECT RAISE(ABORT,'D1_ERROR: private-storage-detail'); END");
      const output: string[] = [];
      const log = spyOn(console, 'log').mockImplementation(line => { output.push(String(line)); });
      try {
        const server = createServer({ now: () => now, sourceOf: () => '192.0.2.5', fetchImpl: () => { throw new Error('no OAuth'); } });
        const env = { ...r.serverEnv, secrets: OWNER_ENV };
        const request = async (path: string, body?: unknown) => server.handleRequest(new Request('https://s'+path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { cookie: await ownerCookie(r.db, now, githubId), origin: 'https://s' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }), env);
        if (operation === 'direct') {
          expect(await tryNameMemberFromLogin(r.db, memberId, githubId, 'octocat', env.platform.classifyError)).toBeNull();
        } else if (operation === 'me') {
          const response = await request('/auth/me');
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ member: { id: memberId, label: memberId } });
        } else if (operation === 'link') {
          const key = (await issueIdentityLinkAuthority(r.db, memberId, now, { issuedBy: 'mem_machine_1' }))!;
          const response = await request('/auth/link', { key: key.key, confirm: true });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ linked: true, member: { id: memberId, label: memberId } });
          expect(r.sqlite.query('SELECT github_id FROM members WHERE id=?').get(memberId)).toEqual({ github_id: githubId });
        } else {
          const start = await request('/auth/device/start', { machineId: 'courtesy', machineName: 'Laptop', os: 'linux' });
          const grant = await start.json() as { user_code: string; device_code: string };
          expect((await request('/api/device/approve', { user_code: grant.user_code })).status).toBe(200);
          expect(await (await request('/auth/device/poll', { device_code: grant.device_code })).json()).toMatchObject({ joined: true, memberId });
        }
        const events = output.map(line => JSON.parse(line)).filter(event => event.kind === 'member_naming_failed');
        expect(events).toEqual([{ kind: 'member_naming_failed', memberId, error_class: 'db', error_reason: 'Unknown:db' }]);
        expect(JSON.stringify(events)).not.toContain('private-storage-detail');
        expect(r.sqlite.query('SELECT label FROM members WHERE id=?').get(memberId)).toEqual({ label: memberId });
        expect(await memberNamingFailures(r.db)).toMatchObject({ hasMore: false, members: [{ memberId, errorClass: 'db', failures: 1, lastFailedAt: expect.any(Number) }] });
        r.sqlite.run('DROP TRIGGER fail_login');
        expect(await tryNameMemberFromLogin(r.db, memberId, githubId, 'octocat', env.platform.classifyError)).toBe('octocat');
        expect(await memberNamingFailures(r.db)).toEqual({ members: [], hasMore: false });
      } finally { log.mockRestore(); r.sqlite.close(); }
    }
  });

  it('rejects a release constraint violation without committing its due row', async () => {
    const r = sqliteEnv();
    const revision = 'fixture-release-revision';
    const values: ReleaseSettingsValues = [revision, 2, '[]', '[]', '[]', 1, 10, NOW, 'mem_machine_1'];
    const due = releaseDueAfterSave({ projectId: 'proj_1', revision, tracked: true });
    await expect(saveReleaseSettings(r.db, { project: 'proj_1', previous: null, values, now: NOW, due })).rejects.toThrow();
    expect(r.sqlite.query("SELECT revision FROM project_release_provenance WHERE project_id='proj_1'").all()).toEqual([]);
    expect(r.sqlite.query("SELECT project_id FROM release_check_due WHERE project_id='proj_1'").all()).toEqual([]);
    values[1] = 1;
    expect(await saveReleaseSettings(r.db, { project: 'proj_1', previous: null, values, now: NOW, due })).toBe(true);
    expect(r.sqlite.query("SELECT revision,updated_by AS actor FROM project_release_provenance WHERE project_id='proj_1'").get()).toEqual({ revision, actor: 'mem_machine_1' });
  });

});
