/**
 * Invitations as #1158 leaves them: what an invitation grants, what it binds,
 * who may issue and end one, and the job that reclaims the finished ones.
 *
 * The four properties the join already had — single use, a TTL, a hash at rest,
 * revocation — are held by `join.test.ts` and `enrollment.test.ts`. What is here
 * is what those did not decide: the role a join admits at, the Project a sandbox
 * binds to, and the retention that now runs on a schedule.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import {
  ENROLLMENT_RETENTION_MS, ENROLLMENT_TTL_MS, issueEnrollmentAuthority, listInvitations, revokeEnrollmentAuthority,
} from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { lastActivityAt } from '@myco-server-worker/core/activity.js';
import { inviteExpiry } from '@myco-server-worker/core/jobs-run.js';
import { SERVER_JOBS, jobRunsAt } from '@myco-server-worker/core/jobs.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, asOwnerPost, ownerCookie, MEMBER_SUB, PRINCIPAL, seedMemberRoleAccount } from './helpers/owner.js';

/** The worker stamps its own clock, so every fixture instant is anchored to the real one. */
const NOW = Date.now();
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

function rig() {
  const e = sqliteEnv();
  seedMemberRoleAccount(e.sqlite);
  const env = { ...e.env, ...OWNER_ENV };
  const call = (req: Request) => worker.fetch(req, env);
  /** An owner request as the member-role account, which the fixture links to `mem_machine_2`. */
  const asMember = async (path: string, body?: unknown) =>
    new Request(`https://s${path}`, {
      method: 'POST',
      headers: { cookie: await ownerCookie(NOW, MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const join = (body: unknown) =>
    call(new Request('https://s/members/join', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  const authorities = () => (e.sqlite.query(`SELECT id FROM enrollment_authorities ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
  return { e, env, call, asMember, join, authorities };
}

describe('what an invitation grants', () => {
  it('admits the joiner at the role the invitation names, and records it on the member', async () => {
    const r = rig();
    for (const [role, machineId] of [['admin', 'machine_admin'], ['member', 'machine_member']] as const) {
      const key = await issueEnrollmentAuthority(r.e.db, NOW, { role });
      const body = await json(await r.join({ key: key.key, machineId }));
      expect({ role, joined: body.joined, answered: body.role }).toEqual({ role, joined: true, answered: role });
      expect(r.e.sqlite.query(`SELECT role FROM members WHERE id = ?`).get(body.memberId as string)).toEqual({ role });
    }
  });

  it('refuses a role named at join time: the invitation decides, never the joiner', async () => {
    const r = rig();
    const key = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member' });
    const refused = await json(await r.join({ key: key.key, machineId: 'machine_x', role: 'admin' }));
    expect({ joined: refused.joined, code: refused.code }).toEqual({ joined: false, code: 'unknown_field' });
    // The refusal left the invitation unspent: it still works.
    expect((await json(await r.join({ key: key.key, machineId: 'machine_x' }))).role).toBe('member');
  });

  it('adds a runtime at the role its member already holds, and ANSWERS that role rather than the invitation\'s', async () => {
    const r = rig();
    const first = await json(await r.join({ key: (await issueEnrollmentAuthority(r.e.db, NOW, { role: 'admin' })).key, machineId: 'machine_1a' }));
    const second = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member', memberId: first.memberId as string });
    const again = await json(await r.join({ key: second.key, machineId: 'machine_1b' }));

    expect(again.memberId).toBe(first.memberId);
    expect(r.e.sqlite.query(`SELECT role FROM members WHERE id = ?`).get(first.memberId as string)).toEqual({ role: 'admin' });
    // The credential belongs to a member who is an admin. Answering the invitation's
    // role would have `myco login` print a role its holder does not have.
    expect(again.role).toBe('admin');
  });

  it('refuses an invitation whose stored role is outside the grammar, and leaves it UNSPENT', async () => {
    const r = rig();
    const bent = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member' });
    r.e.sqlite.query(`UPDATE enrollment_authorities SET role = 'owner' WHERE id = ?`).run(bent.id);

    const refused = await json(await r.join({ key: bent.key, machineId: 'machine_bent' }));
    expect({ joined: refused.joined, code: refused.code }).toEqual({ joined: false, code: 'enrollment_revoked' });
    expect(r.e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get()).toEqual({ c: 0 });

    // Unspent: repairing the row makes the same invitation work, rather than costing a fresh mint.
    expect(r.e.sqlite.query(`SELECT used_at FROM enrollment_authorities WHERE id = ?`).get(bent.id)).toEqual({ used_at: null });
    r.e.sqlite.query(`UPDATE enrollment_authorities SET role = 'member' WHERE id = ?`).run(bent.id);
    expect((await json(await r.join({ key: bent.key, machineId: 'machine_bent' }))).role).toBe('member');
  });
});

describe('what an invitation binds', () => {
  it('answers the Project the invitation names, and none when it names none', async () => {
    const r = rig();
    const bound = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member', projectId: 'proj_1' });
    expect((await json(await r.join({ key: bound.key, machineId: 'machine_b1', forProject: true }))).projectId).toBe('proj_1');

    const free = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member' });
    expect((await json(await r.join({ key: free.key, machineId: 'machine_b2' }))).projectId).toBe(null);
  });

  it('refuses a joiner that needs a Project when the invitation carries none, WITHOUT spending it', async () => {
    const r = rig();
    const free = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member' });

    const refused = await json(await r.join({ key: free.key, machineId: 'machine_np', forProject: true }));
    expect({ joined: refused.joined, code: refused.code }).toEqual({ joined: false, code: 'enrollment_no_project' });
    expect(r.e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get()).toEqual({ c: 0 });

    // The invitation is untouched. An operator binds a Project and the SAME link works.
    expect(r.e.sqlite.query(`SELECT used_at FROM enrollment_authorities WHERE id = ?`).get(free.id)).toEqual({ used_at: null });
    r.e.sqlite.query(`UPDATE enrollment_authorities SET project_id = 'proj_1' WHERE id = ?`).run(free.id);
    expect((await json(await r.join({ key: free.key, machineId: 'machine_np', forProject: true }))).projectId).toBe('proj_1');
  });

  it('names an expired invitation expired even when the joiner needs a Project it also lacks', async () => {
    const r = rig();
    const stale = await issueEnrollmentAuthority(r.e.db, NOW - ENROLLMENT_TTL_MS * 2, { role: 'member' });
    const refused = await json(await r.join({ key: stale.key, machineId: 'machine_stale', forProject: true }));
    expect(refused.code).toBe('enrollment_expired');
  });
});

describe('who administers membership', () => {
  const ADMIN_ONLY: Array<[string, string, unknown]> = [
    ['mint an invitation', '/api/enrollment', {}],
    ['revoke an invitation', '/api/enrollment/en_x/revoke', undefined],
    ['revoke a member', '/api/members/mem_machine_2/revoke', undefined],
  ];

  it('refuses every administrative act to a member, by name, and carries each out for an admin', async () => {
    // What each act looks like when it succeeds, so the admin half asserts an outcome
    // rather than the absence of one refusal.
    const ADMITTED: Record<string, { status: number; body: (b: Record<string, unknown>) => unknown }> = {
      'mint an invitation': { status: 201, body: (b) => ({ role: b.role, projectId: b.projectId }) },
      'revoke an invitation': { status: 200, body: (b) => ({ revoked: b.revoked, revokedBy: b.revokedBy }) },
      'revoke a member': { status: 200, body: (b) => ({ revoked: b.revoked, revokedBy: b.revokedBy }) },
    };
    const EXPECTED: Record<string, unknown> = {
      'mint an invitation': { role: 'member', projectId: null },
      // No invitation carries that id, so an admin is admitted and told nothing matched.
      'revoke an invitation': { revoked: false, revokedBy: PRINCIPAL.id },
      'revoke a member': { revoked: true, revokedBy: PRINCIPAL.id },
    };
    for (const [what, path, body] of ADMIN_ONLY) {
      const r = rig();
      const refused = await r.call(await r.asMember(path, body));
      expect({ what, status: refused.status, body: await json(refused) })
        .toEqual({ what, status: 403, body: { error: 'not_admin', reason: 'this action is for an admin' } });

      const admitted = await r.call(await asOwnerPost(path, body));
      expect({ what, status: admitted.status, body: ADMITTED[what].body(await json(admitted)) })
        .toEqual({ what, status: ADMITTED[what].status, body: EXPECTED[what] });
    }
  });

  it('leaves the member list open to a member: the people who can revoke you are never hidden from you', async () => {
    const r = rig();
    const seen = await r.call(new Request('https://s/api/members', { headers: { cookie: await ownerCookie(NOW, MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4' } }));
    expect(seen.status).toBe(200);
    const members = (await json(seen)).members as Array<{ id: string; role: string }>;
    expect(members.find((m) => m.id === 'mem_machine_1')?.role).toBe('admin');
  });

  it('lets an admin revoke any credential and a member only its own', async () => {
    const r = rig();
    const mine = await issueMemberToken(r.e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, NOW);
    const theirs = await issueMemberToken(r.e.db, { memberId: 'mem_machine_3', machineId: 'machine_3' }, NOW);
    const live = (id: string) => r.e.sqlite.query(`SELECT revoked_at FROM member_credentials WHERE id = ?`).get(id) as { revoked_at: number | null };

    expect(await json(await r.call(await r.asMember(`/api/credentials/${theirs.tokenId}/revoke`)))).toMatchObject({ revoked: false });
    expect(live(theirs.tokenId).revoked_at).toBe(null);

    expect(await json(await r.call(await r.asMember(`/api/credentials/${mine.tokenId}/revoke`)))).toMatchObject({ revoked: true });
    expect(live(mine.tokenId).revoked_at).not.toBe(null);

    expect(await json(await r.call(await asOwnerPost(`/api/credentials/${theirs.tokenId}/revoke`)))).toMatchObject({ revoked: true });
    expect(live(theirs.tokenId).revoked_at).not.toBe(null);
  });

  it('mints at member unless an admin asks for an admin, and refuses any other role', async () => {
    const r = rig();
    expect(await json(await r.call(await asOwnerPost('/api/enrollment', {})))).toMatchObject({ role: 'member', projectId: null });
    expect(await json(await r.call(await asOwnerPost('/api/enrollment', { role: 'admin' })))).toMatchObject({ role: 'admin' });
    expect((await r.call(await asOwnerPost('/api/enrollment', { role: 'owner' }))).status).toBe(400);
  });

  it('mints against a known Project only, and lists what each live invitation grants and binds', async () => {
    const r = rig();
    expect((await r.call(await asOwnerPost('/api/enrollment', { projectId: 'no_such_project' }))).status).toBe(404);
    expect(await json(await r.call(await asOwnerPost('/api/enrollment', { projectId: 'proj_1', role: 'admin' })))).toMatchObject({ role: 'admin', projectId: 'proj_1' });

    const live = await listInvitations(r.e.db, NOW);
    expect(live.map((i) => ({ role: i.role, projectId: i.projectId }))).toEqual([{ role: 'admin', projectId: 'proj_1' }]);
  });
});

describe('invite-expiry', () => {
  it('is a declared job with an implementation that still runs while the Deployment sleeps', () => {
    expect(SERVER_JOBS.find((j) => j.name === 'invite-expiry')?.runsThrough).toBe('sleep');
    expect(jobRunsAt('invite-expiry', 'sleep')).toBe(true);
    expect(jobRunsAt('invite-expiry', 'deep_sleep')).toBe(false);
  });

  it('reclaims finished authorities past the window, and never touches a live one whatever its age', async () => {
    const r = rig();
    const old = NOW - ENROLLMENT_RETENTION_MS - 1;

    const spentLongAgo = await issueEnrollmentAuthority(r.e.db, old, { role: 'member' });
    r.e.sqlite.query(`UPDATE enrollment_authorities SET used_at = ?, used_by_runtime = 'm' WHERE id = ?`).run(old, spentLongAgo.id);
    const revokedLongAgo = await issueEnrollmentAuthority(r.e.db, old, { role: 'member' });
    r.e.sqlite.query(`UPDATE enrollment_authorities SET revoked_at = ? WHERE id = ?`).run(old, revokedLongAgo.id);
    // Expired long ago, never spent: still finished, still reclaimable. The window is
    // measured from the moment it EXPIRED, not the moment of minting.
    const expiredLongAgo = await issueEnrollmentAuthority(r.e.db, old - ENROLLMENT_TTL_MS, { role: 'member' });
    // Spent recently: audit material an operator may still be asking about.
    const spentRecently = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member' });
    r.e.sqlite.query(`UPDATE enrollment_authorities SET used_at = ? WHERE id = ?`).run(NOW, spentRecently.id);
    const live = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member' });
    // Unspent, minted long ago, with a TTL long enough that it has not expired.
    const longLived = await issueEnrollmentAuthority(r.e.db, old, { role: 'member', ttlMs: ENROLLMENT_RETENTION_MS * 10 });

    expect(await inviteExpiry(r.e.serverEnv, NOW)).toBe(3);
    expect(r.authorities().sort()).toEqual([spentRecently.id, live.id, longLived.id].sort());
    for (const gone of [spentLongAgo.id, revokedLongAgo.id, expiredLongAgo.id]) expect(r.authorities()).not.toContain(gone);
  });

  it('reclaims nothing when nothing is finished, and a second pass over the same state removes nothing more', async () => {
    const r = rig();
    const live = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member' });
    expect(await inviteExpiry(r.e.serverEnv, NOW)).toBe(0);
    expect(await inviteExpiry(r.e.serverEnv, NOW)).toBe(0);
    expect(r.authorities()).toEqual([live.id]);
  });

  it('reclaims an authority revoked with its member, once that revocation is old enough', async () => {
    const r = rig();
    const doomed = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member', createdByMember: 'mem_machine_2' });
    expect(await revokeEnrollmentAuthority(r.e.db, doomed.id, NOW - ENROLLMENT_RETENTION_MS - 1, 'mem_machine_1')).toEqual({ revoked: true });
    expect(await inviteExpiry(r.e.serverEnv, NOW)).toBe(1);
    expect(r.authorities()).toEqual([]);
  });
});

describe('a join reaches the clock the tick reads', () => {
  it('counts as activity, so a Deployment whose only traffic is joins keeps reclaiming', async () => {
    const r = rig();
    expect(await lastActivityAt(r.e.db)).toBe(null);

    const key = await issueEnrollmentAuthority(r.e.db, NOW, { role: 'member' });
    expect((await json(await r.join({ key: key.key, machineId: 'machine_clock' }))).joined).toBe(true);

    const seen = await lastActivityAt(r.e.db);
    expect(seen).not.toBe(null);
    expect(Math.abs(seen! - NOW)).toBeLessThan(60_000);
  });

  it('does NOT count when the join is refused: an unauthenticated guesser cannot hold a Deployment awake at the operator\'s expense', async () => {
    const r = rig();
    for (const body of [{ key: 'n'.repeat(43), machineId: 'machine_guess' }, { key: 'x', machineId: 'machine_guess' }, { machineId: 'machine_guess' }]) {
      expect((await json(await r.join(body))).joined).toBe(false);
    }
    expect(await lastActivityAt(r.e.db)).toBe(null);
  });
});
