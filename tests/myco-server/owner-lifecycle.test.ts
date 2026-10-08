import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { changeMemberRole, ownershipPreview, transferOwnership } from '@myco-server-worker/core/ownership.js';
import { bootstrapOwnership } from '@myco-server-worker/core/raw-claims.js';
import { issueIdentityLinkAuthority, spendIdentityLinkAuthority, memberByGithubId } from '@myco-server-worker/auth/identity-link.js';
import { revokeMember } from '@myco-server-worker/auth/members-admin.js';
import { issueMemberToken, revokeCredentialAsMember, revokeMachineCredentialsAsMember } from '@myco-server-worker/auth/tokens.js';
import { BACKUP_FORMAT, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { envelope, memberPost, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const OWNER = 'mem_machine_1';
const ADMIN = 'mem_machine_2';
const MEMBER = 'mem_machine_3';
const NOW = Date.now();

async function rig() {
  const f = sqliteEnv();
  f.sqlite.run("UPDATE members SET github_id='9002',role='admin' WHERE id=?", [ADMIN]);
  f.sqlite.run("UPDATE members SET github_id='9003',role='member' WHERE id=?", [MEMBER]);
  await bootstrapOwnership(f.db, OWNER, OWNER, '0', NOW);
  return f;
}

async function request(db: ReturnType<typeof sqliteEnv>['db'], env: unknown, sub: string, path: string, body: unknown) {
  return worker.fetch(new Request(`https://s${path}`, { method: 'POST', headers: {
    cookie: await ownerCookie(db, Date.now(), sub), origin: 'https://s', 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json',
  }, body: JSON.stringify(body) }), env as never);
}

describe('owner lifecycle mutation gates', () => {
  it('rechecks transfer target liveness and role actor authority at the conditional writes', async () => {
    for (const kind of ['transfer', 'role'] as const) {
      let armed = false;
      const f = sqliteEnv({ onSql: (sql, sqlite) => {
        if (!armed || !(kind === 'transfer' ? /UPDATE deployment_ownership SET member_id/.test(sql) : /UPDATE members SET role =/.test(sql))) return;
        armed = false;
        if (kind === 'transfer') sqlite.run('UPDATE members SET revoked_at=? WHERE id=?', [NOW, ADMIN]);
        else sqlite.run('UPDATE deployment_ownership SET member_id=?,revision=revision+1 WHERE id=1', [ADMIN]);
      } });
      try {
        f.sqlite.run("UPDATE members SET github_id='9002',role='admin' WHERE id=?", [ADMIN]);
        f.sqlite.run("UPDATE members SET role='member' WHERE id=?", [MEMBER]);
        await bootstrapOwnership(f.db, OWNER, OWNER, '0', NOW);
        armed = true;
        await expect(kind === 'transfer' ? transferOwnership(f.db, OWNER, ADMIN, '1', NOW)
          : changeMemberRole(f.db, OWNER, MEMBER, 'admin', '0', NOW)).rejects.toThrow('revision_conflict');
        expect(f.sqlite.query('SELECT COUNT(*) AS n FROM member_role_audit').get()).toEqual({ n: 0 });
        expect(f.sqlite.query('SELECT role,role_revision FROM members WHERE id=?').get(MEMBER)).toEqual({ role: 'member', role_revision: 0 });
        if (kind === 'transfer') expect(await ownershipPreview(f.db)).toMatchObject({ ownerMemberId: OWNER, revision: '1' });
      } finally { f.sqlite.close(); }
    }
  });

  it('rejects revoked, unlinked and non-admin transfer targets without changing ownership', async () => {
    const f = await rig();
    try {
      for (const state of ["revoked_at=1", "revoked_at=NULL,github_id=NULL", "github_id='9002',role='member'"]) {
        f.sqlite.run(`UPDATE members SET ${state} WHERE id=?`, [ADMIN]);
        await expect(transferOwnership(f.db, OWNER, ADMIN, '1', NOW)).rejects.toThrow('invalid_owner');
        expect(await ownershipPreview(f.db)).toMatchObject({ ownerMemberId: OWNER, revision: '1' });
      }
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM deployment_ownership_audit').get()).toEqual({ n: 1 });
    } finally { f.sqlite.close(); }
  });

  it('retains the last linked administrator when the recorded owner requires account recovery', async () => {
    const f = await rig();
    try {
      f.sqlite.run('UPDATE members SET github_id=NULL WHERE id=?', [OWNER]);
      await expect(changeMemberRole(f.db, OWNER, ADMIN, 'member', '0', NOW)).rejects.toThrow('revision_conflict');
      expect(await revokeMember(f.db, ADMIN, OWNER, NOW)).toEqual({ ok: false, reason: 'last_admin' });
      expect(f.sqlite.query('SELECT role,revoked_at,role_revision FROM members WHERE id=?').get(ADMIN)).toEqual({ role: 'admin', revoked_at: null, role_revision: 0 });
    } finally { f.sqlite.close(); }
  });

  it('transfers once under revision, preserves old admin rights and attributes the complete audit', async () => {
    const f = await rig();
    try {
      const transfers = await Promise.allSettled([
        transferOwnership(f.db, OWNER, ADMIN, '1', NOW),
        transferOwnership(f.db, OWNER, ADMIN, '1', NOW + 1),
      ]);
      expect(transfers.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(await ownershipPreview(f.db)).toMatchObject({ ownerMemberId: ADMIN, revision: '2' });
      expect(f.sqlite.query('SELECT role FROM members WHERE id=?').get(OWNER)).toEqual({ role: 'admin' });
      expect(f.sqlite.query('SELECT revision,member_id,actor_id,previous_member_id,operation FROM deployment_ownership_audit ORDER BY revision').all()).toEqual([
        { revision: 1, member_id: OWNER, actor_id: OWNER, previous_member_id: null, operation: 'bootstrap' },
        { revision: 2, member_id: ADMIN, actor_id: OWNER, previous_member_id: OWNER, operation: 'transfer' },
      ]);
      await expect(transferOwnership(f.db, ADMIN, OWNER, '1', NOW)).rejects.toThrow('revision_conflict');
    } finally { f.sqlite.close(); }
  });

  it('rolls back ownership and roles when their receipt fails', async () => {
    const f = await rig();
    try {
      f.sqlite.run("CREATE TRIGGER refuse_transfer BEFORE INSERT ON deployment_ownership_audit WHEN NEW.operation='transfer' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
      await expect(transferOwnership(f.db, OWNER, ADMIN, '1', NOW)).rejects.toThrow('receipt failure');
      expect(await ownershipPreview(f.db)).toMatchObject({ ownerMemberId: OWNER, revision: '1' });
      f.sqlite.run("CREATE TRIGGER refuse_role BEFORE INSERT ON member_role_audit BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
      await expect(changeMemberRole(f.db, OWNER, MEMBER, 'admin', '0', NOW)).rejects.toThrow('receipt failure');
      expect(f.sqlite.query('SELECT role,role_revision FROM members WHERE id=?').get(MEMBER)).toEqual({ role: 'member', role_revision: 0 });
    } finally { f.sqlite.close(); }
  });

  it('revisioned role promotion and demotion preserve attribution and refuse the active owner', async () => {
    const f = await rig();
    try {
      expect(await changeMemberRole(f.db, OWNER, MEMBER, 'admin', '0', NOW)).toEqual({ memberId: MEMBER, role: 'admin', roleRevision: '1' });
      await expect(changeMemberRole(f.db, OWNER, MEMBER, 'member', '0', NOW)).rejects.toThrow('revision_conflict');
      expect(await changeMemberRole(f.db, OWNER, MEMBER, 'member', '1', NOW + 1)).toEqual({ memberId: MEMBER, role: 'member', roleRevision: '2' });
      await expect(changeMemberRole(f.db, OWNER, OWNER, 'member', '0', NOW)).rejects.toThrow('active_owner');
      expect(f.sqlite.query('SELECT member_id,revision,previous_role,role,actor_id FROM member_role_audit ORDER BY revision').all()).toEqual([
        { member_id: MEMBER, revision: 1, previous_role: 'member', role: 'admin', actor_id: OWNER },
        { member_id: MEMBER, revision: 2, previous_role: 'admin', role: 'member', actor_id: OWNER },
      ]);
    } finally { f.sqlite.close(); }
  });

  it('refuses non-owner admins and members on both transports before any mutation', async () => {
    const f = await rig();
    try {
      const env = { ...f.env, ...OWNER_ENV };
      for (const [id, sub] of [[ADMIN, '9002'], [MEMBER, '9003']]) {
        const machine = id === ADMIN ? 'machine_2' : 'machine_3';
        f.sqlite.run('INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?,?,?)', [machine, id!, NOW]);
        const issued = await issueMemberToken(f.db, { memberId: id!, machineId: machine }, NOW);
        await expect(transferOwnership(f.db, id!, ADMIN, '1', NOW)).rejects.toThrow('not_owner');
        await expect(changeMemberRole(f.db, id!, MEMBER, 'admin', '0', NOW)).rejects.toThrow('not_owner');
        for (const [dashboard, member, body] of [
          ['/api/ownership/transfer', '/members/ownership/transfer', { member_id: ADMIN, expected_revision: '1' }],
          [`/api/members/${MEMBER}/role`, '/members/roles', { member_id: MEMBER, role: 'admin', expected_revision: '0' }],
        ] as const) {
          const start = f.executed.length;
          expect((await request(f.db, env, sub!, dashboard, body)).status).toBe(403);
          expect(await (await worker.fetch(memberPost(issued.token, body, member), env)).json()).toMatchObject({ persisted: false });
          expect(f.executed.slice(start).filter(sql => /UPDATE members SET role|UPDATE deployment_ownership|INSERT INTO member_role_audit/.test(sql))).toEqual([]);
        }
      }
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM member_role_audit').get()).toEqual({ n: 0 });
      expect(await ownershipPreview(f.db)).toMatchObject({ ownerMemberId: OWNER, revision: '1' });
    } finally { f.sqlite.close(); }
  });

  it('races transfers against revocations without removing the active owner or recoverable admin', async () => {
    const f = await rig();
    try {
      const results = await Promise.allSettled([
        transferOwnership(f.db, OWNER, ADMIN, '1', NOW),
        revokeMember(f.db, ADMIN, OWNER, NOW),
        revokeMember(f.db, OWNER, OWNER, NOW),
      ]);
      expect(results).toHaveLength(3);
      const owner = (await ownershipPreview(f.db)).ownerMemberId;
      expect(f.sqlite.query('SELECT role,revoked_at,github_id IS NOT NULL AS linked FROM members WHERE id=?').get(owner!))
        .toEqual({ role: 'admin', revoked_at: null, linked: 1 });
      expect(f.sqlite.query("SELECT COUNT(*) AS n FROM members WHERE role='admin' AND revoked_at IS NULL AND github_id IS NOT NULL").get()).toMatchObject({ n: expect.any(Number) });
      expect((f.sqlite.query("SELECT COUNT(*) AS n FROM members WHERE role='admin' AND revoked_at IS NULL AND github_id IS NOT NULL").get() as { n: number }).n).toBeGreaterThanOrEqual(1);
    } finally { f.sqlite.close(); }
  });

  it('stopping owner credentials preserves dashboard recovery and never revokes membership', async () => {
    const f = await rig();
    try {
      f.sqlite.run('INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (?,?,?)', ['machine_owner', OWNER, NOW]);
      const token = await issueMemberToken(f.db, { memberId: OWNER, machineId: 'machine_owner' }, NOW);
      expect(await revokeCredentialAsMember(f.db, { id: ADMIN, label: null, role: 'admin' }, token.tokenId, NOW)).toMatchObject({ revoked: false });
      expect(await revokeMachineCredentialsAsMember(f.db, { id: ADMIN, label: null, role: 'admin' }, 'machine_owner', NOW)).toMatchObject({ revoked: 0 });
      expect(await revokeCredentialAsMember(f.db, { id: OWNER, label: null, role: 'admin' }, token.tokenId, NOW)).toMatchObject({ revoked: true });
      expect(await memberByGithubId(f.db, '583231')).toMatchObject({ id: OWNER, role: 'admin' });
      expect(await revokeMember(f.db, OWNER, OWNER, NOW)).toEqual({ ok: false, reason: 'active_owner' });
    } finally { f.sqlite.close(); }
  });

  it('restores transferred ownership, complete role history and owner access without changing raw attribution', async () => {
    const source = await rig();
    const dest = sqliteEnv();
    try {
      await changeMemberRole(source.db, OWNER, MEMBER, 'admin', '0', NOW);
      await transferOwnership(source.db, OWNER, ADMIN, '1', NOW + 1);
      const backup = await createBackup(source.db, source.bucket, { producer: 'owner-lifecycle-test', now: NOW + 2 });
      const text = new TextDecoder().decode(source.bucket.objects.get(backup.key)!.bytes);
      const header = JSON.parse(text.split('\n')[0]!) as { deploymentId: string };
      dest.sqlite.run("UPDATE schema_meta SET value=? WHERE key='deployment_id'", [header.deploymentId]);
      dest.sqlite.run('DELETE FROM members');
      await restoreArtifact(dest.db, { authorization: { kind: 'recovery' }, text });
      expect(await ownershipPreview(dest.db)).toMatchObject({ ownerMemberId: ADMIN, revision: '2' });
      expect(await memberByGithubId(dest.db, '9002')).toMatchObject({ id: ADMIN, role: 'admin' });
      expect(dest.sqlite.query('SELECT * FROM deployment_ownership_audit ORDER BY revision').all()).toEqual(source.sqlite.query('SELECT * FROM deployment_ownership_audit ORDER BY revision').all());
      expect(dest.sqlite.query('SELECT * FROM member_role_audit ORDER BY revision').all()).toEqual(source.sqlite.query('SELECT * FROM member_role_audit ORDER BY revision').all());
    } finally { source.sqlite.close(); dest.sqlite.close(); }
  });

  it('keeps future restored audit receipts from replacing the next local authority receipts', async () => {
    const f = await rig();
    try {
      await changeMemberRole(f.db, OWNER, MEMBER, 'admin', '0', NOW);
      const lineage = (await f.db.prepare("SELECT value FROM schema_meta WHERE key='deployment_id'").first<{ value: string }>())!.value;
      const artifact = (rows: Array<{ t: string; r: Record<string, unknown> }>) => [
        { format: BACKUP_FORMAT, deploymentId: lineage, schemaVersion: 73, createdAt: NOW, producer: 'audit-collision', counts: {} },
        ...rows,
      ].map(row => JSON.stringify(row)).join('\n');
      await restoreArtifact(f.db, { authorization: { kind: 'recovery' }, text: artifact([
        { t: 'deployment_ownership', r: { id: 1, member_id: ADMIN, revision: 2, bootstrap_mode: 'selection' } },
        { t: 'deployment_ownership_audit', r: { revision: 2, member_id: ADMIN, actor_id: OWNER,
          previous_member_id: OWNER, operation: 'transfer', created_at: NOW } },
      ]) });
      expect(f.sqlite.query('SELECT revision,member_id FROM deployment_ownership_audit ORDER BY revision').all())
        .toEqual([{ revision: 1, member_id: OWNER }]);
      await transferOwnership(f.db, OWNER, ADMIN, '1', NOW + 1);
      expect(f.sqlite.query('SELECT revision,member_id,actor_id FROM deployment_ownership_audit ORDER BY revision').all())
        .toEqual([{ revision: 1, member_id: OWNER, actor_id: OWNER }, { revision: 2, member_id: ADMIN, actor_id: OWNER }]);

      await restoreArtifact(f.db, { authorization: { kind: 'recovery' }, text: artifact([
        { t: 'members', r: { id: MEMBER, role: 'member', role_revision: 2, github_id: '9003', created_at: NOW } },
        { t: 'member_role_audit', r: { member_id: MEMBER, revision: 2, previous_role: 'admin',
          role: 'member', actor_id: OWNER, created_at: NOW } },
      ]) });
      expect(f.sqlite.query('SELECT revision,role FROM member_role_audit WHERE member_id=? ORDER BY revision').all(MEMBER))
        .toEqual([{ revision: 1, role: 'admin' }]);
      await changeMemberRole(f.db, ADMIN, MEMBER, 'member', '1', NOW + 2);
      expect(f.sqlite.query('SELECT revision,role,actor_id FROM member_role_audit WHERE member_id=? ORDER BY revision').all(MEMBER))
        .toEqual([{ revision: 1, role: 'admin', actor_id: OWNER }, { revision: 2, role: 'member', actor_id: ADMIN }]);
    } finally { f.sqlite.close(); }
  });
});

describe('owner bootstrap and migration gates', () => {
  it.each([
    { name: 'solo linked admin', rows: [[OWNER, 'admin', '583231', null]], proposal: OWNER },
    { name: 'multiple linked admins', rows: [[OWNER, 'admin', '583231', null], [ADMIN, 'admin', '9002', null]], proposal: null },
    { name: 'revoked linked admin', rows: [[OWNER, 'admin', '583231', 1]], proposal: null },
    { name: 'missing linked account', rows: [[OWNER, 'admin', null, null]], proposal: null },
    { name: 'linked plain member', rows: [[OWNER, 'member', '583231', null]], proposal: null },
  ])('$name migration preserves exact rights and proposes without choosing', async ({ rows, proposal }) => {
    const sqlite = new Database(':memory:');
    try {
      for (const step of SCHEMA_STEPS.filter(s => s.version < 73)) for (const sql of step.statements) sqlite.exec(sql);
      for (const [id, role, github, revoked] of rows) sqlite.run('INSERT INTO members (id,role,github_id,revoked_at,created_at) VALUES (?,?,?,?,0)', [id!, role!, github!, revoked!]);
      const before = sqlite.query('SELECT id,role,github_id,revoked_at FROM members ORDER BY id').all();
      for (const sql of SCHEMA_STEPS.find(s => s.version === 73)!.statements) sqlite.exec(sql);
      const db = sqliteRelationalStore(sqlite);
      expect(sqlite.query('SELECT id,role,github_id,revoked_at FROM members ORDER BY id').all()).toEqual(before);
      expect(await ownershipPreview(db)).toMatchObject({ ownerMemberId: null, revision: '0', proposalMemberId: proposal });
      expect(sqlite.query('SELECT bootstrap_mode FROM deployment_ownership').get()).toEqual({ bootstrap_mode: 'selection' });
      await expect(changeMemberRole(db, OWNER, OWNER, 'admin', '0', NOW)).rejects.toThrow('owner_pending');
    } finally { sqlite.close(); }
  });

  it('fresh link completion atomically records the owner and audit, while an existing unlinked store only proposes', async () => {
    for (const fresh of [true, false]) {
      const sqlite = new Database(':memory:');
      try {
        const seed = () => sqlite.run('INSERT INTO members (id,role,created_at) VALUES (?,\'admin\',0)', [OWNER]);
        for (const step of SCHEMA_STEPS.filter(s => s.version < 73)) for (const sql of step.statements) sqlite.exec(sql);
        if (!fresh) seed();
        for (const sql of SCHEMA_STEPS.find(s => s.version === 73)!.statements) sqlite.exec(sql);
        if (fresh) seed();
        const db = sqliteRelationalStore(sqlite);
        const key = (await issueIdentityLinkAuthority(db, OWNER, NOW))!;
        expect(await spendIdentityLinkAuthority(db, key.key, '583231', NOW + 1)).toMatchObject({ ok: true });
        expect(await ownershipPreview(db)).toMatchObject({ ownerMemberId: fresh ? OWNER : null, revision: fresh ? '1' : '0', proposalMemberId: fresh ? null : OWNER });
        expect(sqlite.query('SELECT COUNT(*) AS n FROM deployment_ownership_audit').get()).toEqual({ n: fresh ? 1 : 0 });
      } finally { sqlite.close(); }
    }
  });

  it('capture never chooses or promotes an owner', async () => {
    const f = sqliteEnv();
    try {
      const token = await issueMemberToken(f.db, { memberId: OWNER, machineId: 'machine_1' }, NOW);
      const before = f.sqlite.query('SELECT id,role,role_revision FROM members ORDER BY id').all();
      expect(await (await worker.fetch(memberPost(token.token, envelope()), f.env)).json()).toMatchObject({ persisted: true });
      expect(await ownershipPreview(f.db)).toMatchObject({ ownerMemberId: null, revision: '0' });
      expect(f.sqlite.query('SELECT id,role,role_revision FROM members ORDER BY id').all()).toEqual(before);
    } finally { f.sqlite.close(); }
  });

  it('fresh link rolls back the identity and owner if the ownership receipt fails', async () => {
    const sqlite = new Database(':memory:');
    try {
      for (const step of SCHEMA_STEPS) for (const sql of step.statements) sqlite.exec(sql);
      sqlite.run("INSERT INTO members (id,role,created_at) VALUES (?,'admin',0)", [OWNER]);
      sqlite.run("CREATE TRIGGER refuse_first_owner BEFORE INSERT ON deployment_ownership_audit BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
      const db = sqliteRelationalStore(sqlite);
      const key = (await issueIdentityLinkAuthority(db, OWNER, NOW))!;
      await expect(spendIdentityLinkAuthority(db, key.key, '583231', NOW)).rejects.toThrow('receipt failure');
      expect(sqlite.query('SELECT github_id FROM members WHERE id=?').get(OWNER)).toEqual({ github_id: null });
      expect(await ownershipPreview(db)).toMatchObject({ ownerMemberId: null, revision: '0' });
    } finally { sqlite.close(); }
  });

  it('an interrupted legacy membership restore keeps link completion pending explicit owner selection', async () => {
    const sqlite = new Database(':memory:');
    try {
      for (const step of SCHEMA_STEPS) for (const sql of step.statements) sqlite.exec(sql);
      sqlite.run("CREATE TRIGGER fail_restored_claim BEFORE INSERT ON machine_claims BEGIN SELECT RAISE(ABORT,'restore interrupted'); END");
      const db = sqliteRelationalStore(sqlite);
      const lineage = (await db.prepare("SELECT value FROM schema_meta WHERE key='deployment_id'").first<{ value: string }>())!.value;
      const artifact = [
        { format: BACKUP_FORMAT, deploymentId: lineage, schemaVersion: 72, createdAt: NOW, producer: 'legacy', counts: { members: 1, machine_claims: 1 } },
        { t: 'members', r: { id: OWNER, role: 'admin', github_id: null, created_at: NOW } },
        { t: 'machine_claims', r: { machine_id: 'machine_legacy', member_id: OWNER, claimed_at: NOW } },
      ].map(row => JSON.stringify(row)).join('\n');
      await expect(restoreArtifact(db, { authorization: { kind: 'recovery' }, text: artifact })).rejects.toThrow('restore interrupted');
      expect(sqlite.query('SELECT bootstrap_mode FROM deployment_ownership').get()).toEqual({ bootstrap_mode: 'selection' });
      const key = (await issueIdentityLinkAuthority(db, OWNER, NOW))!;
      expect(await spendIdentityLinkAuthority(db, key.key, '583231', NOW)).toMatchObject({ ok: true });
      expect(await ownershipPreview(db)).toMatchObject({ ownerMemberId: null, proposalMemberId: OWNER });
    } finally { sqlite.close(); }
  });
});
