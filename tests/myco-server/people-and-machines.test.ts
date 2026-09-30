/**
 * The People & machines page's server half: the machines a signed-in member reads and renames, the capture and workers
 * Status shows them, the names members take from GitHub, the Deployment's own member, the recovery status on a
 * Deployment with no producer, and the settings marked retired.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { issueIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { LINK_REQUIRES_ADMIN } from '@myco-server-worker/auth/members.js';
import { nameMemberFromLogin } from '@myco-server-worker/auth/members-admin.js';
import { LINK_REQUIRES_ADMIN_HINT } from '@myco/cli/member.js';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { machineName } from '@myco-server-worker/api/machines.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const HOUR = 60 * 60 * 1000;

/**
 * Three machines: `m_admin` the admin's (a worker that reported and leased a run, and two agents capturing), `m_member`
 * the member's (two live credentials, the newer one named), and `m_gone` the member's too, with no live credential.
 */
function rig() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite, db } = fixture;
  seedMemberRoleAccount(sqlite);
  const now = Date.now();
  const claim = (machine: string, member: string) => sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (?, ?, ?)`, [machine, member, now - 10 * HOUR]);
  claim('m_admin', 'mem_machine_1');
  claim('m_member', 'mem_machine_2');
  claim('m_gone', 'mem_machine_2');
  const credential = async (member: string, machine: string, label: string | null, issuedAt: number) =>
    (await issueMemberToken(db, { memberId: member, machineId: machine }, issuedAt, null, { runtimeLabel: label, runtimeKind: 'persistent' })).tokenId;
  return { fixture, env, sqlite, db, now, credential };
}

async function seeded() {
  const r = rig();
  const { sqlite, now, credential } = r;
  const adminCredential = await credential('mem_machine_1', 'm_admin', 'studio', now - 2 * HOUR);
  await credential('mem_machine_2', 'm_member', 'laptop-old', now - 3 * HOUR);
  await credential('mem_machine_2', 'm_member', 'laptop', now - HOUR);
  await credential('mem_machine_2', 'm_member', null, now - HOUR / 2);
  const gone = await credential('mem_machine_2', 'm_gone', 'retired-box', now - 5 * HOUR);
  sqlite.run(`UPDATE member_credentials SET revoked_at = ? WHERE id = ?`, [now - 4 * HOUR, gone]);
  sqlite.run(`INSERT INTO worker_contacts (credential_id, machine_id, offers, last_seen_at, updated_at) VALUES (?, 'm_admin', '[{"id":"codex","authenticated":true}]', ?, ?)`, [adminCredential, now - 60_000, now - 60_000]);
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`, [now]);
  sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, leased_by, lease_expires_at) VALUES ('proj_1', 'run_1', 'agent_1', 'digest', 'completed', ?, ?, ?, ?)`,
    [now - 30 * 60_000, now - 20 * 60_000, adminCredential, now - 25 * 60_000]);
  const session = (id: string, machine: string, agent: string, project: string, at: number) =>
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES (?, ?, ?, 'tok', ?, ?, ?)`, [project, id, machine, at, at, agent]);
  session('s1', 'm_admin', 'claude-code', 'proj_1', now - 10 * 60_000);
  session('s2', 'm_admin', 'codex', 'proj_2', now - 40 * 60_000);
  session('s3', 'm_member', 'claude-code', 'proj_2', now - 50 * 60_000);
  return r;
}

