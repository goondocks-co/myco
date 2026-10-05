import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { MEMBER_ID, SESSION_SECRET, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const ADMIN = 'mem_review_parity_admin';
const MEMBER = 'mem_review_parity_member';
const RESTORED_MEMBER = 'mem_review_parity_restored';
const RESTORED_PROJECT = 'proj_review_parity_restored';
const RESTORED_MACHINE = 'machine_review_parity_restored';
const RESTORED_CREDENTIAL = 'mt_review_parity_restored';
const RESTORED_INVITATION = 'inv_review_parity_restored';
const RESTORED_LINK = 'link_review_parity_restored';

function post(target: ParityTarget, path: string, headers: Record<string, string>, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${target.url}${path}`, {
    method: 'POST', headers: { ...headers, origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function session(sub: string): Promise<Record<string, string>> {
  const now = Date.now();
  const cookie = await signSession(SESSION_SECRET, { sub, login: `review-${sub}`, iat: now, exp: now + 3_600_000 });
  return { cookie: `${SESSION_COOKIE}=${cookie}`, 'cf-connecting-ip': '1.2.3.4' };
}

async function selectOwner(target: ParityTarget): Promise<void> {
  await target.sql("UPDATE deployment_ownership SET bootstrap_mode = 'selection' WHERE id = 1");
  const preview = await fetch(`${target.url}/api/ownership`, { headers: target.ownerHeaders() });
  expect(preview.status).toBe(200);
  const revision = (await preview.json() as { revision: string }).revision;
  const selected = await post(target, '/api/ownership', target.ownerHeaders(), { ownerMemberId: MEMBER_ID, revision });
  expect(selected.status).toBe(200);
}

const RESTORE_CHECKS = [
  ['projects', 'project_id', RESTORED_PROJECT],
  ['members', 'id', RESTORED_MEMBER],
  ['enrollment_authorities', 'id', RESTORED_INVITATION],
  ['identity_link_authorities', 'id', RESTORED_LINK],
  ['machine_claims', 'machine_id', RESTORED_MACHINE],
  ['member_credentials', 'id', RESTORED_CREDENTIAL],
  ['member_role_audit', 'member_id', RESTORED_MEMBER],
] as const;

async function restoreSnapshot(target: ParityTarget): Promise<Record<string, unknown>> {
  const counts = RESTORE_CHECKS.map(([table, column, key]) =>
    `(SELECT COUNT(*) FROM ${table} WHERE ${column} = ${lit(key)}) AS ${table}`);
  const [snapshot] = await target.sql(`SELECT ${counts.join(', ')},
    (SELECT member_id FROM deployment_ownership WHERE id = 1) AS owner,
    (SELECT revision FROM deployment_ownership WHERE id = 1) AS ownerRevision,
    (SELECT bootstrap_mode FROM deployment_ownership WHERE id = 1) AS bootstrapMode,
    (SELECT COUNT(*) FROM deployment_ownership_audit) AS ownershipAudit,
    (SELECT COUNT(*) FROM raw_restore_revisions) AS rawRestore,
    (SELECT COUNT(*) FROM backup_restore_progress) AS restoreProgress`);
  if (snapshot === undefined) throw new Error('restore snapshot query returned no row');
  return snapshot;
}

/** A stored backup and its downloaded artifact take the same owner admission before the first imported row. */
export const restoreAuthorityAdmission: ParityScenario = {
  name: 'owner review: stored and uploaded authority restore admit the live owner before any write',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    await selectOwner(target);
    const adminHeaders = await session('720711');
    const memberHeaders = await session('720712');
    const now = Date.now();
    await target.sql(`INSERT INTO members (id,label,role,github_id,created_at) VALUES (${lit(ADMIN)},'review admin','admin','720711',${now})`);
    await target.sql(`INSERT INTO members (id,label,role,github_id,created_at) VALUES (${lit(MEMBER)},'review member','member','720712',${now})`);
    await target.sql(`INSERT INTO projects (project_id,name,created_at) VALUES (${lit(RESTORED_PROJECT)},'restore guard',${now})`);
    await target.sql(`INSERT INTO members (id,label,role,role_revision,github_id,created_at)
      VALUES (${lit(RESTORED_MEMBER)},'restored admin','admin',1,'720713',${now})`);
    await target.sql(`INSERT INTO enrollment_authorities
      (id,key_hash,created_at,expires_at,created_by_member,member_id,role)
      VALUES (${lit(RESTORED_INVITATION)},${lit('a'.repeat(64))},${now},${now + 3_600_000},${lit(MEMBER_ID)},${lit(RESTORED_MEMBER)},'admin')`);
    await target.sql(`INSERT INTO identity_link_authorities (id,key_hash,member_id,created_at,expires_at)
      VALUES (${lit(RESTORED_LINK)},${lit('b'.repeat(64))},${lit(RESTORED_MEMBER)},${now},${now + 3_600_000})`);
    await target.sql(`INSERT INTO machine_claims (machine_id,member_id,claimed_at)
      VALUES (${lit(RESTORED_MACHINE)},${lit(RESTORED_MEMBER)},${now})`);
    await target.sql(`INSERT INTO member_credentials
      (id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES (${lit(RESTORED_CREDENTIAL)},${lit(RESTORED_MEMBER)},${lit(RESTORED_MACHINE)},${lit('c'.repeat(64))},${now},${now + 3_600_000},${lit(RESTORED_CREDENTIAL)},${now})`);
    await target.sql(`INSERT INTO member_role_audit
      (member_id,revision,previous_role,role,actor_id,created_at)
      VALUES (${lit(RESTORED_MEMBER)},1,'member','admin',${lit(MEMBER_ID)},${now})`);

    const created = await post(target, '/api/backups', adminHeaders);
    expect(created.status).toBe(200);
    const backupId = (await created.json() as { backup: { id: string } }).backup.id;
    const list = await fetch(`${target.url}/api/backups`, { headers: adminHeaders });
    expect(list.status).toBe(200);
    expect((await list.json() as { backups: Array<{ id: string }> }).backups.some(row => row.id === backupId)).toBe(true);
    const download = await fetch(`${target.url}/api/backups/${backupId}/artifact`, { headers: adminHeaders });
    expect(download.status).toBe(200);
    const artifact = await download.text();
    expect(artifact).toContain(`"t":"${'members'}"`);
    const preview = await post(target, `/api/backups/${backupId}/restore-preview`, adminHeaders);
    expect(preview.status).toBe(200);

    await target.sql(`DELETE FROM member_role_audit WHERE member_id = ${lit(RESTORED_MEMBER)}`);
    await target.sql(`DELETE FROM member_credentials WHERE id = ${lit(RESTORED_CREDENTIAL)}`);
    await target.sql(`DELETE FROM identity_link_authorities WHERE id = ${lit(RESTORED_LINK)}`);
    await target.sql(`DELETE FROM enrollment_authorities WHERE id = ${lit(RESTORED_INVITATION)}`);
    await target.sql(`DELETE FROM machine_claims WHERE machine_id = ${lit(RESTORED_MACHINE)}`);
    await target.sql(`DELETE FROM members WHERE id = ${lit(RESTORED_MEMBER)}`);
    await target.sql(`DELETE FROM projects WHERE project_id = ${lit(RESTORED_PROJECT)}`);
    const before = await restoreSnapshot(target);
    for (const [path, headers, body] of [
      [`/api/backups/${backupId}/restore`, adminHeaders, {}],
      ['/api/backups/restore-upload', adminHeaders, { artifact }],
      [`/api/backups/${backupId}/restore`, memberHeaders, {}],
      ['/api/backups/restore-upload', memberHeaders, { artifact }],
    ] as const) {
      const denied = await post(target, path, headers, body);
      expect(denied.status).toBe(403);
      expect(await restoreSnapshot(target)).toEqual(before);
    }

    const recovered = await post(target, `/api/backups/${backupId}/restore`, target.ownerHeaders());
    expect(recovered.status).toBe(200);
    expect((await recovered.json() as { applied: boolean }).applied).toBe(true);
    const after = await restoreSnapshot(target);
    for (const [table] of RESTORE_CHECKS) expect(after[table]).toBe(1);
    expect(after.owner).toBe(before.owner);
    expect(after.ownerRevision).toBe(before.ownerRevision);
    expect(after.bootstrapMode).toBe(before.bootstrapMode);
    expect(after.ownershipAudit).toBe(before.ownershipAudit);
  },
};

/** The actor is demoted by the real target store immediately before each credential UPDATE executes. */
export const stopAfterDemotion: ParityScenario = {
  name: 'owner review: live actor scope gates credential and machine Stop after demotion',
  dedicated: { cloudflare: { main: '../../tests/parity/owner-review/worker-entry.ts' }, stopRace: true, timeoutMs: 240_000 },
  async run(target) {
    await selectOwner(target);
    const now = Date.now();
    await target.sql(`INSERT INTO members (id,label,role,github_id,created_at) VALUES (${lit(ADMIN)},'review admin','admin','720711',${now})`);
    await target.sql(`INSERT INTO members (id,label,role,github_id,created_at) VALUES (${lit(MEMBER)},'review member','member','720712',${now})`);
    const adminHeaders = await session('720711');
    const memberHeaders = await session('720712');
    const credential = async (name: string, memberId = MEMBER): Promise<{ id: string; machineId: string }> => {
      const id = `mt_review_${name}`;
      const machineId = `machine_review_${name}`;
      await target.sql(`INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (${lit(machineId)},${lit(memberId)},${now})`);
      await target.sql(`INSERT INTO member_credentials
        (id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
        VALUES (${lit(id)},${lit(memberId)},${lit(machineId)},${lit(crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'))},${now},${now + 3_600_000},${lit(id)},${now})`);
      return { id, machineId };
    };
    const revokedAt = async (id: string) => await target.sql(`SELECT revoked_at FROM member_credentials WHERE id = ${lit(id)}`);
    const stopCredential = (id: string, headers: Record<string, string>) => post(target, `/api/credentials/${id}/revoke`, headers);
    const stopMachine = (machineId: string, headers: Record<string, string>) => post(target, `/api/machines/${machineId}/stop`, headers);

    for (const [headers, kind] of [[target.ownerHeaders(), 'owner'], [adminHeaders, 'admin'], [memberHeaders, 'member']] as const) {
      const one = await credential(`${kind}_credential`);
      const stopped = await stopCredential(one.id, headers);
      expect(stopped.status).toBe(200);
      expect((await stopped.json() as { revoked: boolean }).revoked).toBe(true);
      expect((await revokedAt(one.id))[0]?.revoked_at).not.toBeNull();
      const two = await credential(`${kind}_machine`);
      const stoppedMachine = await stopMachine(two.machineId, headers);
      expect(stoppedMachine.status).toBe(200);
      expect((await stoppedMachine.json() as { revoked: number }).revoked).toBe(1);
      expect((await revokedAt(two.id))[0]?.revoked_at).not.toBeNull();
    }

    const adminOwn = await credential('admin_own', ADMIN);
    const memberForeign = await stopCredential(adminOwn.id, memberHeaders);
    expect(memberForeign.status).toBe(200);
    expect((await memberForeign.json() as { revoked: boolean }).revoked).toBe(false);
    expect((await stopMachine(adminOwn.machineId, memberHeaders)).status).toBe(404);
    expect(await revokedAt(adminOwn.id)).toEqual([{ revoked_at: null }]);

    for (const kind of ['credential', 'machine'] as const) {
      const foreign = await credential(`race_${kind}`);
      const armed = await post(target, '/__parity/stop-race/arm', {}, { memberId: ADMIN });
      expect(armed.status).toBe(200);
      const stopped = kind === 'credential' ? await stopCredential(foreign.id, adminHeaders) : await stopMachine(foreign.machineId, adminHeaders);
      expect(stopped.status).toBe(200);
      const answer = await stopped.json() as { revoked: boolean | number };
      expect(answer.revoked).toBe(kind === 'credential' ? false : 0);
      expect(await revokedAt(foreign.id)).toEqual([{ revoked_at: null }]);
      const status = await fetch(`${target.url}/__parity/stop-race/status`);
      expect(await status.json() as { fired: boolean; armed: boolean }).toEqual({ fired: true, armed: false });
      expect(await target.sql(`SELECT role FROM members WHERE id = ${lit(ADMIN)}`)).toEqual([{ role: 'member' }]);
      if (kind === 'credential') {
        await target.sql(`UPDATE members SET role = 'admin', role_revision = role_revision + 1 WHERE id = ${lit(ADMIN)}`);
      }
    }

    const afterRevoke = await credential('revoked_actor_foreign');
    await target.sql(`UPDATE members SET revoked_at = ${Date.now()} WHERE id = ${lit(ADMIN)}`);
    const refused = await stopCredential(afterRevoke.id, adminHeaders);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await revokedAt(afterRevoke.id)).toEqual([{ revoked_at: null }]);
  },
};
