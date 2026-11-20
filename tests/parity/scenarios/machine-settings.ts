import { expect } from 'bun:test';
import fs, { mkdtempSync, rmSync } from "../../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machinePlanDirs, seedMachineSettings, cacheMachineSettings } from '@myco/member/machine-settings.js';
import { machineSettingsPath, writeDeploymentMembership } from '@myco/member/registry.js';
import { memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { browser, deviceMachine, person, stopMember } from '../clients/identity.ts';
import { machineMember } from '../clients/machine.ts';

const LEAF = 'capture.plan_dirs';
/** Every other leaf a machine holds, at its default: the folders it captures repositories under, and none told to connect. */
const AT_DEFAULT = { 'capture.prompt_file_roots': [], 'capture.auto_join_roots': ['~/Repos'], 'capture.connect_roots': {} };

/**
 * A machine's settings on both targets (#1393): set on the dashboard by the machine's own member and nobody else, and
 * answered to that machine, and only that machine, at session start and on `/members/settings`, where the machine
 * caches them one file per Deployment.
 */
export const machineSettings: ParityScenario = {
  name: 'machine settings: set on the dashboard, answered to that machine alone, and cached per Deployment',
  async run(target: ParityTarget) {
    const now = Date.now();
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const put = (headers: Record<string, string>, machineId: string, value: unknown) => fetch(`${target.url}/api/machines/${machineId}/settings/${LEAF}`, {
      method: 'PUT', headers, body: JSON.stringify({ value }),
    });
    const settingsOf = async (headers: Record<string, string>) => {
      const res = await fetch(`${target.url}/members/settings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
      return (await res.json() as { machine?: { leaves: Record<string, unknown>; revision?: string } }).machine ?? null;
    };
    const home = mkdtempSync(join(tmpdir(), 'myco-parity-machine-settings-'));
    // A machine of the parity member, signed in through the device flow, and its credential.
    const mine = await deviceMachine(target, target.ownerHeaders());
    const MACHINE_ID = mine.machineId;
    const mineHeaders = memberHeadersFor(mine.token, target.projectId);
    let otherMember: string | null = null;
    try {
      // The parity member, who claims this machine, sets its plan folders; the machine is answered them on both of its reads.
      expect((await put(owner, MACHINE_ID, ['~/notes/plans', 'docs/plans'])).status).toBe(200);
      expect(await settingsOf(mineHeaders)).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: ['~/notes/plans', 'docs/plans'] } });
      const session = await fetch(`${target.url}/context/session`, {
        method: 'POST', headers: { ...mineHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: `sess_parity_machine_${now}`, kind: 'start' }),
      });
      expect(((await session.json()) as { machine?: unknown }).machine).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: ['~/notes/plans', 'docs/plans'] } });

      // Another member's machine is answered its own settings, never this one's.
      const other = await person(target, '5150515', { login: 'other' });
      otherMember = other.id;
      const otherMachine = other.machineId;
      const otherHeaders = memberHeadersFor(other.token, target.projectId);
      expect(await settingsOf(otherHeaders)).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: [] } });

      // That member, on the dashboard, reaches its own machine and not this one.
      const asOther = { ...other.session, origin: target.url, 'content-type': 'application/json' };
      expect((await fetch(`${target.url}/api/machines/${MACHINE_ID}/settings`, { headers: asOther })).status).toBe(403);
      expect((await put(asOther, MACHINE_ID, ['~/elsewhere'])).status).toBe(403);
      expect((await put(asOther, otherMachine, ['plans'])).status).toBe(200);
      expect(await settingsOf(otherHeaders)).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: ['plans'] } });

      // An admin who does not own that machine reads and writes none of it.
      expect((await fetch(`${target.url}/api/machines/${otherMachine}/settings`, { headers: owner })).status).toBe(403);
      expect((await put(owner, otherMachine, ['~/admin-was-here'])).status).toBe(403);
      expect((await put(owner, otherMachine, [])).status).toBe(403);
      expect(await settingsOf(otherHeaders)).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: ['plans'] } });

      // A folder that names the whole home, the filesystem root or the project, or climbs out, is refused.
      for (const broad of ['~', '~/', '/', '.', '../plans']) expect((await put(asOther, otherMachine, [broad])).status).toBe(400);

      // Refused values and machines no member claims.
      expect((await put(owner, MACHINE_ID, 'not a list')).status).toBe(400);
      expect((await put(owner, 'm_nobody_claims', ['plans'])).status).toBe(404);

      const updates = `/api/machines/${MACHINE_ID}/settings`;
      const channelWrite = (value: unknown) => fetch(`${target.url}${updates}/update.channel`, { method: 'PUT', headers: owner, body: JSON.stringify({ value }) });
      const readUpdates = async () => (await browser(target, updates, target.ownerHeaders())).body.leaves as Array<{ leaf: string; application: string; effective: unknown }>;
      const supporting = { ...mineHeaders, 'x-myco-machine-settings': 'machine-settings-contract' };
      const baseline = await settingsOf(supporting);
      await settingsOf({ ...supporting, 'x-myco-machine-settings-revision': baseline!.revision!, 'x-myco-machine-settings-order': '1' });
      const capture = (await readUpdates()).filter(row => row.leaf.startsWith('capture.'));
      expect(capture.every(row => row.application === 'applied')).toBe(true);
      expect((await readUpdates()).find(row => row.leaf === 'update.channel')).toMatchObject({ application: 'unreported', effective: null });
      const invalidChannel = await channelWrite('nightly');
      expect(invalidChannel.status).toBe(400);
      expect(await invalidChannel.json()).toMatchObject({ reason: 'invalid_value', detail: expect.stringContaining('stable, beta, alpha') });
      expect((await channelWrite('beta')).status).toBe(200);
      expect((await fetch(`${target.url}${updates}/update.automatic`, { method: 'PUT', headers: owner, body: JSON.stringify({ value: false }) })).status).toBe(200);
      expect((await readUpdates()).filter(row => row.leaf.startsWith('capture.'))).toEqual(capture);
      expect((await fetch(`${target.url}${updates}/update.channel`, { method: 'PUT', headers: asOther, body: JSON.stringify({ value: 'alpha' }) })).status).toBe(403);
      expect((await readUpdates()).find(row => row.leaf === 'update.channel')).toMatchObject({ application: 'pending', effective: null });
      // A cache acknowledgement from an older machine confirms no update preference.
      await settingsOf({ ...mineHeaders, 'x-myco-machine-settings': 'machine-settings-contract' });
      expect((await readUpdates()).find(row => row.leaf === 'update.channel')).toMatchObject({ application: 'pending', effective: null });
      const report = async (order: number, values: Record<string, unknown>, requests: Record<string, unknown>) => {
        const response = await fetch(`${target.url}/members/settings`, { method: 'POST', headers: {
          ...mineHeaders, 'content-type': 'application/json', 'x-myco-machine-settings': 'machine-settings-contract',
          'x-myco-machine-update-settings': JSON.stringify({ order, values, requests }),
        }, body: '{}' });
        expect(response.status).toBe(200);
        return (await response.json() as { machine: { updateRequests: Record<string, { id: string; value: unknown }> } }).machine;
      };
      const requested = await report(1, { 'update.channel': 'alpha', 'update.automatic': true }, {});
      expect((await readUpdates()).filter(row => row.leaf.startsWith('capture.'))).toEqual(capture);
      expect(requested.updateRequests['update.channel']).toMatchObject({ value: 'beta' });
      expect(requested.updateRequests['update.automatic']).toMatchObject({ value: false });
      expect((await readUpdates()).find(row => row.leaf === 'update.channel')).toMatchObject({ application: 'pending', effective: 'alpha' });
      await report(2, { 'update.channel': 'beta', 'update.automatic': false }, requested.updateRequests);
      expect((await readUpdates()).filter(row => row.leaf.startsWith('capture.'))).toEqual(capture);
      expect((await fetch(`${target.url}${updates}/update.channel`, { method: 'PUT', headers: owner, body: JSON.stringify({ value: null, reset: true }) })).status).toBe(200);
      expect((await readUpdates()).filter(row => row.leaf.startsWith('capture.'))).toEqual(capture);
      expect((await readUpdates()).find(row => row.leaf === 'update.channel')).toMatchObject({ application: 'applied', effective: 'beta' });
      await report(3, { 'update.channel': 'stable', 'update.automatic': true }, requested.updateRequests);
      expect((await readUpdates()).find(row => row.leaf === 'update.channel')).toMatchObject({ application: 'applied', effective: 'stable' });
      await report(2, { 'update.channel': 'beta' }, requested.updateRequests);
      expect((await readUpdates()).find(row => row.leaf === 'update.channel')).toMatchObject({ effective: 'stable' });

      // The machine caches the answer one file per Deployment: another Deployment's cache is left as it was.
      const elsewhere = 'https://elsewhere.parity.example';
      cacheMachineSettings(elsewhere, { leaves: { [LEAF]: ['~/other-deployment'] } }, home);
      writeDeploymentMembership({ serverUrl: target.url, token: mine.token, machineId: MACHINE_ID, joinedAt: now, updatedAt: now }, { mycoHome: home });
      const seeded = await seedMachineSettings({ serverUrl: target.url, token: mine.token }, {
        mycoHome: home,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cf-connecting-ip': '1.2.3.4' } })) as typeof fetch,
      });
      expect(seeded).toBe(true);
      expect({ here: machinePlanDirs(target.url, home), there: machinePlanDirs(elsewhere, home) })
        .toEqual({ here: ['~/notes/plans', 'docs/plans'], there: ['~/other-deployment'] });
      expect(fs.existsSync(machineSettingsPath(target.url, home))).toBe(true);

      const receivedAt = Date.now();
      const member = machineMember(target, mine, home, () => receivedAt);
      const automaticWrite = (value: boolean) => fetch(`${target.url}${updates}/update.automatic`, { method: 'PUT', headers: owner, body: JSON.stringify({ value }) });
      const automatic = async () => (await readUpdates()).find(row => row.leaf === 'update.automatic');
      await member.pass();
      expect(member.paths()).toEqual(['/events']);
      await member.pass(0);
      expect(member.paths()).toEqual([]);
      expect((await put(owner, MACHINE_ID, ['docs/delivery-plans'])).status).toBe(200);
      await member.pass();
      expect(machinePlanDirs(target.url, home)).toEqual(['docs/delivery-plans']);
      expect((await fetch(`${target.url}${updates}/capture.prompt_file_roots`, { method: 'PUT', headers: owner, body: JSON.stringify({ value: ['~/tasks'] }) })).status).toBe(200);
      await member.prompt();
      expect(member.paths()).toEqual(['/events']);
      expect(member.promptRoots()).toEqual(['~/tasks']);
      expect((await automaticWrite(false)).status).toBe(200);
      expect(await automatic()).toMatchObject({ application: 'pending' });
      await member.pass();
      expect(member.automatic()).toBe(false);
      expect(member.paths()).toEqual(['/events', '/members/settings']);
      expect(await automatic()).toMatchObject({ application: 'applied', effective: false });
      expect((await automaticWrite(true)).status).toBe(200);
      await member.pass(2);
      expect(member.automatic()).toBe(true);
      expect(member.paths()).toEqual(['/events', '/events']);
      expect(await automatic()).toMatchObject({ application: 'applied', effective: true });
      expect((await automaticWrite(false)).status).toBe(200);
      member.localAutomatic(true, receivedAt + 1);
      await member.pass();
      expect(member.automatic()).toBe(true);
      expect(await automatic()).toMatchObject({ application: 'applied', effective: true });

      // The default resets a leaf: it reads as not configured.
      expect((await put(owner, MACHINE_ID, [])).status).toBe(200);
      const reset = await browser(target, `/api/machines/${MACHINE_ID}/settings`, target.ownerHeaders());
      expect((reset.body.leaves as Array<{ leaf: string; configured: boolean }>).find((row) => row.leaf === LEAF)).toMatchObject({ configured: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (otherMember !== null) await stopMember(target, otherMember);
      expect((await browser(target, `/api/machines/${MACHINE_ID}/stop`, target.ownerHeaders(), {})).status).toBe(200);
    }
  },
};
