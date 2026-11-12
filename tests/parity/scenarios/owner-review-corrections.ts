import { expect } from 'bun:test';
import { type ParityScenario } from '../harness.ts';
import { assignRole, browser, credentials, deviceMachine, memberView, person, selectOwner, stopMember } from '../clients/identity.ts';

/**
 * The actor is demoted by the real target store immediately before the credential UPDATE executes. One representative
 * race: the same demotion before a machine Stop, and a revoked admin's Stop, are covered by `owner-review-probe.test.ts`.
 */
export const stopAfterDemotion: ParityScenario = {
  name: 'owner review: live actor scope gates credential and machine Stop after demotion',
  dedicated: { cloudflare: { main: '../../tests/parity/owner-review/worker-entry.ts' }, stopRace: true, timeoutMs: 240_000 },
  async run(target) {
    await selectOwner(target);
    const admin = await person(target, '720711', { role: 'admin', login: 'review-admin' });
    const member = await person(target, '720712', { login: 'review-member' });
    // A machine of the member's, or of the admin's, signed in through the device flow and approved in their browser.
    const machineOf = (session: Record<string, string>) => deviceMachine(target, session);
    const revokedAt = async (id: string) => (await credentials(target)).find((row) => row.id === id)?.revokedAt ?? null;
    const stopCredential = (id: string, session: Record<string, string>) => browser(target, `/api/credentials/${id}/revoke`, session, {});
    const stopMachine = (machineId: string, session: Record<string, string>) => browser(target, `/api/machines/${machineId}/stop`, session, {});

    for (const session of [target.ownerHeaders(), admin.session, member.session]) {
      const one = await machineOf(member.session);
      const stopped = await stopCredential(one.tokenId, session);
      expect({ status: stopped.status, revoked: stopped.body.revoked }).toEqual({ status: 200, revoked: true });
      expect(await revokedAt(one.tokenId)).not.toBeNull();
      const two = await machineOf(member.session);
      const stoppedMachine = await stopMachine(two.machineId, session);
      expect({ status: stoppedMachine.status, revoked: stoppedMachine.body.revoked }).toEqual({ status: 200, revoked: 1 });
      expect(await revokedAt(two.tokenId)).not.toBeNull();
    }

    const adminOwn = await machineOf(admin.session);
    const memberForeign = await stopCredential(adminOwn.tokenId, member.session);
    expect({ status: memberForeign.status, revoked: memberForeign.body.revoked }).toEqual({ status: 200, revoked: false });
    expect((await stopMachine(adminOwn.machineId, member.session)).status).toBe(404);
    expect(await revokedAt(adminOwn.tokenId)).toBeNull();

    const foreign = await machineOf(member.session);
    expect((await browser(target, '/__parity/stop-race/arm', {}, { memberId: admin.id })).status).toBe(200);
    const raced = await stopCredential(foreign.tokenId, admin.session);
    expect({ status: raced.status, revoked: raced.body.revoked }).toEqual({ status: 200, revoked: false });
    expect(await revokedAt(foreign.tokenId)).toBeNull();
    expect((await browser(target, '/__parity/stop-race/status', {})).body).toEqual({ fired: true, armed: false });
    expect((await memberView(target, admin.id))?.role).toBe('member');
    expect((await assignRole(target, admin.id, 'admin')).status).toBe(200);

    const afterRevoke = await machineOf(member.session);
    await stopMember(target, admin.id);
    expect((await stopCredential(afterRevoke.tokenId, admin.session)).status).toBeGreaterThanOrEqual(400);
    expect(await revokedAt(afterRevoke.tokenId)).toBeNull();
  },
};