const request = async (env: unknown, sub: string | null, method: string, path: string, body?: unknown): Promise<Response> => {
  const headers: Record<string, string> = { 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' };
  if (sub !== null) headers.cookie = await ownerCookie(Date.now(), sub);
  return worker.fetch(new Request(`https://s${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
};
const ADMIN = '583231';

type Machine = { machineId: string; name: string | null; live: boolean; member: { id: string }; offers: unknown; lastContactAt: number | null; capture: Array<{ agent: string | null; projectId: string }>; lastCaptureAt: number | null; lastRunAt: number | null };
const machines = async (env: unknown, sub: string): Promise<Machine[]> => ((await (await request(env, sub, 'GET', '/api/machines')).json()) as { machines: Machine[] }).machines;

describe('the machines a member reads', () => {
  it('answers an admin every machine, named by its newest live credential, with what its worker and agents last did', async () => {
    const { env, now } = await seeded();
    const read = await machines(env, ADMIN);
    expect(read.map((m) => m.machineId)).toEqual(['m_admin', 'm_member', 'm_gone']);
    const [admin, member, gone] = read;
    expect(admin).toMatchObject({
      name: 'studio', live: true, member: { id: 'mem_machine_1', label: 'machine_1', revoked: false },
      offers: [{ id: 'codex', authenticated: true }], lastContactAt: now - 60_000, lastCaptureAt: now - 10 * 60_000, lastRunAt: now - 30 * 60_000,
      capture: [{ agent: 'claude-code', lastEventAt: now - 10 * 60_000, projectId: 'proj_1' }, { agent: 'codex', lastEventAt: now - 40 * 60_000, projectId: 'proj_2' }],
    });
    // The newest live credential carrying a label names the machine; an unnamed newer one does not hide it.
    expect(member).toMatchObject({ name: 'laptop', live: true, offers: null, lastContactAt: null, lastRunAt: null, capture: [{ agent: 'claude-code', projectId: 'proj_2' }] });
    // A revoked credential names nothing and makes nothing live.
    expect(gone).toMatchObject({ name: null, live: false, capture: [], lastCaptureAt: null });
  });

  it('answers a member their own machines alone', async () => {
    const { env } = await seeded();
    expect((await machines(env, MEMBER_SUB)).map((m) => m.machineId)).toEqual(['m_member', 'm_gone']);
    expect((await request(env, null, 'GET', '/api/machines')).status).toBe(401);
  });
});

describe('renaming a machine', () => {
  it('lets an admin rename any machine and a member only their own, on every live credential and no other', async () => {
    const { env, sqlite } = await seeded();
    expect((await (await request(env, ADMIN, 'PATCH', '/api/machines/m_member', { label: '  Chris’s laptop  ' })).json()) as Record<string, unknown>).toEqual({ machineId: 'm_member', name: 'Chris’s laptop' });
    const labels = sqlite.query(`SELECT runtime_label AS label, revoked_at IS NULL AS live FROM member_credentials WHERE machine_id IN ('m_member', 'm_gone') ORDER BY issued_at`).all();
    expect(labels).toEqual([{ label: 'retired-box', live: 0 }, { label: 'Chris’s laptop', live: 1 }, { label: 'Chris’s laptop', live: 1 }, { label: 'Chris’s laptop', live: 1 }]);
    expect((await machines(env, MEMBER_SUB))[0]!.name).toBe('Chris’s laptop');

    expect((await request(env, MEMBER_SUB, 'PATCH', '/api/machines/m_member', { label: 'mine' })).status).toBe(200);
    const refused = await request(env, MEMBER_SUB, 'PATCH', '/api/machines/m_admin', { label: 'taken' });
    expect(refused.status).toBe(403);
    expect(sqlite.query(`SELECT DISTINCT runtime_label AS label FROM member_credentials WHERE machine_id = 'm_admin'`).all()).toEqual([{ label: 'studio' }]);
  });

  it('answers 404 for a machine nobody claims, 409 for one with no live credential, and 400 for a name it does not take', async () => {
    const { env, sqlite } = await seeded();
    expect((await request(env, ADMIN, 'PATCH', '/api/machines/m_nobody', { label: 'x' })).status).toBe(404);
    const stale = await request(env, MEMBER_SUB, 'PATCH', '/api/machines/m_gone', { label: 'back' });
    expect({ status: stale.status, body: await stale.json() }).toMatchObject({ status: 409, body: { error: 'no_live_credential' } });
    expect(sqlite.query(`SELECT runtime_label AS label FROM member_credentials WHERE machine_id = 'm_gone'`).all()).toEqual([{ label: 'retired-box' }]);
    for (const label of ['', '   ', 'x'.repeat(65), 'two\nlines', 'tab\there', 'zero​width', 'line sep', 42, null]) {
      expect({ label, status: (await request(env, ADMIN, 'PATCH', '/api/machines/m_member', { label })).status }).toEqual({ label, status: 400 });
    }
    // Length is counted in characters, not UTF-16 units: 64 astral characters fit, 65 do not.
    expect((await request(env, ADMIN, 'PATCH', '/api/machines/m_member', { label: '🖥'.repeat(64) })).status).toBe(200);
    expect((await request(env, ADMIN, 'PATCH', '/api/machines/m_member', { label: '🖥'.repeat(65) })).status).toBe(400);
    expect(machineName('é'.repeat(64))).toBe('é'.repeat(64));
    expect(machineName('é'.repeat(65))).toBeNull();
  });
});

describe('Status to a member', () => {
  it('shows a member the capture and workers of their own machines, and an admin every one', async () => {
    const { env } = await seeded();
    const status = async (sub: string) => (await (await request(env, sub, 'GET', '/api/status')).json()) as { capture: Array<{ machineId: string }>; workers: { fleet: Array<{ machineId: string | null }>; available: boolean } };
    const admin = await status(ADMIN);
    expect(admin.capture.map((row) => row.machineId).sort()).toEqual(['m_admin', 'm_admin', 'm_member']);
    expect(admin.workers.fleet.map((row) => row.machineId)).toEqual(['m_admin']);
    const member = await status(MEMBER_SUB);
    expect(member.capture.map((row) => row.machineId)).toEqual(['m_member']);
    expect(member.workers).toMatchObject({ available: true, fleet: [] });
  });
});

describe('a member\'s name and kind', () => {
  it('names a member with no name after the GitHub login it signs in with, and never replaces a name it holds', async () => {
    const { env, sqlite, db } = rig();
    sqlite.run(`UPDATE members SET label = NULL WHERE id = 'mem_machine_2'`);
    const me = async () => ((await (await request(env, MEMBER_SUB, 'GET', '/auth/me')).json()) as { member: { label: string | null } }).member.label;
    expect(await me()).toBe('octocat');
    expect(sqlite.query(`SELECT label FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ label: 'octocat' });
    // An admin's rename stands at every later sign-in.
    sqlite.run(`UPDATE members SET label = 'Dana' WHERE id = 'mem_machine_2'`);
    expect(await me()).toBe('Dana');
    expect(sqlite.query(`SELECT label FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ label: 'Dana' });
    // The write keeps a name however it is reached: a rename landing between the session read and the write stands.
    expect(await nameMemberFromLogin(db, 'mem_machine_2', 'octocat')).toBeNull();
    expect(sqlite.query(`SELECT label FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ label: 'Dana' });
    // A login GitHub would not grant names nobody.
    sqlite.run(`UPDATE members SET label = NULL WHERE id = 'mem_machine_2'`);
    expect(await nameMemberFromLogin(db, 'mem_machine_2', 'not a login')).toBeNull();
    expect(sqlite.query(`SELECT label FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ label: null });
  });

  it('names a member with no name after the account an admin\'s link connects to it', async () => {
    const { env, db, sqlite } = rig();
    const issued = await issueIdentityLinkAuthority(db, 'mem_anon', Date.now(), { issuedBy: 'mem_machine_1' });
    const linked = await request(env, '880001', 'POST', '/auth/link', { key: issued!.key, confirm: true });
    expect(await linked.json()).toMatchObject({ linked: true, member: { id: 'mem_anon', label: 'octocat' } });
    expect(sqlite.query(`SELECT label FROM members WHERE id = 'mem_anon'`).get()).toEqual({ label: 'octocat' });
  });

  it('marks the Deployment\'s own member as the system, and no person', async () => {
    const { env, sqlite } = rig();
    sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, revoked_at) VALUES ('mem_harness', 'harness runtime', 0, NULL)`);
    const { members } = (await (await request(env, ADMIN, 'GET', '/api/members')).json()) as { members: Array<{ id: string; system: boolean }> };
    expect(members.filter((m) => m.system).map((m) => m.id)).toEqual(['mem_harness']);
    expect(members.length).toBeGreaterThan(5);
  });

  it('names the page an admin links an account from as the dashboard names it', () => {
    expect(LINK_REQUIRES_ADMIN).toContain(`dashboard's ${INVITE_CONTROLS.page} page`);
    expect(LINK_REQUIRES_ADMIN_HINT).toContain(`dashboard's ${INVITE_CONTROLS.page} page`);
  });
});

describe('recovery and retired settings on the dashboard', () => {
  it('answers the recovery status 200 on a Deployment with no producer, saying so, with the schedule', async () => {
    const { env } = rig();
    const answer = await request(env, ADMIN, 'GET', '/api/recovery/exports');
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ supported: false, reason: 'this Deployment runs no hosted recovery producer', schedule: expect.anything() });
  });

  it('marks each Deployment leaf and secret slot retired or not, as the retired sets say', async () => {
    const { env } = rig();
    const { leaves } = (await (await request(env, ADMIN, 'GET', '/api/settings')).json()) as { leaves: Array<{ leaf: string; retired: boolean }> };
    expect(leaves.find((l) => l.leaf === 'agent.reasoningLevel')?.retired).toBe(true);
    expect(leaves.every((l) => typeof l.retired === 'boolean')).toBe(true);
    expect(leaves.some((l) => !l.retired)).toBe(true);
    const { secrets } = (await (await request(env, ADMIN, 'GET', '/api/secrets')).json()) as { secrets: Array<{ name: string; retired: boolean }> };
    expect(secrets.find((s) => s.name === 'github')?.retired).toBe(true);
    expect(secrets.some((s) => !s.retired)).toBe(true);
  });
});
