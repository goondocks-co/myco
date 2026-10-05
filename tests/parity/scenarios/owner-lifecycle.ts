import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { GITHUB_SUB, MEMBER_ID, SESSION_SECRET, lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

interface OwnershipPreview {
  ownerMemberId: string | null;
  revision: string;
  candidates: Array<{ memberId: string; label: string | null; role: 'admin' | 'member'; roleRevision: string }>;
  proposalMemberId: string | null;
}

interface Actor {
  id: string;
  token: string;
  headers: Record<string, string>;
}

const ACTORS = [
  { id: 'mem_owner_parity_admin_a', label: 'admin A', role: 'admin', sub: '720001' },
  { id: 'mem_owner_parity_admin_b', label: 'admin B', role: 'admin', sub: '720002' },
  { id: 'mem_owner_parity_member', label: 'member', role: 'member', sub: '720003' },
] as const;

async function fixtureActor(target: ParityTarget, fixture: typeof ACTORS[number]): Promise<Actor> {
  const now = Date.now();
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(43, 'x');
  const tokenId = `mt_${fixture.id}`;
  const machineId = `machine_${fixture.id}`;
  await target.sql(`INSERT INTO members (id,label,role,github_id,created_at) VALUES (${lit(fixture.id)},${lit(fixture.label)},${lit(fixture.role)},${lit(fixture.sub)},${now})`);
  await target.sql(`INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (${lit(machineId)},${lit(fixture.id)},${now})`);
  await target.sql(`INSERT INTO member_credentials (id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
    VALUES (${lit(tokenId)},${lit(fixture.id)},${lit(machineId)},${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
  const session = await signSession(SESSION_SECRET, { sub: fixture.sub, login: fixture.label, iat: now, exp: now + 3_600_000 });
  return { id: fixture.id, token,
    headers: { cookie: `${SESSION_COOKIE}=${session}`, 'cf-connecting-ip': '1.2.3.4' } };
}

function request(target: ParityTarget, path: string, headers: Record<string, string>, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${target.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, origin: target.url, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ownership(target: ParityTarget, headers: Record<string, string>): Promise<OwnershipPreview> {
  const response = await request(target, '/api/ownership', headers);
  expect(response.status).toBe(200);
  return response.json() as Promise<OwnershipPreview>;
}

async function snapshot(target: ParityTarget): Promise<{ owner: Record<string, unknown>[]; audit: Record<string, unknown>[]; roles: Record<string, unknown>[] }> {
  return {
    owner: await target.sql('SELECT member_id,revision FROM deployment_ownership'),
    audit: await target.sql('SELECT revision,member_id,actor_id FROM deployment_ownership_audit ORDER BY revision'),
    roles: await target.sql(`SELECT id,role,role_revision,revoked_at FROM members WHERE id IN (${[MEMBER_ID, ...ACTORS.map((actor) => actor.id)].map(lit).join(',')}) ORDER BY id`),
  };
}

/** Exercises ownership and role transitions through both dashboard sessions and member credentials. */
export const ownerLifecycle: ParityScenario = {
  name: 'owner lifecycle: explicit legacy selection, atomic transfer, role CAS, protected owner and credential Stop',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    await target.sql("UPDATE deployment_ownership SET bootstrap_mode = 'selection' WHERE id = 1");
    const proposed = await ownership(target, target.ownerHeaders());
    expect({ ownerMemberId: proposed.ownerMemberId, proposalMemberId: proposed.proposalMemberId, candidates: proposed.candidates })
      .toEqual({ ownerMemberId: null, proposalMemberId: MEMBER_ID,
        candidates: [{ memberId: MEMBER_ID, label: target.name === 'cloudflare' ? MEMBER_ID : 'parity', role: 'admin', roleRevision: '0' }] });
    const soleAdminRevocations = await Promise.all(Array.from({ length: 2 }, () =>
      request(target, `/api/members/${MEMBER_ID}/revoke`, target.ownerHeaders(), {})));
    for (const refused of soleAdminRevocations) {
      expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 409, body: { error: 'owner_pending' } });
    }
    expect(await target.sql(`SELECT role,github_id,revoked_at FROM members WHERE id = ${lit(MEMBER_ID)}`))
      .toEqual([{ role: 'admin', github_id: GITHUB_SUB, revoked_at: null }]);
    const adminA = await fixtureActor(target, ACTORS[0]);
    const adminB = await fixtureActor(target, ACTORS[1]);
    const member = await fixtureActor(target, ACTORS[2]);
    const initial = await ownership(target, target.ownerHeaders());
    expect(initial.ownerMemberId).toBeNull();
    expect(initial.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: MEMBER_ID, role: 'admin' }),
      expect.objectContaining({ memberId: adminA.id, role: 'admin' }),
      expect.objectContaining({ memberId: adminB.id, role: 'admin' }),
    ]));
    expect(initial.candidates.map((candidate) => candidate.memberId)).not.toContain(member.id);
    expect(initial.proposalMemberId).toBeNull();
    const memberInitial = await request(target, '/members/ownership', memberHeadersFor(adminA.token, target.projectId));
    expect(memberInitial.status).toBe(200);
    expect(await memberInitial.json()).toMatchObject({ persisted: true, ownerMemberId: null, revision: initial.revision });

    const beforeBootstrap = await snapshot(target);
    const competingRevocations = await Promise.all([adminA.id, adminB.id].map((id) =>
      request(target, `/api/members/${id}/revoke`, target.ownerHeaders(), {})));
    for (const refused of competingRevocations) {
      expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 409, body: { error: 'owner_pending' } });
    }
    for (const [path, headers, body] of [
      ['/api/ownership/transfer', adminA.headers, { member_id: adminB.id, expected_revision: initial.revision }],
      ['/members/ownership/transfer', memberHeadersFor(adminA.token, target.projectId), { member_id: adminB.id, expected_revision: initial.revision }],
      [`/api/members/${member.id}/role`, adminA.headers, { role: 'admin', expected_revision: '0' }],
      ['/members/roles', memberHeadersFor(adminA.token, target.projectId), { member_id: member.id, role: 'admin', expected_revision: '0' }],
    ] as const) {
      const refused = await request(target, path, headers, body);
      expect({ status: refused.status, body: await refused.json() }).toEqual(path.startsWith('/members/')
        ? { status: 200, body: { persisted: false, code: 'owner_pending', reason: 'owner_pending' } }
        : { status: 409, body: { error: 'owner_pending' } });
    }
    expect(await snapshot(target)).toEqual(beforeBootstrap);

    const selected = await request(target, '/api/ownership', target.ownerHeaders(), { ownerMemberId: MEMBER_ID, revision: initial.revision });
    expect(selected.status).toBe(200);
    expect((await selected.json() as OwnershipPreview).ownerMemberId).toBe(MEMBER_ID);
    const afterBootstrap = await snapshot(target);
    expect(afterBootstrap.audit).toEqual([{ revision: 1, member_id: MEMBER_ID, actor_id: MEMBER_ID }]);

    const savedAdminLinks = await target.sql(`SELECT id,github_id FROM members WHERE id IN (${[MEMBER_ID, adminA.id, adminB.id].map(lit).join(',')}) ORDER BY id`);
    try {
      await target.sql(`UPDATE members SET github_id = NULL WHERE id IN (${lit(MEMBER_ID)},${lit(adminB.id)})`);
      const ownerCredential = memberHeadersFor(target.memberToken, target.projectId);
      const credentialPreview = await request(target, '/members/ownership', ownerCredential);
      expect(await credentialPreview.json()).toMatchObject({ persisted: true, ownerMemberId: MEMBER_ID });
      const beforeDemotion = await target.sql(`SELECT role,role_revision FROM members WHERE id = ${lit(adminA.id)}`);
      const beforeAudit = await target.sql(`SELECT member_id,revision FROM member_role_audit WHERE member_id = ${lit(adminA.id)}`);
      const racedDemotions = await Promise.all(Array.from({ length: 2 }, () =>
        request(target, '/members/roles', ownerCredential,
          { member_id: adminA.id, role: 'member', expected_revision: '0' })));
      for (const refused of racedDemotions) {
        expect({ status: refused.status, body: await refused.json() })
          .toEqual({ status: 200, body: { persisted: false, code: 'revision_conflict', reason: 'revision_conflict' } });
      }
      expect(await target.sql(`SELECT role,role_revision FROM members WHERE id = ${lit(adminA.id)}`)).toEqual(beforeDemotion);
      expect(await target.sql(`SELECT member_id,revision FROM member_role_audit WHERE member_id = ${lit(adminA.id)}`)).toEqual(beforeAudit);
    } finally {
      for (const row of savedAdminLinks) {
        await target.sql(`UPDATE members SET github_id = ${row.github_id === null ? 'NULL' : lit(String(row.github_id))} WHERE id = ${lit(String(row.id))}`);
      }
    }
    expect(await snapshot(target)).toEqual(afterBootstrap);

    for (const actor of [adminA, member]) {
      const denied = await request(target, '/api/ownership/transfer', actor.headers, { member_id: adminB.id, expected_revision: '1' });
      expect(denied.status).toBe(403);
    }
    for (const actor of [adminA, member]) {
      const denied = await request(target, '/members/roles', memberHeadersFor(actor.token, target.projectId),
        { member_id: member.id, role: 'admin', expected_revision: '0' });
      expect(await denied.json()).toMatchObject({ persisted: false });
    }
    expect(await snapshot(target)).toEqual(afterBootstrap);

    const transfer = (candidate: Actor) => request(target, '/api/ownership/transfer', target.ownerHeaders(),
      { member_id: candidate.id, expected_revision: '1' });
    const [first, second] = await Promise.all([transfer(adminA), transfer(adminB)]);
    expect([first.status, second.status].filter((status) => status === 200)).toHaveLength(1);
    expect([first.status, second.status].filter((status) => status === 403 || status === 409)).toHaveLength(1);
    const winner = first.status === 200 ? adminA : adminB;
    const loser = first.status === 200 ? adminB : adminA;
    const moved = await ownership(target, winner.headers);
    expect({ owner: moved.ownerMemberId, revision: moved.revision }).toEqual({ owner: winner.id, revision: '2' });
    expect(await target.sql('SELECT revision,member_id,actor_id FROM deployment_ownership_audit ORDER BY revision')).toEqual([
      { revision: 1, member_id: MEMBER_ID, actor_id: MEMBER_ID },
      { revision: 2, member_id: winner.id, actor_id: MEMBER_ID },
    ]);
    const afterTransfer = await snapshot(target);
    const staleTransfer = await request(target, '/api/ownership/transfer', winner.headers,
      { member_id: loser.id, expected_revision: '1' });
    expect({ status: staleTransfer.status, body: await staleTransfer.json() })
      .toEqual({ status: 409, body: { error: 'revision_conflict' } });
    expect(await snapshot(target)).toEqual(afterTransfer);
    const former = await request(target, '/auth/me', target.ownerHeaders());
    expect((await former.json() as { member: { role: string }; owner: boolean }).owner).toBe(false);
    expect((await target.sql(`SELECT role FROM members WHERE id = ${lit(MEMBER_ID)}`))[0]?.role).toBe('admin');
    expect((await request(target, '/api/ownership/transfer', target.ownerHeaders(), { member_id: loser.id, expected_revision: moved.revision })).status).toBe(403);

    const roleRevision = String((await target.sql(`SELECT role_revision FROM members WHERE id = ${lit(member.id)}`))[0]?.role_revision);
    const promote = await request(target, `/api/members/${member.id}/role`, winner.headers, { role: 'admin', expected_revision: roleRevision });
    expect(promote.status).toBe(200);
    const promotedRevision = String((await target.sql(`SELECT role_revision FROM members WHERE id = ${lit(member.id)}`))[0]?.role_revision);
    expect({ role: (await target.sql(`SELECT role FROM members WHERE id = ${lit(member.id)}`))[0]?.role, advanced: promotedRevision !== roleRevision })
      .toEqual({ role: 'admin', advanced: true });
    const stale = await request(target, '/members/roles', memberHeadersFor(winner.token, target.projectId),
      { member_id: member.id, role: 'member', expected_revision: roleRevision });
    expect(await stale.json()).toMatchObject({ persisted: false, code: 'revision_conflict' });
    expect((await target.sql(`SELECT role FROM members WHERE id = ${lit(member.id)}`))[0]?.role).toBe('admin');
    const demote = await request(target, '/members/roles', memberHeadersFor(winner.token, target.projectId),
      { member_id: member.id, role: 'member', expected_revision: promotedRevision });
    expect(await demote.json()).toMatchObject({ persisted: true });
    expect((await target.sql(`SELECT role FROM members WHERE id = ${lit(member.id)}`))[0]?.role).toBe('member');
    expect(await target.sql(`SELECT revision,previous_role,role,actor_id FROM member_role_audit WHERE member_id = ${lit(member.id)} ORDER BY revision`)).toEqual([
      { revision: 1, previous_role: 'member', role: 'admin', actor_id: winner.id },
      { revision: 2, previous_role: 'admin', role: 'member', actor_id: winner.id },
    ]);

    const ownerRole = String((await target.sql(`SELECT role_revision FROM members WHERE id = ${lit(winner.id)}`))[0]?.role_revision);
    const protectedRole = await request(target, `/api/members/${winner.id}/role`, winner.headers, { role: 'member', expected_revision: ownerRole });
    expect(protectedRole.status).toBe(409);
    const protectedMember = await request(target, `/api/members/${winner.id}/revoke`, winner.headers, {});
    expect(protectedMember.status).toBe(409);
    expect(await target.sql(`SELECT role,revoked_at FROM members WHERE id = ${lit(winner.id)}`)).toEqual([{ role: 'admin', revoked_at: null }]);

    const backup = await request(target, '/api/backups', winner.headers, {});
    expect(backup.status).toBe(200);
    const backupId = (await backup.json() as { backup: { id: string } }).backup.id;
    const artifact = await request(target, `/api/backups/${backupId}/artifact`, winner.headers);
    expect(artifact.status).toBe(200);
    const records = (await artifact.text()).trim().split('\n').slice(1).map((line) => JSON.parse(line) as { t: string; r: Record<string, unknown> });
    expect(records.filter((record) => record.t === 'deployment_ownership').map((record) => record.r.member_id)).toEqual([winner.id]);
    expect(records.filter((record) => record.t === 'deployment_ownership_audit').map((record) => record.r.revision)).toEqual([1, 2]);
    expect(records.filter((record) => record.t === 'member_role_audit' && record.r.member_id === member.id).map((record) => record.r.revision)).toEqual([1, 2]);
    const beforeRestore = await snapshot(target);
    const restored = await request(target, `/api/backups/${backupId}/restore`, winner.headers, {});
    expect(restored.status).toBe(200);
    expect(await snapshot(target)).toEqual(beforeRestore);

    const returned = await request(target, '/members/ownership/transfer', memberHeadersFor(winner.token, target.projectId),
      { member_id: MEMBER_ID, expected_revision: moved.revision });
    expect(await returned.json()).toMatchObject({ persisted: true, ownerMemberId: MEMBER_ID, revision: '3' });
    expect(await target.sql('SELECT revision,member_id,actor_id,previous_member_id,operation FROM deployment_ownership_audit WHERE revision = 3'))
      .toEqual([{ revision: 3, member_id: MEMBER_ID, actor_id: winner.id, previous_member_id: winner.id, operation: 'transfer' }]);
    const ownerTokenId = String((await target.sql(`SELECT id FROM member_credentials WHERE token_hash = ${lit(await sha256Hex(target.memberToken))}`))[0]?.id);
    const stopDenied = await request(target, `/api/credentials/${ownerTokenId}/revoke`, winner.headers, {});
    expect((await stopDenied.json() as { revoked: boolean }).revoked).toBe(false);
    expect((await target.sql(`SELECT revoked_at FROM member_credentials WHERE id = ${lit(ownerTokenId)}`))[0]?.revoked_at).toBeNull();
    const stopped = await request(target, `/api/credentials/${ownerTokenId}/revoke`, target.ownerHeaders(), {});
    expect(stopped.status).toBe(200);
    expect((await stopped.json() as { revoked: boolean }).revoked).toBe(true);
    expect((await target.sql(`SELECT revoked_at FROM member_credentials WHERE id = ${lit(ownerTokenId)}`))[0]?.revoked_at).not.toBeNull();
    const stillSignedIn = await request(target, '/auth/me', target.ownerHeaders());
    expect((await stillSignedIn.json() as { member: { id: string }; owner: boolean }).member.id).toBe(MEMBER_ID);
    expect((await request(target, '/api/ownership', target.ownerHeaders())).status).toBe(200);

    const [racedTransfer, racedRevocation] = await Promise.all([
      request(target, '/api/ownership/transfer', target.ownerHeaders(), { member_id: loser.id, expected_revision: '3' }),
      request(target, `/api/members/${loser.id}/revoke`, target.ownerHeaders(), {}),
    ]);
    expect([racedTransfer.status, racedRevocation.status].filter((status) => status === 200)).toHaveLength(1);
    const settled = await ownership(target, target.ownerHeaders());
    const ownerRow = await target.sql(`SELECT m.id,m.role,m.github_id,m.revoked_at FROM deployment_ownership o JOIN members m ON m.id = o.member_id WHERE o.id = 1`);
    expect(ownerRow).toEqual([{ id: settled.ownerMemberId, role: 'admin', github_id: settled.ownerMemberId === MEMBER_ID ? GITHUB_SUB : ACTORS.find((actor) => actor.id === loser.id)!.sub, revoked_at: null }]);
    expect(await target.sql('SELECT member_id,revision FROM deployment_ownership WHERE id = 1')).toEqual([{ member_id: settled.ownerMemberId, revision: Number(settled.revision) }]);
    const latestAudit = await target.sql('SELECT member_id,revision FROM deployment_ownership_audit ORDER BY revision DESC LIMIT 1');
    expect(latestAudit).toEqual([{ member_id: settled.ownerMemberId, revision: Number(settled.revision) }]);
  },
};

/** A fresh store commits its first linked identity and owner reference together. */
export const freshOwnerLink: ParityScenario = {
  name: 'owner lifecycle: first authenticated GitHub link atomically selects the fresh Deployment owner',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    expect(await target.sql('SELECT bootstrap_mode,member_id,revision FROM deployment_ownership WHERE id = 1'))
      .toEqual([{ bootstrap_mode: 'fresh', member_id: null, revision: 0 }]);
    await target.sql(`UPDATE members SET github_id = NULL WHERE id = ${lit(MEMBER_ID)}`);
    const link = await request(target, '/members/link-github', target.memberHeaders(), {});
    expect(link.status).toBe(200);
    const key = (await link.json() as { persisted: boolean; key: string }).key;
    const session = await signSession(SESSION_SECRET, { sub: GITHUB_SUB, login: 'parity', iat: Date.now(), exp: Date.now() + 3_600_000 });
    const owner = { cookie: `${SESSION_COOKIE}=${session}`, 'cf-connecting-ip': '1.2.3.4' };
    const confirmed = await request(target, '/auth/link', owner, { key, confirm: true });
    expect(confirmed.status).toBe(200);
    expect(await target.sql('SELECT member_id,revision FROM deployment_ownership WHERE id = 1')).toEqual([{ member_id: MEMBER_ID, revision: 1 }]);
    expect(await target.sql('SELECT revision,member_id,actor_id,operation FROM deployment_ownership_audit'))
      .toEqual([{ revision: 1, member_id: MEMBER_ID, actor_id: MEMBER_ID, operation: 'bootstrap' }]);
    const me = await request(target, '/auth/me', owner);
    expect((await me.json() as { owner: boolean }).owner).toBe(true);
  },
};

/** An interrupted owner-authorized restore preserves the selected owner and committed earlier chunks. */
export const interruptedRestoreOwner: ParityScenario = {
  name: 'owner lifecycle: interrupted restore preserves selected owner and imported administrator',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    const restoredId = 'mem_owner_parity_restored';
    const restoredSub = '720004';
    const machineId = 'machine_owner_parity_restored';
    const now = Date.now();
    const meta = await target.sql("SELECT key,value FROM schema_meta WHERE key IN ('deployment_id','version')");
    const deploymentId = String(meta.find((row) => row.key === 'deployment_id')?.value);
    const schemaVersion = Number(meta.find((row) => row.key === 'version')?.value);
    const artifact = [
      { format: 'myco-backup/1', deploymentId, schemaVersion, createdAt: now, producer: 'parity', counts: { members: 1, machine_claims: 1 } },
      { t: 'members', r: { id: restoredId, label: 'restored admin', role: 'admin', role_revision: 0, created_at: now } },
      { t: 'machine_claims', r: { machine_id: machineId, member_id: restoredId, claimed_at: now } },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n';
    const ownerless = await request(target, '/api/backups/restore-upload', target.ownerHeaders(), { artifact });
    expect({ status: ownerless.status, body: await ownerless.json() }).toEqual({ status: 409, body: { error: 'owner_pending' } });
    expect(await target.sql(`SELECT id FROM members WHERE id = ${lit(restoredId)}`)).toEqual([]);
    await target.sql("UPDATE deployment_ownership SET bootstrap_mode = 'selection' WHERE id = 1");
    const selectedOwner = await request(target, '/api/ownership', target.ownerHeaders(), { ownerMemberId: MEMBER_ID, revision: '0' });
    expect(selectedOwner.status).toBe(200);
    await target.sql(`CREATE TRIGGER interrupted_owner_restore BEFORE INSERT ON machine_claims
      WHEN NEW.machine_id = ${lit(machineId)} BEGIN SELECT RAISE(ABORT, 'interrupted owner restore'); END`);
    try {
      const failed = await request(target, '/api/backups/restore-upload', target.ownerHeaders(), { artifact });
      expect(failed.status).toBe(400);
      expect((await failed.json() as { reason: string }).reason).toContain('interrupted owner restore');
    } finally {
      await target.sql('DROP TRIGGER interrupted_owner_restore');
    }
    expect(await target.sql(`SELECT id,role,github_id FROM members WHERE id = ${lit(restoredId)}`))
      .toEqual([{ id: restoredId, role: 'admin', github_id: null }]);
    expect(await target.sql('SELECT member_id,revision,bootstrap_mode FROM deployment_ownership WHERE id = 1'))
      .toEqual([{ member_id: MEMBER_ID, revision: 1, bootstrap_mode: 'selection' }]);

    const issued = await request(target, `/api/members/${restoredId}/link-github`, target.ownerHeaders(), {});
    expect(issued.status).toBe(201);
    const key = (await issued.json() as { key: string }).key;
    const session = await signSession(SESSION_SECRET, { sub: restoredSub, login: 'restored', iat: now, exp: now + 3_600_000 });
    const restoredHeaders = { cookie: `${SESSION_COOKIE}=${session}`, 'cf-connecting-ip': '1.2.3.4' };
    expect((await request(target, '/auth/link', restoredHeaders, { key, confirm: true })).status).toBe(200);
    const pending = await ownership(target, restoredHeaders);
    expect({ owner: pending.ownerMemberId, revision: pending.revision, proposal: pending.proposalMemberId })
      .toEqual({ owner: MEMBER_ID, revision: '1', proposal: null });
    expect(await target.sql('SELECT COUNT(*) AS n FROM deployment_ownership_audit')).toEqual([{ n: 1 }]);
    const transferred = await request(target, '/api/ownership/transfer', target.ownerHeaders(), { member_id: restoredId, expected_revision: pending.revision });
    expect(transferred.status).toBe(200);
    expect((await transferred.json() as OwnershipPreview).ownerMemberId).toBe(restoredId);
    expect(await target.sql('SELECT revision,member_id,actor_id FROM deployment_ownership_audit ORDER BY revision'))
      .toEqual([{ revision: 1, member_id: MEMBER_ID, actor_id: MEMBER_ID }, { revision: 2, member_id: restoredId, actor_id: MEMBER_ID }]);
  },
};

/** Additive recovery keeps each local authority row paired with its own audit revision. */
export const restoredAuditAuthority: ParityScenario = {
  name: 'owner lifecycle: restored future audit rows cannot misattribute the next owner or role change',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    const admin = await fixtureActor(target, ACTORS[0]);
    const member = await fixtureActor(target, ACTORS[2]);
    const now = Date.now();
    const meta = await target.sql("SELECT key,value FROM schema_meta WHERE key IN ('deployment_id','version')");
    const deploymentId = String(meta.find((row) => row.key === 'deployment_id')?.value);
    const schemaVersion = Number(meta.find((row) => row.key === 'version')?.value);
    const artifact = (rows: Array<{ t: string; r: Record<string, unknown> }>) => {
      const counts = Object.fromEntries([...new Set(rows.map((row) => row.t))].map((table) => [table, rows.filter((row) => row.t === table).length]));
      return [{ format: 'myco-backup/1', deploymentId, schemaVersion, createdAt: now, producer: 'parity', counts }, ...rows]
        .map((row) => JSON.stringify(row)).join('\n') + '\n';
    };
    const restore = async (rows: Array<{ t: string; r: Record<string, unknown> }>, headers: Record<string, string>) => {
      const response = await request(target, '/api/backups/restore-upload', headers, { artifact: artifact(rows) });
      expect(response.status).toBe(200);
    };

    const selected = await request(target, '/api/ownership', target.ownerHeaders(), { ownerMemberId: MEMBER_ID, revision: '0' });
    expect(selected.status).toBe(200);
    const promoted = await request(target, `/api/members/${member.id}/role`, target.ownerHeaders(), { role: 'admin', expected_revision: '0' });
    expect(promoted.status).toBe(200);
    expect(await target.sql('SELECT member_id,revision FROM deployment_ownership WHERE id = 1')).toEqual([{ member_id: MEMBER_ID, revision: 1 }]);
    expect(await target.sql(`SELECT role,role_revision FROM members WHERE id = ${lit(member.id)}`)).toEqual([{ role: 'admin', role_revision: 1 }]);

    await restore([
      { t: 'deployment_ownership', r: { id: 1, member_id: admin.id, revision: 2, bootstrap_mode: 'selection' } },
      { t: 'deployment_ownership_audit', r: { revision: 2, member_id: admin.id, actor_id: MEMBER_ID,
        created_at: now, previous_member_id: MEMBER_ID, operation: 'transfer' } },
    ], target.ownerHeaders());
    expect(await target.sql('SELECT member_id,revision FROM deployment_ownership WHERE id = 1')).toEqual([{ member_id: MEMBER_ID, revision: 1 }]);
    expect(await target.sql('SELECT revision,member_id,actor_id FROM deployment_ownership_audit ORDER BY revision'))
      .toEqual([{ revision: 1, member_id: MEMBER_ID, actor_id: MEMBER_ID }]);
    const transferred = await request(target, '/api/ownership/transfer', target.ownerHeaders(), { member_id: admin.id, expected_revision: '1' });
    expect(transferred.status).toBe(200);
    expect(await target.sql('SELECT revision,member_id,actor_id FROM deployment_ownership_audit ORDER BY revision')).toEqual([
      { revision: 1, member_id: MEMBER_ID, actor_id: MEMBER_ID },
      { revision: 2, member_id: admin.id, actor_id: MEMBER_ID },
    ]);

    await restore([
      { t: 'members', r: { id: member.id, label: 'member', role: 'member', role_revision: 2, github_id: ACTORS[2].sub, created_at: now } },
      { t: 'member_role_audit', r: { member_id: member.id, revision: 2, previous_role: 'admin', role: 'member', actor_id: admin.id, created_at: now } },
    ], admin.headers);
    expect(await target.sql(`SELECT role,role_revision FROM members WHERE id = ${lit(member.id)}`)).toEqual([{ role: 'admin', role_revision: 1 }]);
    expect(await target.sql(`SELECT revision,role,actor_id FROM member_role_audit WHERE member_id = ${lit(member.id)} ORDER BY revision`))
      .toEqual([{ revision: 1, role: 'admin', actor_id: MEMBER_ID }]);
    const demoted = await request(target, `/api/members/${member.id}/role`, admin.headers, { role: 'member', expected_revision: '1' });
    expect(demoted.status).toBe(200);
    expect(await target.sql(`SELECT revision,role,actor_id FROM member_role_audit WHERE member_id = ${lit(member.id)} ORDER BY revision`)).toEqual([
      { revision: 1, role: 'admin', actor_id: MEMBER_ID },
      { revision: 2, role: 'member', actor_id: admin.id },
    ]);
  },
};
