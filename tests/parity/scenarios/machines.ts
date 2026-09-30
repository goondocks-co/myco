import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { lit, MACHINE_ID, MEMBER_ID, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

type Machine = { machineId: string; name: string | null; live: boolean; member: { id: string } };

/**
 * The machines on the People & machines page, on both targets: named by the host a join sends, read whole by an admin
 * and a member's own by a member, renamed by an admin or the machine's own member in one write to the machine, and a
 * member's Status showing only their own machines' capture.
 */
export const machines: ParityScenario = {
  name: 'machines: named at join, read by whose they are, renamed on the machine',
  async run(target: ParityTarget) {
    const now = Date.now();
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const otherMachine = `m_parity_machines_${now}`;
    let otherMember: string | null = null;
    // The parity member's machine, claimed as a join claims it, for as long as this scenario runs.
    const claimed = (await target.sql(`SELECT COUNT(*) AS n FROM machine_claims WHERE machine_id = ${lit(MACHINE_ID)}`))[0]!.n === 0;
    if (claimed) await target.sql(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(MACHINE_ID)}, ${lit(MEMBER_ID)}, ${now})`);
    try {
      const invite = await (await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: owner, body: JSON.stringify({ role: 'member' }) })).json() as { key: string };
      const joined = await (await fetch(`${target.url}/members/join`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
        body: JSON.stringify({ key: invite.key, machineId: otherMachine, runtimeLabel: 'parity-host', runtimeKind: 'persistent' }),
      })).json() as { joined: boolean; memberId: string };
      expect(joined.joined).toBe(true);
      otherMember = joined.memberId;
      await target.sql(`UPDATE members SET github_id = '5150616' WHERE id = ${lit(joined.memberId)}`);
      const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: '5150616', login: 'other', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
      const asOther = { cookie, 'cf-connecting-ip': '1.2.3.4', origin: target.url, 'content-type': 'application/json' };
      const list = async (headers: Record<string, string>) => {
        const res = await fetch(`${target.url}/api/machines`, { headers });
        expect(res.status).toBe(200);
        return ((await res.json()) as { machines: Machine[] }).machines;
      };
      const rename = (headers: Record<string, string>, machineId: string, label: unknown) =>
        fetch(`${target.url}/api/machines/${machineId}`, { method: 'PATCH', headers, body: JSON.stringify({ label }) });

      // The admin reads every machine, the joined one named after the host it sent.
      expect((await list(owner)).find((m) => m.machineId === otherMachine)).toMatchObject({ name: 'parity-host', live: true, member: { id: joined.memberId } });
      // The member reads their own machine alone.
      expect((await list(asOther)).map((m) => m.machineId)).toEqual([otherMachine]);

      // The member renames their own machine, and not another member's.
      expect(await (await rename(asOther, otherMachine, 'Parity laptop')).json() as unknown).toEqual({ machineId: otherMachine, name: 'Parity laptop' });
      // Another member's machine answers as an unknown one does.
      expect((await rename(asOther, MACHINE_ID, 'taken')).status).toBe(404);
      // An admin renames any machine, in one write to the machine and none to its credentials.
      expect((await rename(owner, otherMachine, 'Renamed by admin')).status).toBe(200);
      expect(await target.sql(`SELECT label FROM machine_claims WHERE machine_id = ${lit(otherMachine)}`)).toEqual([{ label: 'Renamed by admin' }]);
      expect(await target.sql(`SELECT DISTINCT runtime_label AS label FROM member_credentials WHERE machine_id = ${lit(otherMachine)}`)).toEqual([{ label: 'parity-host' }]);
      expect((await list(asOther))[0]!.name).toBe('Renamed by admin');
      expect((await rename(owner, otherMachine, 'two\nlines')).status).toBe(400);
      expect((await rename(owner, 'm_nobody_claims', 'x')).status).toBe(404);

      // A member's Status carries their own machines' capture, and no other machine's.
      const status = await (await fetch(`${target.url}/api/status`, { headers: asOther })).json() as { capture: Array<{ machineId: string }> };
      expect(status.capture.filter((row) => row.machineId !== otherMachine)).toEqual([]);

      // A machine with no live credential still takes a name.
      await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE machine_id = ${lit(otherMachine)} AND revoked_at IS NULL`);
      expect((await rename(owner, otherMachine, 'late')).status).toBe(200);
      expect((await list(owner)).find((m) => m.machineId === otherMachine)).toMatchObject({ name: 'late', live: false });
    } finally {
      if (claimed) await target.sql(`DELETE FROM machine_claims WHERE machine_id = ${lit(MACHINE_ID)}`);
      if (otherMember !== null) {
        await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE member_id = ${lit(otherMember)} AND revoked_at IS NULL`);
        await target.sql(`UPDATE members SET revoked_at = ${Date.now()}, github_id = NULL WHERE id = ${lit(otherMember)}`);
      }
    }
  },
};
