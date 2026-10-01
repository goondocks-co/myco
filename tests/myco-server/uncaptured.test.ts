/**
 * Repositories a member's machine joins by itself, or cannot (#1547): `POST /members/projects/resolve` and
 * `POST /members/uncaptured` from the machine, `GET /api/uncaptured` and its connect from the dashboard.
 *
 * A repository joins the project its remote names, or one created for it while the Deployment lets machines create
 * projects; racing resolves create one project; and a member reads and connects only their own machines' repositories.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MAX_PROJECTS } from '@myco-server-worker/constants.js';
import { revokeMember } from '@myco-server-worker/auth/members-admin.js';
import { pruneUncaptured, UNCAPTURED_RETENTION_MS } from '@myco-server-worker/ingest/uncaptured.js';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_PRINCIPAL, MEMBER_SUB, OWNER_ENV, PRINCIPAL, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const KEY_A = 'a'.repeat(16);
const KEY_B = 'b'.repeat(16);

async function rig() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  seedMemberRoleAccount(fixture.sqlite);
  const now = Date.now();
  for (const [machine, member] of [['machine_1', PRINCIPAL.id], ['machine_2', MEMBER_PRINCIPAL.id]]) {
    fixture.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at, label) VALUES (?, ?, ?, ?)`, [machine, member, now, `${machine}-laptop`]);
  }
  const admin = (await issueMemberToken(fixture.db, { memberId: PRINCIPAL.id, machineId: 'machine_1' }, now)).token;
  const member = (await issueMemberToken(fixture.db, { memberId: MEMBER_PRINCIPAL.id, machineId: 'machine_2' }, now)).token;
  const machine = async (token: string, path: string, body: unknown) => (await worker.fetch(memberPost(token, body, path), env)).json() as Promise<Record<string, any>>;
  const dashboard = async (method: string, path: string, sub: string | undefined, body?: unknown) => {
    const res = await worker.fetch(new Request(`https://s${path}`, {
      method,
      headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const projectsNamed = (name: string) => fixture.sqlite.query(`SELECT project_id FROM projects WHERE name = ?`).all(name) as Array<{ project_id: string }>;
  return { fixture, admin, member, machine, dashboard, projectsNamed };
}

describe('a machine resolving a repository', () => {
  it('creates a project named for the folder, binds its remote, and joins every other clone of it to the same project', async () => {
    const r = await rig();
    const first = await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'widget', remote: 'https://github.com/acme/widget.git' });
    expect(first).toMatchObject({ persisted: true, name: 'widget', created: true });
    const clone = await r.machine(r.admin, '/members/projects/resolve', { rootKey: KEY_B, label: 'widget-fork', remote: 'git@github.com:acme/widget.git' });
    expect(clone).toEqual({ persisted: true, projectId: first.projectId, name: 'widget', created: false });
    expect(r.projectsNamed('widget')).toEqual([{ project_id: first.projectId }]);
  });

  it('creates one project between resolves of a new repository racing each other', async () => {
    const r = await rig();
    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      r.machine(i % 2 === 0 ? r.member : r.admin, '/members/projects/resolve', { rootKey: KEY_A, label: 'racer', remote: 'https://github.com/acme/racer' })));
    expect(new Set(answers.map((a) => a.projectId)).size).toBe(1);
    expect(answers.filter((a) => a.created === true)).toHaveLength(1);
    expect(r.projectsNamed('racer')).toHaveLength(1);
  });

  it('creates nothing while the Deployment keeps project creation with admins, and records the repository for "Needs you"', async () => {
    const r = await rig();
    r.fixture.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('capture.auto_create_projects', 'false', 1, 'mem_machine_1')`);
    const answer = await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'widget', remote: 'https://github.com/acme/widget.git' });
    expect(answer).toMatchObject({ persisted: false, code: 'auto_create_off' });
    expect(r.projectsNamed('widget')).toEqual([]);
    expect(r.fixture.sqlite.query(`SELECT machine_id, root_key, member_id, label, reason, misses FROM uncaptured_roots`).all())
      .toEqual([{ machine_id: 'machine_2', root_key: KEY_A, member_id: MEMBER_PRINCIPAL.id, label: 'widget', reason: 'auto_create_off', misses: 1 }]);
    // Turned back on, the repository joins, and is no longer listed.
    r.fixture.sqlite.run(`DELETE FROM deployment_settings WHERE leaf = 'capture.auto_create_projects'`);
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'widget', remote: 'https://github.com/acme/widget.git' })).toMatchObject({ persisted: true, created: true });
    expect(r.fixture.sqlite.query(`SELECT COUNT(*) AS n FROM uncaptured_roots`).get()).toEqual({ n: 0 });
  });

  it('joins a repository with no remote only once it is connected, and the same project every time after', async () => {
    const r = await rig();
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'notes' })).toMatchObject({ persisted: false, code: 'no_remote' });
    expect((await r.dashboard('POST', `/api/uncaptured/machine_2/${KEY_A}/connect`, MEMBER_SUB)).body).toEqual({ connected: true, machineId: 'machine_2', rootKey: KEY_A, projectId: null });
    const joined = await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'notes' });
    expect(joined).toMatchObject({ persisted: true, name: 'notes', created: true });
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'notes' })).toMatchObject({ persisted: true, projectId: joined.projectId, created: false });
    expect(r.fixture.sqlite.query(`SELECT COUNT(*) AS n FROM uncaptured_roots`).get()).toEqual({ n: 0 });
  });

  it('refuses a repository whose project is archived, and one past the Deployment\'s project limit', async () => {
    const r = await rig();
    const made = await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'old', remote: 'https://github.com/acme/old' });
    r.fixture.sqlite.run(`UPDATE projects SET archived_at = 1 WHERE project_id = ?`, [made.projectId]);
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'old', remote: 'https://github.com/acme/old' })).toMatchObject({ persisted: false, code: 'archived' });
    const live = (r.fixture.sqlite.query(`SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL`).get() as { n: number }).n;
    for (let i = live; i < MAX_PROJECTS; i += 1) r.fixture.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, 1)`, [`proj_fill_${i}`, `fill ${i}`]);
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_B, label: 'new', remote: 'https://github.com/acme/new' })).toMatchObject({ persisted: false, code: 'refused' });
  });

  it('refuses a key that is not a repository key, and a folder name that is a path', async () => {
    const r = await rig();
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: 'nope', label: 'widget' })).toMatchObject({ persisted: false, code: 'invalid_field' });
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: '/Users/me/widget' })).toMatchObject({ persisted: false, code: 'invalid_field' });
  });
});

describe('a machine reporting a repository', () => {
  it('records one outside its folders, counting each report, and refuses a reason only the Deployment gives', async () => {
    const r = await rig();
    for (let i = 0; i < 2; i += 1) expect(await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_A, label: 'gadget', reason: 'outside_folders' })).toMatchObject({ persisted: true });
    expect(await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_A, label: 'gadget', reason: 'refused' })).toMatchObject({ persisted: false, code: 'invalid_field' });
    expect(r.fixture.sqlite.query(`SELECT reason, misses FROM uncaptured_roots`).all()).toEqual([{ reason: 'outside_folders', misses: 2 }]);
  });
});

describe('the dashboard', () => {
  async function seeded() {
    const r = await rig();
    await r.machine(r.admin, '/members/uncaptured', { rootKey: KEY_A, label: 'admins-repo', reason: 'outside_folders' });
    await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_B, label: 'members-repo', remote: 'https://github.com/acme/members-repo', reason: 'outside_folders' });
    return r;
  }

  it('lists a member their own machines\' repositories alone, with their own machine named, and an admin every machine\'s', async () => {
    const r = await seeded();
    const mine = await r.dashboard('GET', '/api/uncaptured', MEMBER_SUB);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toEqual([expect.objectContaining({
      machineId: 'machine_2', machineName: 'machine_2-laptop', member: { id: MEMBER_PRINCIPAL.id, label: MEMBER_PRINCIPAL.label },
      rootKey: KEY_B, label: 'members-repo', remote: 'github.com/acme/members-repo', reason: 'outside_folders', misses: 1,
    })]);
    const all = await r.dashboard('GET', '/api/uncaptured', undefined);
    expect(all.body.items.map((i: { label: string; machineName: string | null }) => [i.label, i.machineName]).sort())
      .toEqual([['admins-repo', 'machine_1-laptop'], ['members-repo', null]]);
  });

  it('lets a member connect their own machine\'s repository and no other member\'s, and forgets it once connected', async () => {
    const r = await seeded();
    expect((await r.dashboard('POST', `/api/uncaptured/machine_1/${KEY_A}/connect`, MEMBER_SUB)).status).toBe(404);
    expect((await r.dashboard('POST', `/api/uncaptured/machine_2/${KEY_B}/connect`, MEMBER_SUB)).status).toBe(200);
    expect((await r.dashboard('GET', '/api/uncaptured', MEMBER_SUB)).body.items).toEqual([]);
    expect(r.fixture.sqlite.query(`SELECT value FROM machine_settings WHERE machine_id = 'machine_2' AND leaf = 'capture.connect_roots'`).get()).toEqual({ value: JSON.stringify({ [KEY_B]: '' }) });
    expect((await r.dashboard('POST', `/api/uncaptured/machine_1/${KEY_A}/connect`, undefined)).status).toBe(200);
  });

  it('connects a repository to a named project and binds its remote there, and refuses a remote another project holds', async () => {
    const r = await seeded();
    await r.machine(r.admin, '/members/projects/resolve', { rootKey: 'c'.repeat(16), label: 'holder', remote: 'https://github.com/acme/holder' });
    r.fixture.sqlite.run(`UPDATE uncaptured_roots SET remote = 'github.com/acme/holder' WHERE root_key = ?`, [KEY_B]);
    const bound = await r.dashboard('POST', `/api/uncaptured/machine_2/${KEY_B}/connect`, MEMBER_SUB, { projectId: 'proj_1' });
    expect({ status: bound.status, error: bound.body.error }).toEqual({ status: 409, error: 'remote_bound' });
    r.fixture.sqlite.run(`UPDATE uncaptured_roots SET remote = 'github.com/acme/members-repo' WHERE root_key = ?`, [KEY_B]);
    const named = await r.dashboard('POST', `/api/uncaptured/machine_2/${KEY_B}/connect`, MEMBER_SUB, { projectId: 'proj_1' });
    expect(named.body).toEqual({ connected: true, machineId: 'machine_2', rootKey: KEY_B, projectId: 'proj_1' });
    expect(r.fixture.sqlite.query(`SELECT project_id FROM project_remotes WHERE remote = 'github.com/acme/members-repo'`).get()).toEqual({ project_id: 'proj_1' });
  });

  it('asks for a named project while machines may not create projects, unless the machine\'s own member is an admin or a project holds the remote', async () => {
    const r = await seeded();
    r.fixture.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('capture.auto_create_projects', 'false', 1, 'mem_machine_1')`);
    const asked = await r.dashboard('POST', `/api/uncaptured/machine_2/${KEY_B}/connect`, MEMBER_SUB);
    expect({ status: asked.status, error: asked.body.error }).toEqual({ status: 400, error: 'auto_create_off' });
    expect((await r.dashboard('POST', `/api/uncaptured/machine_2/${KEY_B}/connect`, undefined)).status).toBe(400);
    expect((await r.dashboard('POST', `/api/uncaptured/machine_1/${KEY_A}/connect`, undefined)).status).toBe(200);
    // A remote a live project holds joins it, which starts no project: leaving the choice to Myco connects it.
    await r.machine(r.admin, '/members/projects/resolve', { rootKey: 'c'.repeat(16), label: 'holder', remote: 'https://github.com/acme/holder' });
    r.fixture.sqlite.run(`UPDATE uncaptured_roots SET remote = 'github.com/acme/holder' WHERE root_key = ?`, [KEY_B]);
    expect((await r.dashboard('POST', `/api/uncaptured/machine_2/${KEY_B}/connect`, MEMBER_SUB)).status).toBe(200);
  });

  it('refuses to connect a repository whose remote an archived project holds, however it is asked, and keeps it waiting', async () => {
    const r = await seeded();
    await r.machine(r.admin, '/members/projects/resolve', { rootKey: 'c'.repeat(16), label: 'holder', remote: 'https://github.com/acme/holder' });
    const holder = (r.fixture.sqlite.query(`SELECT project_id FROM project_remotes WHERE remote = 'github.com/acme/holder'`).get() as { project_id: string }).project_id;
    r.fixture.sqlite.run(`UPDATE projects SET archived_at = 1 WHERE project_id = ?`, [holder]);
    r.fixture.sqlite.run(`UPDATE uncaptured_roots SET remote = 'github.com/acme/holder', reason = 'archived' WHERE root_key = ?`, [KEY_B]);
    for (const body of [undefined, { projectId: 'proj_1' }]) {
      const refused = await r.dashboard('POST', `/api/uncaptured/machine_2/${KEY_B}/connect`, MEMBER_SUB, body);
      expect({ body, status: refused.status, error: refused.body.error }).toEqual({ body, status: 409, error: 'archived' });
    }
    expect((await r.dashboard('GET', '/api/uncaptured', MEMBER_SUB)).body.items.map((i: { label: string }) => i.label)).toEqual(['members-repo']);
    expect(r.fixture.sqlite.query(`SELECT COUNT(*) AS n FROM machine_settings WHERE leaf = 'capture.connect_roots'`).get()).toEqual({ n: 0 });
    expect(r.fixture.sqlite.query(`SELECT project_id FROM project_remotes WHERE remote = 'github.com/acme/holder'`).get()).toEqual({ project_id: holder });
  });

  it('never lets the dashboard write which repositories a machine is told to connect', async () => {
    const r = await seeded();
    const put = await r.dashboard('PUT', `/api/machines/machine_2/settings/capture.connect_roots`, MEMBER_SUB, { value: { [KEY_B]: '' } });
    expect(put.status).toBeGreaterThanOrEqual(400);
    expect(r.fixture.sqlite.query(`SELECT COUNT(*) AS n FROM machine_settings WHERE leaf = 'capture.connect_roots'`).get()).toEqual({ n: 0 });
  });
});

describe('the switch that keeps project creation with admins', () => {
  async function off() {
    const r = await rig();
    r.fixture.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('capture.auto_create_projects', 'false', 1, 'mem_machine_1')`);
    return r;
  }

  it('refuses a member creating a project by name, and not an admin', async () => {
    const r = await off();
    expect(await r.machine(r.member, '/members/projects', { name: 'mine' })).toMatchObject({ persisted: false, code: 'auto_create_off' });
    expect(r.projectsNamed('mine')).toEqual([]);
    expect(await r.machine(r.admin, '/members/projects', { name: 'mine' })).toMatchObject({ persisted: true });
  });

  it('creates nothing for a member\'s repository even where the machine is told to connect it to whatever its remote names', async () => {
    const r = await off();
    r.fixture.sqlite.run(`INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES ('machine_2', 'capture.connect_roots', ?, 1, 'mem_machine_2')`, [JSON.stringify({ [KEY_A]: '' })]);
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'widget', remote: 'https://github.com/acme/widget' })).toMatchObject({ persisted: false, code: 'auto_create_off' });
    expect(await r.machine(r.admin, '/members/projects/resolve', { rootKey: KEY_B, label: 'gizmo', remote: 'https://github.com/acme/gizmo' })).toMatchObject({ persisted: true, created: true });
  });
});

describe('a repository a machine reported', () => {
  it('is forgotten when the machine says it connected it, and says when the machine holds its capture no more', async () => {
    const r = await rig();
    await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_A, label: 'a', reason: 'outside_folders' });
    await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_B, label: 'b', reason: 'outside_folders' });
    expect(await r.machine(r.member, '/members/uncaptured/state', { rootKey: KEY_A, state: 'full' })).toEqual({ persisted: true });
    expect(await r.machine(r.member, '/members/uncaptured/state', { rootKey: KEY_B, state: 'connected' })).toEqual({ persisted: true });
    expect(await r.machine(r.member, '/members/uncaptured/state', { rootKey: KEY_B, state: 'gone' })).toMatchObject({ persisted: false, code: 'invalid_field' });
    // Another machine's report is not this machine's to change.
    expect(await r.machine(r.admin, '/members/uncaptured/state', { rootKey: KEY_A, state: 'connected' })).toEqual({ persisted: false });
    expect(r.fixture.sqlite.query(`SELECT root_key, held FROM uncaptured_roots`).all()).toEqual([{ root_key: KEY_A, held: 'full' }]);
    // The machine is the hold's authority: a later report says what it holds, and the row keeps it.
    await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_A, label: 'a', reason: 'outside_folders', held: 'full', sessions: 0 });
    expect(r.fixture.sqlite.query(`SELECT held, misses FROM uncaptured_roots`).get()).toEqual({ held: 'full', misses: 1 });
    await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'a', held: 'expired', sessions: 2 });
    expect(r.fixture.sqlite.query(`SELECT reason, held, misses FROM uncaptured_roots`).get()).toEqual({ reason: 'no_remote', held: 'expired', misses: 3 });
    expect(await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_A, label: 'a', reason: 'outside_folders', held: 'gone' })).toMatchObject({ persisted: false, code: 'invalid_field' });
    expect(await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_A, label: 'a', reason: 'outside_folders', sessions: -1 })).toMatchObject({ persisted: false, code: 'invalid_field' });
  });

  it('is forgotten, and the machine told to connect it no more, when the machine left it', async () => {
    const r = await rig();
    await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_A, label: 'a', reason: 'outside_folders' });
    r.fixture.sqlite.run(`INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES ('machine_2', 'capture.connect_roots', ?, 1, 'mem_machine_2')`, [JSON.stringify({ [KEY_A]: '', [KEY_B]: 'proj_1' })]);
    expect(await r.machine(r.member, '/members/uncaptured/state', { rootKey: KEY_A, state: 'left' })).toEqual({ persisted: true });
    expect(r.fixture.sqlite.query(`SELECT COUNT(*) AS n FROM uncaptured_roots`).get()).toEqual({ n: 0 });
    expect(r.fixture.sqlite.query(`SELECT value FROM machine_settings WHERE leaf = 'capture.connect_roots'`).get()).toEqual({ value: JSON.stringify({ [KEY_B]: 'proj_1' }) });
  });

  it('is forgotten when its member is revoked, and when no machine has reported it for a month', async () => {
    const r = await rig();
    await r.machine(r.member, '/members/uncaptured', { rootKey: KEY_A, label: 'a', reason: 'outside_folders' });
    await r.machine(r.admin, '/members/uncaptured', { rootKey: KEY_B, label: 'b', reason: 'outside_folders' });
    expect(await revokeMember(r.fixture.db, MEMBER_PRINCIPAL.id, PRINCIPAL.id, Date.now())).toEqual({ ok: true });
    expect(r.fixture.sqlite.query(`SELECT label FROM uncaptured_roots`).all()).toEqual([{ label: 'b' }]);
    expect(await pruneUncaptured(r.fixture.db, Date.now() + UNCAPTURED_RETENTION_MS - 60_000, 100)).toBe(0);
    expect(await pruneUncaptured(r.fixture.db, Date.now() + UNCAPTURED_RETENTION_MS + 60_000, 100)).toBe(1);
  });

  it('joins only a project the machine\'s member can see, when it is told which one', async () => {
    const r = await rig();
    const made = await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_B, label: 'gone', remote: 'https://github.com/acme/gone' });
    r.fixture.sqlite.run(`UPDATE projects SET archived_at = 1 WHERE project_id = ?`, [made.projectId]);
    r.fixture.sqlite.run(`INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES ('machine_2', 'capture.connect_roots', ?, 1, 'mem_machine_2')`, [JSON.stringify({ [KEY_A]: made.projectId })]);
    expect(await r.machine(r.member, '/members/projects/resolve', { rootKey: KEY_A, label: 'notes' })).toMatchObject({ persisted: false, code: 'archived' });
  });
});
