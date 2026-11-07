import { describe, expect, it, spyOn } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { issueIdentityLinkAuthority, spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { tryNameMemberFromLogin } from '@myco-server-worker/auth/members-admin.js';
import { unarchiveProject } from '@myco-server-worker/read/sessions.js';
import { createProject } from '@myco-server-worker/core/project-creation.js';
import { handleUnarchiveProject } from '@myco-server-worker/api/projects.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { releaseProvenance } from '@myco-server-worker/core/release-provenance.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
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

  it('admits unarchive against the capacity inside its batch and names the refusal through the API', async () => {
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
    const response = await handleUnarchiveProject({ ...r.serverEnv, db: racing }, {
      params: { projectId: 'proj_1' },
      member: { id: 'mem_machine_1' },
      now: NOW,
    } as OwnerContext);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'project_limit' });
    expect(r.sqlite.query("SELECT archived_at,archived_by FROM projects WHERE project_id='proj_1'").get()).toEqual({
      archived_at: 1,
      archived_by: 'fixture',
    });
    expect(r.sqlite.query("SELECT project_id FROM projects WHERE project_id='last_slot'").get()).toBeNull();
    expect(await unarchiveProject(r.db, 'proj_1')).toBe('restored');
    expect(await createProject(r.db, 'over_capacity', 'Over capacity', NOW)).toBe(false);
  });

  it('rolls naming back and reports one bounded failure while sign-in remains usable', async () => {
    const r = sqliteEnv();
    r.sqlite.run("UPDATE members SET label=NULL WHERE id='mem_machine_1'");
    r.sqlite.run(
      "CREATE TRIGGER fail_login BEFORE INSERT ON schema_meta WHEN NEW.key LIKE 'github_login:%' BEGIN SELECT RAISE(ABORT,'private-storage-detail'); END",
    );
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await tryNameMemberFromLogin(r.db, 'mem_machine_1', '583231', 'octocat')).toBeNull();
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter((event) => event.kind === 'member_naming_failed');
      expect(events).toEqual([
        { kind: 'member_naming_failed', memberId: 'mem_machine_1', error_class: 'unknown', error_reason: 'Unknown:unknown' },
      ]);
      expect(JSON.stringify(events)).not.toContain('private-storage-detail');
      expect(r.sqlite.query("SELECT label FROM members WHERE id='mem_machine_1'").get()).toEqual({ label: null });
      r.sqlite.run('DROP TRIGGER fail_login');
      expect(await tryNameMemberFromLogin(r.db, 'mem_machine_1', '583231', 'octocat')).toBe('octocat');
    } finally {
      log.mockRestore();
    }
  });

  it('retains the old ciphertext and reference when either secret replacement fails at retirement', async () => {
    for (const kind of ['repository', 'release'] as const) {
      const r = sqliteEnv();
      r.env.SECRET_WRAP_KEY = { get: async () => btoa('a'.repeat(32)) };
      const secrets = deploymentSecretStore(r.db, r.serverEnv.wrappingKey);
      const repositories = projectRepositories(r.db, secrets);
      const releases = releaseProvenance(r.db, secrets);
      const save = (revision: string | null, token: string) =>
        kind === 'repository'
          ? repositories.save(
              'proj_1',
              { revision, url: 'https://github.com/example/project.git', branch: 'main', credential: { username: 'reader', token } },
              'mem_machine_1',
              NOW,
            )
          : releases.save(
              'proj_1',
              {
                revision,
                enabled: true,
                githubRepo: 'example/project',
                productionRefs: ['refs/tags/v*'],
                integrationRefs: ['origin/main'],
                packageMap: [],
                includeUnknown: true,
                maxLookups: 10,
                credential: { token },
              },
              'mem_machine_1',
              NOW,
            );
      const first = (await save(null, 'fixture-old-token'))!;
      const table = kind === 'repository' ? 'project_repositories' : 'project_release_provenance';
      const before = r.sqlite.query(`SELECT * FROM ${table}`).all();
      const secretBefore = r.sqlite.query('SELECT * FROM deployment_secrets').all();
      r.sqlite.run(
        "CREATE TRIGGER fail_retire BEFORE DELETE ON deployment_secrets BEGIN SELECT RAISE(ABORT,'fixture retire failure'); END",
      );
      await expect(save(first.revision, 'fixture-new-token')).rejects.toThrow('fixture retire failure');
      expect(r.sqlite.query(`SELECT * FROM ${table}`).all()).toEqual(before);
      expect(r.sqlite.query('SELECT * FROM deployment_secrets').all()).toEqual(secretBefore);
      r.sqlite.run('DROP TRIGGER fail_retire');
      const next = (await save(first.revision, 'fixture-new-token'))!;
      expect(next.revision).not.toBe(first.revision);
      expect(await secrets.list()).toHaveLength(1);
    }
  });
});
