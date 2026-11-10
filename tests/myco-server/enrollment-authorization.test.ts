import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { memberSubject } from '@myco-server-worker/auth/authorization.js';
import { EnrollmentAuthorizationError, issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { changingAt, counting } from './helpers/store-faults.js';

const NOW = Date.now();
const MEMBERS = {
  owner: { id: 'mem_machine_1', github: '583231', role: 'owner' },
  admin: { id: 'mem_machine_3', github: '770003', role: 'admin' },
  member: { id: 'mem_machine_2', github: '770001', role: 'member' },
} as const;
type Issuer = keyof typeof MEMBERS;
type Target = 'new' | Issuer;
type RequestedRole = 'omitted' | 'member' | 'admin';

function rig() {
  const e = sqliteEnv();
  e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_1', revision = 1 WHERE id = 1");
  e.sqlite.run("UPDATE members SET github_id = '770001', role = 'member' WHERE id = 'mem_machine_2'");
  e.sqlite.run("UPDATE members SET github_id = '770003', role = 'admin' WHERE id = 'mem_machine_3'");
  const env = { ...e.serverEnv, secrets: OWNER_ENV };
  const server = createServer({ now: () => NOW, sourceOf: () => 'test', fetchImpl: () => { throw new Error('unexpected outbound request'); } });
  const call = (path: string, body: unknown, cookie?: string) => server.handleRequest(new Request(`https://s${path}`, {
    method: 'POST',
    headers: { origin: 'https://s', 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  }), env);
  const invite = async (issuer: Issuer, target: Target, requestedRole: RequestedRole) => call('/api/enrollment', {
    ...(target === 'new' ? {} : { memberId: MEMBERS[target].id }),
    ...(requestedRole === 'omitted' ? {} : { role: requestedRole }),
  }, await ownerCookie(e.db, NOW, MEMBERS[issuer].github));
  const join = (key: string, machineId: string) => call('/members/join', { key, machineId });
  const count = (table: 'enrollment_authorities' | 'member_credentials' | 'machine_claims') =>
    (e.sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  const counts = () => ({ invitations: count('enrollment_authorities'), credentials: count('member_credentials'), claims: count('machine_claims') });
  return { e, env, server, invite, join, counts, close: () => e.sqlite.close() };
}

type Rig = ReturnType<typeof rig>;

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

async function refusedJoin(r: ReturnType<typeof rig>, key: string, machineId: string) {
  const before = r.counts();
  const response = await json(await r.join(key, machineId));
  expect(response).toMatchObject({ joined: false, code: 'enrollment_revoked' });
  expect(r.counts()).toEqual(before);
  expect(r.e.sqlite.query('SELECT used_at FROM enrollment_authorities WHERE used_at IS NOT NULL').all()).toEqual([]);
  expect(r.e.sqlite.query('SELECT member_id FROM member_credentials WHERE machine_id = ?').all(machineId)).toEqual([]);
  expect(r.e.sqlite.query('SELECT member_id FROM machine_claims WHERE machine_id = ?').all(machineId)).toEqual([]);
}

describe('enrollment resulting-authority policy', () => {
  it('refuses missing and unrecognized issuers instead of treating them as operators', async () => {
    const r = rig();
    try {
      const before = r.counts();
      for (const issuer of [undefined, null, { kind: 'unknown' }, { kind: 'member' }]) {
        await expect(Reflect.apply(issueEnrollmentAuthority, null, [r.e.db, NOW, { issuer, role: 'admin' }]))
          .rejects.toBeInstanceOf(EnrollmentAuthorizationError);
      }
      expect(r.counts()).toEqual(before);
    } finally { r.close(); }
  });
  const issuers: Issuer[] = ['owner', 'admin', 'member'];
  const targets: Target[] = ['new', 'member', 'admin', 'owner'];
  const requestedRoles: RequestedRole[] = ['omitted', 'member', 'admin'];

  for (const issuer of issuers) for (const target of targets) for (const requestedRole of requestedRoles) {
    it(`${issuer} issuing ${requestedRole} to ${target} enforces the credential that join will create`, async () => {
      const r = rig();
      try {
        const before = r.counts();
        const response = await r.invite(issuer, target, requestedRole);
        const allowed = issuer === 'owner' || (issuer === 'admin' &&
          (target === 'new' || target === 'member') && requestedRole !== 'admin');
        if (!allowed) {
          expect(response.status).toBe(403);
          expect(r.counts()).toEqual(before);
          return;
        }

        expect(response.status).toBe(201);
        const invitation = await json(response);
        expect(typeof invitation.key).toBe('string');
        expect(r.counts()).toEqual({ ...before, invitations: before.invitations + 1 });
        const machineId = `matrix_${issuer}_${target}_${requestedRole}`;
        const joined = await json(await r.join(invitation.key as string, machineId));
        expect(joined.joined).toBe(true);
        const expectedRole = target === 'new' ? requestedRole === 'admin' ? 'admin' : 'member' : MEMBERS[target].role;
        expect(joined.role).toBe(expectedRole === 'owner' ? 'admin' : expectedRole);
        expect((await memberSubject(r.e.db, joined.memberId as string, 'http')).role).toBe(expectedRole);
        expect(target === 'new' ? joined.memberId !== undefined : joined.memberId === MEMBERS[target].id).toBe(true);
        expect(r.counts()).toEqual({ invitations: before.invitations + 1, credentials: before.credentials + 1, claims: before.claims + 1 });
      } finally { r.close(); }
    });
  }

  it('refuses an admin invitation to the current owner despite a member role in the body', async () => {
    const r = rig();
    try {
      const before = r.counts();
      const response = await r.invite('admin', 'owner', 'member');
      const invitation = await json(response);
      let resultingRole: string | undefined;
      let ownerOperationAdmitted = false;
      if (typeof invitation.key === 'string') {
        const joined = await json(await r.join(invitation.key, 'review_owner_attacker'));
        if (joined.joined === true) {
          resultingRole = (await memberSubject(r.e.db, joined.memberId as string, 'http')).role;
          const operation = await r.server.handleRequest(new Request('https://s/members/raw-claims', {
            headers: { authorization: `Bearer ${joined.token as string}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
          }), r.env);
          ownerOperationAdmitted = (await json(operation)).persisted === true;
        }
      }
      expect({ status: response.status, resultingRole, ownerOperationAdmitted }).toEqual({ status: 403, resultingRole: undefined, ownerOperationAdmitted: false });
      expect(r.counts()).toEqual(before);
    } finally { r.close(); }
  });

  it('refuses an admin invitation to an existing administrator when the role is omitted', async () => {
    const r = rig();
    try {
      const before = r.counts();
      const response = await r.invite('admin', 'admin', 'omitted');
      const invitation = await json(response);
      let resultingRole: string | undefined;
      if (typeof invitation.key === 'string') {
        const joined = await json(await r.join(invitation.key, 'review_admin_attacker'));
        if (joined.joined === true) resultingRole = (await memberSubject(r.e.db, joined.memberId as string, 'http')).role;
      }
      expect({ status: response.status, resultingRole }).toEqual({ status: 403, resultingRole: undefined });
      expect(r.counts()).toEqual(before);
    } finally { r.close(); }
  });

  it('guards the direct writer and admits explicit operator bootstrap', async () => {
    const r = rig();
    try {
      const before = r.counts();
      await expect(issueEnrollmentAuthority(r.e.db, NOW, {
        issuer: { kind: 'member', memberId: MEMBERS.admin.id }, memberId: MEMBERS.owner.id, role: 'member',
      })).rejects.toBeInstanceOf(EnrollmentAuthorizationError);
      await expect(issueEnrollmentAuthority(r.e.db, NOW, {
        issuer: { kind: 'member', memberId: MEMBERS.member.id }, role: 'member',
      })).rejects.toBeInstanceOf(EnrollmentAuthorizationError);
      expect(r.counts()).toEqual(before);

      const owner = await issueEnrollmentAuthority(r.e.db, NOW, {
        issuer: { kind: 'member', memberId: MEMBERS.owner.id }, memberId: MEMBERS.admin.id, role: 'member',
      });
      expect((await json(await r.join(owner.key, 'direct_owner'))).role).toBe('admin');
      const operator = await issueEnrollmentAuthority(r.e.db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
      expect((await json(await r.join(operator.key, 'direct_operator'))).role).toBe('member');
    } finally { r.close(); }
  });
});

describe('enrollment authority stays live through redemption', () => {
  const changes: Array<{ name: string; issuer: Issuer; target: Target; role: RequestedRole; change: (r: ReturnType<typeof rig>) => void }> = [
    { name: 'admin issuer downgraded to member', issuer: 'admin', target: 'new', role: 'member', change: r => r.e.sqlite.run("UPDATE members SET role = 'member' WHERE id = 'mem_machine_3'") },
    { name: 'admin issuer revoked', issuer: 'admin', target: 'new', role: 'member', change: r => r.e.sqlite.run("UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_3'", [NOW]) },
    { name: 'owner issuer revoked', issuer: 'owner', target: 'new', role: 'admin', change: r => r.e.sqlite.run("UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_1'", [NOW]) },
    { name: 'recipient promoted to admin', issuer: 'admin', target: 'member', role: 'member', change: r => r.e.sqlite.run("UPDATE members SET role = 'admin' WHERE id = 'mem_machine_2'") },
    { name: 'recipient revoked', issuer: 'admin', target: 'member', role: 'member', change: r => r.e.sqlite.run("UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_2'", [NOW]) },
    { name: 'recipient becomes owner', issuer: 'admin', target: 'member', role: 'member', change: r => r.e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_2', revision = revision + 1 WHERE id = 1") },
    { name: 'owner transfers away from the issuer', issuer: 'owner', target: 'new', role: 'admin', change: r => r.e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_3', revision = revision + 1 WHERE id = 1") },
  ];

  for (const scenario of changes) {
    it(`leaves key and identity untouched when ${scenario.name}`, async () => {
      const r = rig();
      try {
        const invitation = await r.invite(scenario.issuer, scenario.target, scenario.role);
        expect(invitation.status).toBe(201);
        const key = (await json(invitation)).key as string;
        scenario.change(r);
        await refusedJoin(r, key, `changed_${scenario.name.replaceAll(' ', '_')}`);
      } finally { r.close(); }
    });
  }

  /** An invitation or a join made once per point of its request, on a fresh Deployment each time, with `change` landing just before that call. */
  async function atEveryPoint(
    request: (r: Rig) => Promise<Response>, change: (r: Rig) => void, prepare: (r: Rig) => Promise<void> = async () => {},
  ): Promise<Array<{ at: number; r: Rig; response: Response; before: ReturnType<Rig['counts']>; committed: boolean }>> {
    const counted = rig();
    let total = 0;
    try {
      await prepare(counted);
      const db = counted.env.db;
      const counter = counting(db);
      counted.env.db = counter.store;
      await request(counted);
      total = counter.calls();
    } finally { counted.close(); }
    expect(total).toBeGreaterThan(1);
    const outcomes = [];
    for (let at = 1; at <= total; at++) {
      const r = rig();
      await prepare(r);
      const before = r.counts();
      let committed = false;
      r.env.db = changingAt(r.env.db, at, () => { committed = JSON.stringify(r.counts()) !== JSON.stringify(before); change(r); }).store;
      outcomes.push({ at, r, response: await request(r), before, committed });
    }
    return outcomes;
  }

  const raced: Array<{ name: string; issuer: Issuer; target: Target; role: RequestedRole; change: (r: Rig) => void }> = [
    { name: 'the issuer is revoked', issuer: 'admin', target: 'new', role: 'member', change: r => r.e.sqlite.run('UPDATE members SET revoked_at = ? WHERE id = ?', [NOW, MEMBERS.admin.id]) },
    { name: 'the recipient is revoked', issuer: 'admin', target: 'member', role: 'member', change: r => r.e.sqlite.run('UPDATE members SET revoked_at = ? WHERE id = ?', [NOW, MEMBERS.member.id]) },
    { name: 'the admin issuer is downgraded', issuer: 'admin', target: 'new', role: 'member', change: r => r.e.sqlite.run("UPDATE members SET role = 'member' WHERE id = 'mem_machine_3'") },
    { name: 'the recipient is promoted to admin', issuer: 'admin', target: 'member', role: 'member', change: r => r.e.sqlite.run("UPDATE members SET role = 'admin' WHERE id = 'mem_machine_2'") },
    { name: 'ownership moves away from the issuer', issuer: 'owner', target: 'new', role: 'admin', change: r => r.e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_3', revision = revision + 1 WHERE id = 1") },
  ];

  for (const scenario of raced) {
    it(`refuses the invitation wherever it races ${scenario.name} before it stores`, async () => {
      const outcomes = await atEveryPoint(r => r.invite(scenario.issuer, scenario.target, scenario.role), scenario.change);
      try {
        for (const { at, r, response, before, committed } of outcomes) {
          if (committed) { expect({ at, status: response.status }).toEqual({ at, status: 201 }); continue; }
          expect({ at, status: response.status, refused: response.status >= 400 && response.status < 500, counts: r.counts() })
            .toEqual({ at, status: response.status, refused: true, counts: before });
        }
        // Landing just before the invitation stores, past every read of the request, the insert itself refuses it.
        const last = outcomes.filter(outcome => !outcome.committed).at(-1)!;
        expect({ at: last.at, status: last.response.status }).toEqual({ at: last.at, status: 403 });
      } finally { for (const { r } of outcomes) r.close(); }
    });
  }

  for (const scenario of raced.filter(each => each.name !== 'the recipient is revoked' && each.name !== 'the issuer is revoked')) {
    it(`refuses the join wherever it races ${scenario.name} before it stores, and leaves key and identity untouched`, async () => {
      let key = '';
      const invited = async (r: Rig) => {
        const invitation = await r.invite(scenario.issuer, scenario.target, scenario.role);
        expect(invitation.status).toBe(201);
        key = (await json(invitation)).key as string;
      };
      const outcomes = await atEveryPoint(r => r.join(key, 'race_join'), scenario.change, invited);
      try {
        for (const { at, r, response, before, committed } of outcomes) {
          const answer = await json(response);
          if (committed) { expect({ at, joined: answer.joined }).toEqual({ at, joined: true }); continue; }
          expect({ at, answer, counts: r.counts() }).toEqual({ at, answer: expect.objectContaining({ joined: false, code: 'enrollment_revoked' }), counts: before });
          expect({ at, used: r.e.sqlite.query('SELECT used_at FROM enrollment_authorities WHERE used_at IS NOT NULL').all() }).toEqual({ at, used: [] });
          expect({ at, claims: r.e.sqlite.query("SELECT member_id FROM machine_claims WHERE machine_id = 'race_join'").all() }).toEqual({ at, claims: [] });
        }
        expect(outcomes.some(outcome => !outcome.committed)).toBe(true);
      } finally { for (const { r } of outcomes) r.close(); }
    });
  }
});
