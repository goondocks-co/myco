import { expect } from 'bun:test';
import { MACHINE_ID, MEMBER_ID, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { accountSession, browser, credentials, linkAccount, memberView, members, person, selectOwner, type Person } from '../clients/identity.ts';

interface OwnershipPreview {
  ownerMemberId: string | null;
  revision: string;
  candidates: Array<{ memberId: string; label: string | null; role: 'admin' | 'member'; roleRevision: string }>;
  proposalMemberId: string | null;
}

async function ownership(target: ParityTarget, session: Record<string, string>): Promise<OwnershipPreview> {
  const response = await browser(target, '/api/ownership', session);
  expect(response.status).toBe(200);
  return response.body as OwnershipPreview;
}

/** Who owns the Deployment at which revision, and each named member's role, as the ownership read and the People page show them. */
async function standing(target: ParityTarget, ids: string[]): Promise<Record<string, unknown>> {
  const { ownerMemberId, revision } = await ownership(target, target.ownerHeaders());
  const roles = (await members(target)).filter((row) => ids.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, role, roleRevision, revokedAt }) => ({ id, role, roleRevision, revokedAt }));
  return { ownerMemberId, revision, roles };
}

/** A restore artifact carrying `rows`, headed as the Deployment's own backups are. */
async function restoreArtifact(target: ParityTarget, rows: Array<{ t: string; r: Record<string, unknown> }>): Promise<string> {
  const backup = await browser(target, '/api/backups', target.ownerHeaders(), {});
  expect(backup.status).toBe(200);
  const download = await fetch(`${target.url}/api/backups/${backup.body.backup.id}/artifact`, { headers: { ...target.ownerHeaders(), origin: target.url } });
  expect(download.status).toBe(200);
  const header = JSON.parse((await download.text()).split('\n')[0]!) as Record<string, unknown>;
  const counts = Object.fromEntries([...new Set(rows.map((row) => row.t))].map((table) => [table, rows.filter((row) => row.t === table).length]));
  return [{ ...header, producer: 'parity', counts }, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** Exercises ownership and role transitions through both dashboard sessions and member credentials. */
export const ownerLifecycle: ParityScenario = {
  name: 'owner lifecycle: explicit owner selection, atomic transfer, role CAS, protected owner and credential Stop',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    const owner = target.ownerHeaders();
    const ownerCredential = memberHeadersFor(target.memberToken, target.projectId);
    const proposed = await ownership(target, owner);
    expect({ ownerMemberId: proposed.ownerMemberId, proposalMemberId: proposed.proposalMemberId, candidates: proposed.candidates })
      .toEqual({ ownerMemberId: null, proposalMemberId: MEMBER_ID,
        candidates: [{ memberId: MEMBER_ID, label: target.name === 'cloudflare' ? MEMBER_ID : 'parity', role: 'admin', roleRevision: '0' }] });
    expect((await browser(target, '/members/ownership', ownerCredential)).body).toMatchObject({ persisted: true, ownerMemberId: null, revision: proposed.revision });

    // Before an owner is selected, the sole admin is neither removed nor moved, on either transport.
    const beforeBootstrap = await standing(target, [MEMBER_ID]);
    const soleAdminRevocation = await browser(target, `/api/members/${MEMBER_ID}/revoke`, owner, {});
    expect({ status: soleAdminRevocation.status, body: soleAdminRevocation.body }).toEqual({ status: 409, body: { error: 'owner_pending' } });
    for (const [path, headers, body] of [
      ['/api/ownership/transfer', owner, { member_id: MEMBER_ID, expected_revision: proposed.revision }],
      ['/members/ownership/transfer', ownerCredential, { member_id: MEMBER_ID, expected_revision: proposed.revision }],
      [`/api/members/${MEMBER_ID}/role`, owner, { role: 'member', expected_revision: '0' }],
      ['/members/roles', ownerCredential, { member_id: MEMBER_ID, role: 'member', expected_revision: '0' }],
    ] as const) {
      const refused = await browser(target, path, headers, body);
      expect({ path, status: refused.status, body: refused.body }).toEqual(path.startsWith('/members/')
        ? { path, status: 200, body: { persisted: false, code: 'owner_pending', reason: 'owner_pending' } }
        : { path, status: 409, body: { error: 'owner_pending' } });
    }
    expect(await standing(target, [MEMBER_ID])).toEqual(beforeBootstrap);

    const selected = await browser(target, '/api/ownership', owner, { ownerMemberId: MEMBER_ID, revision: proposed.revision });
    expect({ status: selected.status, owner: selected.body.ownerMemberId, revision: selected.body.revision }).toEqual({ status: 200, owner: MEMBER_ID, revision: '1' });
    const adminA = await person(target, '720001', { role: 'admin', login: 'admin-a' });
    const adminB = await person(target, '720002', { role: 'admin', login: 'admin-b' });
    const member = await person(target, '720003', { login: 'member' });
    const ids = [MEMBER_ID, adminA.id, adminB.id, member.id];
    const afterBootstrap = await standing(target, ids);

    // A non-owner admin and a member move neither ownership nor roles.
    for (const actor of [adminA, member]) {
      expect((await browser(target, '/api/ownership/transfer', actor.session, { member_id: adminB.id, expected_revision: '1' })).status).toBe(403);
      expect((await browser(target, '/members/roles', memberHeadersFor(actor.token, target.projectId), { member_id: member.id, role: 'admin', expected_revision: '0' })).body)
        .toMatchObject({ persisted: false });
    }
    expect(await standing(target, ids)).toEqual(afterBootstrap);

    // Two transfers at one revision: exactly one moves ownership.
    const transfer = (candidate: Person) => browser(target, '/api/ownership/transfer', owner, { member_id: candidate.id, expected_revision: '1' });
    const [first, second] = await Promise.all([transfer(adminA), transfer(adminB)]);
    expect([first.status, second.status].filter((status) => status === 200)).toHaveLength(1);
    expect([first.status, second.status].filter((status) => status === 403 || status === 409)).toHaveLength(1);
    const winner = first.status === 200 ? adminA : adminB;
    const loser = first.status === 200 ? adminB : adminA;
    const moved = await ownership(target, winner.session);
    expect({ owner: moved.ownerMemberId, revision: moved.revision }).toEqual({ owner: winner.id, revision: '2' });
    const afterTransfer = await standing(target, ids);
    const staleTransfer = await browser(target, '/api/ownership/transfer', winner.session, { member_id: loser.id, expected_revision: '1' });
    expect({ status: staleTransfer.status, body: staleTransfer.body }).toEqual({ status: 409, body: { error: 'revision_conflict' } });
    expect(await standing(target, ids)).toEqual(afterTransfer);
    expect((await browser(target, '/auth/me', owner)).body.owner).toBe(false);
    expect((await memberView(target, MEMBER_ID))?.role).toBe('admin');
    expect((await browser(target, '/api/ownership/transfer', owner, { member_id: loser.id, expected_revision: moved.revision })).status).toBe(403);

    // Roles change under their revision; a stale revision changes nothing.
    const roleRevision = (await memberView(target, member.id))!.roleRevision;
    expect((await browser(target, `/api/members/${member.id}/role`, winner.session, { role: 'admin', expected_revision: roleRevision })).status).toBe(200);
    const promoted = (await memberView(target, member.id))!;
    expect({ role: promoted.role, advanced: promoted.roleRevision !== roleRevision }).toEqual({ role: 'admin', advanced: true });
    const winnerCredential = memberHeadersFor(winner.token, target.projectId);
    expect((await browser(target, '/members/roles', winnerCredential, { member_id: member.id, role: 'member', expected_revision: roleRevision })).body)
      .toMatchObject({ persisted: false, code: 'revision_conflict' });
    expect((await memberView(target, member.id))?.role).toBe('admin');
    expect((await browser(target, '/members/roles', winnerCredential, { member_id: member.id, role: 'member', expected_revision: promoted.roleRevision })).body).toMatchObject({ persisted: true });
    expect((await memberView(target, member.id))?.role).toBe('member');

    // The owner is protected from its own demotion and removal.
    const ownerRole = (await memberView(target, winner.id))!.roleRevision;
    expect((await browser(target, `/api/members/${winner.id}/role`, winner.session, { role: 'member', expected_revision: ownerRole })).status).toBe(409);
    expect((await browser(target, `/api/members/${winner.id}/revoke`, winner.session, {})).status).toBe(409);
    expect(await memberView(target, winner.id)).toMatchObject({ role: 'admin', revokedAt: null });

    // A backup carries ownership and both audits; restoring it into the same Deployment changes no authority.
    const backup = await browser(target, '/api/backups', winner.session, {});
    expect(backup.status).toBe(200);
    const backupId = (backup.body as { backup: { id: string } }).backup.id;
    const artifact = await fetch(`${target.url}/api/backups/${backupId}/artifact`, { headers: { ...winner.session, origin: target.url } });
    expect(artifact.status).toBe(200);
    const records = (await artifact.text()).trim().split('\n').slice(1).map((line) => JSON.parse(line) as { t: string; r: Record<string, unknown> });
    expect(records.filter((record) => record.t === 'deployment_ownership').map((record) => record.r.member_id)).toEqual([winner.id]);
    expect(records.filter((record) => record.t === 'deployment_ownership_audit').map((record) => record.r.revision)).toEqual([1, 2]);
    expect(records.filter((record) => record.t === 'member_role_audit' && record.r.member_id === member.id).map((record) => record.r.revision)).toEqual([1, 2]);
    const beforeRestore = await standing(target, ids);
    expect((await browser(target, `/api/backups/${backupId}/restore`, winner.session, {})).status).toBe(200);
    expect(await standing(target, ids)).toEqual(beforeRestore);

    const returned = await browser(target, '/members/ownership/transfer', winnerCredential, { member_id: MEMBER_ID, expected_revision: moved.revision });
    expect(returned.body).toMatchObject({ persisted: true, ownerMemberId: MEMBER_ID, revision: '3' });

    // Stopping the owner's machine credential: another admin cannot, the owner can, and the owner stays signed in.
    const ownerToken = (await credentials(target)).find((row) => row.memberId === MEMBER_ID && row.machineId === MACHINE_ID && row.live)!;
    expect((await browser(target, `/api/credentials/${ownerToken.id}/revoke`, winner.session, {})).body.revoked).toBe(false);
    expect((await credentials(target)).find((row) => row.id === ownerToken.id)?.revokedAt).toBeNull();
    const stopped = await browser(target, `/api/credentials/${ownerToken.id}/revoke`, owner, {});
    expect({ status: stopped.status, revoked: stopped.body.revoked }).toEqual({ status: 200, revoked: true });
    expect((await credentials(target)).find((row) => row.id === ownerToken.id)?.revokedAt).not.toBeNull();
    expect((await browser(target, '/auth/me', owner)).body.member.id).toBe(MEMBER_ID);
    expect((await browser(target, '/api/ownership', owner)).status).toBe(200);
  },
};

/** An authority restore waits for an owner; once one is selected, a restored administrator is linked and takes ownership. */
export const interruptedRestoreOwner: ParityScenario = {
  name: 'owner lifecycle: a restored administrator waits for owner selection, then links and takes ownership',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    const restoredId = 'mem_owner_parity_restored';
    const now = Date.now();
    const artifact = await restoreArtifact(target, [
      { t: 'members', r: { id: restoredId, label: 'restored admin', role: 'admin', role_revision: 0, created_at: now } },
      { t: 'machine_claims', r: { machine_id: 'machine_owner_parity_restored', member_id: restoredId, claimed_at: now } },
    ]);
    const ownerless = await browser(target, '/api/backups/restore-upload', target.ownerHeaders(), { artifact });
    expect({ status: ownerless.status, body: ownerless.body }).toEqual({ status: 409, body: { error: 'owner_pending' } });
    expect(await memberView(target, restoredId)).toBeUndefined();
    expect(await selectOwner(target)).toBe('1');
    expect((await browser(target, '/api/backups/restore-upload', target.ownerHeaders(), { artifact })).status).toBe(200);
    expect(await memberView(target, restoredId)).toMatchObject({ role: 'admin', linked: false });

    const restored = await linkAccount(target, restoredId, '720004', target.ownerHeaders(), 'restored');
    const pending = await ownership(target, restored);
    expect({ owner: pending.ownerMemberId, revision: pending.revision, proposal: pending.proposalMemberId }).toEqual({ owner: MEMBER_ID, revision: '1', proposal: null });
    const transferred = await browser(target, '/api/ownership/transfer', target.ownerHeaders(), { member_id: restoredId, expected_revision: pending.revision });
    expect({ status: transferred.status, owner: transferred.body.ownerMemberId }).toEqual({ status: 200, owner: restoredId });
    expect((await browser(target, '/auth/me', await accountSession(target, '720004', 'restored'))).body.owner).toBe(true);
  },
};
