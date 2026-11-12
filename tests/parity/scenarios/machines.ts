import { expect } from 'bun:test';
import { type ParityScenario, type ParityTarget } from '../harness.ts';
import { browser, deviceMachine, person, stopMember } from '../clients/identity.ts';

type Machine = { machineId: string; name: string | null; live: boolean; member: { id: string } };

/**
 * The machines on the People & machines page, on both targets: named by the host a join sends, read whole by an admin
 * and a member's own by a member, renamed by an admin or the machine's own member in one write to the machine, and a
 * member's Status showing only their own machines' capture. Paging thousands of credentials and merged activity are
 * covered by `people-and-machines.test.ts`.
 */
export const machines: ParityScenario = {
  name: 'machines: named at join, read by whose they are, renamed on the machine',
  async run(target: ParityTarget) {
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    // A machine of the parity member, signed in through the device flow.
    const mine = await deviceMachine(target, target.ownerHeaders());
    const other = await person(target, '5150616', { runtimeLabel: 'parity-host', runtimeKind: 'persistent', login: 'other' });
    try {
      const asOther = { ...other.session, origin: target.url, 'content-type': 'application/json' };
      const list = async (headers: Record<string, string>) => {
        const res = await fetch(`${target.url}/api/machines`, { headers });
        expect(res.status).toBe(200);
        return ((await res.json()) as { machines: Machine[] }).machines;
      };
      const rename = (headers: Record<string, string>, machineId: string, label: unknown) =>
        fetch(`${target.url}/api/machines/${machineId}`, { method: 'PATCH', headers, body: JSON.stringify({ label }) });

      // The admin reads every machine, the joined one named after the host it sent.
      expect((await list(owner)).find((m) => m.machineId === other.machineId)).toMatchObject({ name: 'parity-host', live: true, member: { id: other.id } });
      // The member reads their own machine alone.
      expect((await list(asOther)).map((m) => m.machineId)).toEqual([other.machineId]);

      // The member renames their own machine, and not another member's.
      expect(await (await rename(asOther, other.machineId, 'Parity laptop')).json() as unknown).toEqual({ machineId: other.machineId, name: 'Parity laptop' });
      // Another member's machine answers as an unknown one does.
      expect((await rename(asOther, mine.machineId, 'taken')).status).toBe(404);
      // An admin renames any machine.
      expect((await rename(owner, other.machineId, 'Renamed by admin')).status).toBe(200);
      expect((await list(asOther))[0]!.name).toBe('Renamed by admin');
      expect((await rename(owner, other.machineId, 'two\nlines')).status).toBe(400);
      expect((await rename(owner, 'm_nobody_claims', 'x')).status).toBe(404);

      // A member's Status carries their own machines' capture, and no other machine's.
      const status = await (await fetch(`${target.url}/api/status`, { headers: asOther })).json() as { capture: Array<{ machineId: string }> };
      expect(status.capture.filter((row) => row.machineId !== other.machineId)).toEqual([]);

      // A machine with no live credential still takes a name.
      expect((await browser(target, `/api/machines/${other.machineId}/stop`, target.ownerHeaders(), {})).status).toBe(200);
      expect((await rename(owner, other.machineId, 'late')).status).toBe(200);
      expect((await list(owner)).find((m) => m.machineId === other.machineId)).toMatchObject({ name: 'late', live: false });
    } finally {
      await stopMember(target, other.id);
      expect((await browser(target, `/api/machines/${mine.machineId}/stop`, target.ownerHeaders(), {})).status).toBe(200);
    }
  },
};
