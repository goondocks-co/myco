import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { memberSubject } from '@myco-server-worker/auth/authorization.js';
import { EnrollmentAuthorizationError, issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const NOW = Date.now();
const MEMBERS = {
  owner: { id: 'mem_machine_1', github: '583231', role: 'owner' },
  admin: { id: 'mem_machine_3', github: '770003', role: 'admin' },
  member: { id: 'mem_machine_2', github: '770001', role: 'member' },
} as const;
type Issuer = keyof typeof MEMBERS;
type Target = 'new' | Issuer;
type RequestedRole = 'omitted' | 'member' | 'admin';

function rig(onSql?: (sql: string, sqlite: ReturnType<typeof sqliteEnv>['sqlite']) => void) {
  const e = sqliteEnv(onSql === undefined ? {} : { onSql });
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
  }, await ownerCookie(NOW, MEMBERS[issuer].github));
  const join = (key: string, machineId: string) => call('/members/join', { key, machineId });
  const count = (table: 'enrollment_authorities' | 'member_credentials' | 'machine_claims') =>
    (e.sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  const counts = () => ({ invitations: count('enrollment_authorities'), credentials: count('member_credentials'), claims: count('machine_claims') });
  return { e, env, server, invite, join, counts, close: () => e.sqlite.close() };
}

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
  for (const target of ['issuer', 'recipient'] as const) {
    it(`refuses a ${target} revocation at the invitation INSERT`, async () => {
      let changed = false;
      const r = rig((sql, sqlite) => {
        if (!changed && /INSERT INTO enrollment_authorities/i.test(sql)) {
          changed = true;
          sqlite.run('UPDATE members SET revoked_at = ? WHERE id = ?', [NOW, MEMBERS[target === 'issuer' ? 'admin' : 'member'].id]);
        }
      });
      try {
        const before = r.counts();
        expect((await r.invite('admin', target === 'issuer' ? 'new' : 'member', 'member')).status).toBe(403);
        expect(changed).toBe(true);
        expect(r.counts()).toEqual(before);
      } finally { r.close(); }
    });
  }
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

  it('guards issuer authority at the insertion statement after the HTTP preflight', async () => {
    let changed = false;
    const r = rig((sql, sqlite) => {
      if (!changed && /INSERT INTO enrollment_authorities/i.test(sql)) {
        changed = true;
        sqlite.run("UPDATE members SET role = 'member' WHERE id = 'mem_machine_3'");
      }
    });
    try {
      const before = r.counts();
      const response = await r.invite('admin', 'new', 'member');
      expect(changed).toBe(true);
      expect(response.status).toBe(403);
      expect(r.counts()).toEqual(before);
    } finally { r.close(); }
  });

  it('guards target authority at the insertion statement after the HTTP preflight', async () => {
    let changed = false;
    const r = rig((sql, sqlite) => {
      if (!changed && /INSERT INTO enrollment_authorities/i.test(sql)) {
        changed = true;
        sqlite.run("UPDATE members SET role = 'admin' WHERE id = 'mem_machine_2'");
      }
    });
    try {
      const before = r.counts();
      const response = await r.invite('admin', 'member', 'member');
      expect(changed).toBe(true);
      expect(response.status).toBe(403);
      expect(r.counts()).toEqual(before);
    } finally { r.close(); }
  });

  it('guards ownership at the insertion statement after the HTTP preflight', async () => {
    let changed = false;
    const r = rig((sql, sqlite) => {
      if (!changed && /INSERT INTO enrollment_authorities/i.test(sql)) {
        changed = true;
        sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_3', revision = revision + 1 WHERE id = 1");
      }
    });
    try {
      const before = r.counts();
      const response = await r.invite('owner', 'new', 'admin');
      expect(changed).toBe(true);
      expect(response.status).toBe(403);
      expect(r.counts()).toEqual(before);
    } finally { r.close(); }
  });

  it('guards issuer authority inside the join batch after the invitation read', async () => {
    let mutateOnBatch = false;
    let changed = false;
    const r = rig((sql, sqlite) => {
      if (mutateOnBatch && !changed && /INSERT OR IGNORE INTO members/i.test(sql)) {
        changed = true;
        sqlite.run("UPDATE members SET role = 'member' WHERE id = 'mem_machine_3'");
      }
    });
    try {
      const invitation = await r.invite('admin', 'new', 'member');
      expect(invitation.status).toBe(201);
      const key = (await json(invitation)).key as string;
      mutateOnBatch = true;
      await refusedJoin(r, key, 'race_join_issuer');
      expect(changed).toBe(true);
    } finally { r.close(); }
  });

  for (const scenario of [
    {
      name: 'target promotion', issuer: 'admin', target: 'member', role: 'member', machineId: 'race_join_target',
      change: (r: ReturnType<typeof rig>) => r.e.sqlite.run("UPDATE members SET role = 'admin' WHERE id = 'mem_machine_2'"),
    },
    {
      name: 'owner transfer', issuer: 'owner', target: 'new', role: 'admin', machineId: 'race_join_owner',
      change: (r: ReturnType<typeof rig>) => r.e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_3', revision = revision + 1 WHERE id = 1"),
    },
  ] as const) {
    it(`guards ${scenario.name} inside the join batch after the invitation read`, async () => {
      let mutateOnBatch = false;
      let changed = false;
      const r = rig(sql => {
        if (mutateOnBatch && !changed && /INSERT OR IGNORE INTO members/i.test(sql)) {
          changed = true;
          scenario.change(r);
        }
      });
      try {
        const invitation = await r.invite(scenario.issuer, scenario.target, scenario.role);
        expect(invitation.status).toBe(201);
        const key = (await json(invitation)).key as string;
        mutateOnBatch = true;
        await refusedJoin(r, key, scenario.machineId);
        expect(changed).toBe(true);
      } finally { r.close(); }
    });
  }
});
