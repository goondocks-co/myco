import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from '../support/fenced-fs.mjs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DEPLOYMENT_TARGETS, type DeploymentTarget } from '@goondocks/myco-shared/settings-contract';
import { MACHINE_SETTING_SPECS, MACHINE_SETTINGS_FEATURE, MACHINE_SETTINGS_HEADER, MACHINE_SETTINGS_REVISION_HEADER, MACHINE_SETTINGS_ORDER_HEADER, MACHINE_SETTINGS_INVALIDATED_HEADER, parseMachineSettingsRevision } from '@goondocks/myco-shared/member-protocol';
import { MACHINE_LEAF_SPECS, type MachineLeaf } from '@myco-server-worker/core/machine-settings.js';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { cacheMachineSettings, machineSettingsHeaders, machinePlanDirs, machineAutoJoinLeaves, seedMachineSettings, forgetConnectRoot } from '@myco/member/machine-settings.js';
import { asOwner, asOwnerPut, OWNER_ENV } from './helpers/owner.js';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';

const ROOT_KEY = 'a'.repeat(64);
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(path.join(tmpdir(), 'myco-machine-contract-')); temporary.push(dir); return dir; };

async function rig(target: DeploymentTarget) {
  const fixture = sqliteEnv();
  const env = target === 'cloudflare'
    ? serverEnvFromBindings({ ...fixture.env, ...OWNER_ENV }, fixture.deferred)
    : serverEnvFromBunConfig({ sqlite: fixture.sqlite, blobDir: path.join(scratch(), 'blobs'), ...OWNER_ENV });
  const server = createServer({ now: Date.now, sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  const request = (request: Request) => server.handleRequest(request, env);
  fixture.sqlite.run(`INSERT INTO machine_claims(machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', 1)`);
  const { token } = await issueMemberToken(env.db, { machineId: 'machine_1', memberId: 'mem_machine_1' }, Date.now());
  const home = scratch();
  const rows = async () => {
    const response = await request(await asOwner('/api/machines/machine_1/settings'));
    expect(response.status).toBe(200);
    return ((await response.json()) as { leaves: MachineLeaf[] }).leaves;
  };
  const sync = async () => {
    const response = await request(memberPost(token, {}, '/members/settings', machineSettingsHeaders('https://s', home)));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-myco-features')).toContain(MACHINE_SETTINGS_FEATURE);
    const body = await response.json() as { machine: unknown };
    expect(cacheMachineSettings('https://s', body.machine, home)).toBe(true);
    return body.machine;
  };
  const set = async (leaf: string, value: unknown, reset = false) => request(await asOwnerPut(`/api/machines/machine_1/settings/${leaf}`, { value, reset }));
  return { ...fixture, env, request, token, home, rows, sync, set };
}

interface BehaviorCase {
  valid: unknown;
  invalid: unknown;
  consume(home: string): unknown;
}
const CASES: Readonly<Record<string, BehaviorCase>> = {
  'capture.plan_dirs': { valid: ['docs/plans'], invalid: ['/', 'docs/plans'], consume: (home) => machinePlanDirs('https://s', home) },
  'capture.auto_join_roots': { valid: ['~/Work'], invalid: ['/', '~/Work'], consume: (home) => machineAutoJoinLeaves('https://s', home).autoJoinRoots },
  'capture.connect_roots': { valid: { [ROOT_KEY]: 'proj_1' }, invalid: { [ROOT_KEY]: 'proj_1', broken: 7 }, consume: (home) => machineAutoJoinLeaves('https://s', home).connectRoots },
};

describe('machine settings effective contract', () => {
  it('requires a real member consumer behavior case for every admitted machine leaf', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(MACHINE_LEAF_SPECS).sort());
    expect(Object.keys(MACHINE_LEAF_SPECS).sort()).toEqual(Object.keys(MACHINE_SETTING_SPECS).sort());
  });

  for (const target of DEPLOYMENT_TARGETS) {
    for (const leaf of Object.keys(MACHINE_LEAF_SPECS)) {
      it(`${target}: ${leaf} reports exactly what its member consumer reads, preserving invalid stored entries`, async () => {
        const r = await rig(target);
        const behavior = CASES[leaf]!;
        const row = async () => (await r.rows()).find((answer) => answer.leaf === leaf)!;
        const configured = async (value: unknown) => {
          if (MACHINE_LEAF_SPECS[leaf]!.serverWritten) {
            r.sqlite.run(`INSERT INTO machine_settings(machine_id, leaf, value, updated_at, updated_by) VALUES ('machine_1', ?, ?, 1, 'test')
              ON CONFLICT(machine_id, leaf) DO UPDATE SET value = excluded.value`, [leaf, JSON.stringify(value)]);
          } else expect((await r.set(leaf, value)).status).toBe(200);
        };
        await r.sync();
        const unset = await row();
        expect(unset.effective).toBeNull();
        expect(unset.nextEffective).toEqual(behavior.consume(r.home));
        expect(unset.stored).toBeNull();
        expect(unset.source).toBe('unset');
        expect(unset.nextSource).toBe('default');
        expect(unset.application).toBe('unreported');
        await r.sync();
        expect((await row()).application).toBe('applied');

        await configured(behavior.valid);
        const pending = await row();
        expect(pending).toMatchObject({ stored: behavior.valid, effective: unset.nextEffective, nextEffective: behavior.valid, source: 'member-cache', nextSource: 'configured', storedApplies: false, application: 'pending', appliedValue: unset.nextEffective });
        expect(pending.effective).toEqual(behavior.consume(r.home));
        expect(pending.reason).toContain('next session start');
        expect(pending.revision).not.toBe(unset.revision);
        await r.sync();
        expect((await row()).nextEffective).toEqual(behavior.consume(r.home));
        await r.sync();
        expect((await row()).effective).toEqual(behavior.consume(r.home));
        expect(await row()).toMatchObject({ application: 'applied', storedApplies: true, appliedRevision: pending.revision, appliedValue: behavior.valid });

        r.sqlite.run(`UPDATE machine_settings SET value = ? WHERE machine_id = 'machine_1' AND leaf = ?`, [JSON.stringify(behavior.invalid), leaf]);
        const invalid = await row();
        expect(invalid).toMatchObject({ stored: behavior.invalid, state: 'invalid', nextSource: 'invalid', storedApplies: false });
        expect(invalid.reason).toContain('Clear the stored value');
        if (MACHINE_LEAF_SPECS[leaf]!.serverWritten) expect(invalid.reason).toContain('Valid connections are kept');
        await r.sync();
        await r.sync();
        expect((await row()).effective).toEqual(behavior.consume(r.home));
        expect((await row()).storedApplies).toBe(false);
        expect(JSON.parse((r.sqlite.query(`SELECT value FROM machine_settings WHERE machine_id = 'machine_1' AND leaf = ?`).get(leaf) as { value: string }).value)).toEqual(behavior.invalid);

        expect((await r.set(leaf, null, true)).status).toBe(200);
        await r.sync();
        await r.sync();
        const reset = await row();
        expect(reset).toMatchObject(MACHINE_LEAF_SPECS[leaf]!.serverWritten ? { configured: true, source: 'configured', stored: behavior.valid } : { configured: false, source: 'default', stored: null });
        expect(reset.revision).not.toBe(invalid.revision);
        expect(reset.effective).toEqual(behavior.consume(r.home));
      });
    }

    it(`${target}: negotiates the contract both ways and never confirms a revision a machine was not served`, async () => {
      const r = await rig(target);
      const legacy = await r.request(memberPost(r.token, {}, '/members/settings'));
      const legacyMachine = (await legacy.json() as { machine: unknown }).machine;
      expect(legacyMachine).toEqual({ leaves: { 'capture.plan_dirs': [], 'capture.auto_join_roots': ['~/Repos'], 'capture.connect_roots': {} } });
      cacheMachineSettings('https://old', legacyMachine, r.home);
      expect(machineSettingsHeaders('https://old', r.home)).toEqual({ [MACHINE_SETTINGS_HEADER]: MACHINE_SETTINGS_FEATURE });
      await r.sync();
      const revision = (await r.rows())[0]!.revision;
      await r.request(memberPost(r.token, {}, '/members/settings', { [MACHINE_SETTINGS_REVISION_HEADER]: revision }));
      expect((await r.rows())[0]!.application).toBe('unreported');
      await r.request(memberPost(r.token, {}, '/members/settings', { [MACHINE_SETTINGS_HEADER]: MACHINE_SETTINGS_FEATURE, [MACHINE_SETTINGS_REVISION_HEADER]: `m999-${'f'.repeat(64)}`, [MACHINE_SETTINGS_ORDER_HEADER]: '1' }));
      expect((await r.rows())[0]!.application).toBe('unreported');
      await r.sync();
      expect((await r.rows())[0]!.application).toBe('applied');

      expect(await seedMachineSettings({ serverUrl: 'https://s', token: r.token }, {
        mycoHome: r.home, fetch: (input, init) => r.request(new Request(input, init)),
      })).toBe(true);
    });

    it(`${target}: confirms an older delivered snapshot after a newer one was sent, without regressing a later report`, async () => {
      const r = await rig(target);
      const serve = async (headers: Record<string, string>) => (await (await r.request(memberPost(r.token, {}, '/members/settings', headers))).json() as { machine: { revision: string } }).machine;
      const advertise = { [MACHINE_SETTINGS_HEADER]: MACHINE_SETTINGS_FEATURE };
      expect((await r.set('capture.plan_dirs', ['first/plans'])).status).toBe(200);
      const first = await serve(advertise);
      expect((await r.set('capture.plan_dirs', ['second/plans'])).status).toBe(200);
      const second = await serve(advertise);
      cacheMachineSettings('https://s', first, r.home);
      const firstReport = machineSettingsHeaders('https://s', r.home);
      await serve(firstReport);
      const row = async () => (await r.rows()).find((leaf) => leaf.leaf === 'capture.plan_dirs')!;
      expect(await row()).toMatchObject({ application: 'pending', appliedRevision: first.revision, effective: ['first/plans'], nextEffective: ['second/plans'], storedApplies: false });
      cacheMachineSettings('https://s', second, r.home);
      await serve(machineSettingsHeaders('https://s', r.home));
      expect(await row()).toMatchObject({ application: 'applied', appliedRevision: second.revision, effective: ['second/plans'], storedApplies: true });
      await serve(firstReport);
      expect(await row()).toMatchObject({ application: 'applied', appliedRevision: second.revision, effective: ['second/plans'] });
      cacheMachineSettings('https://s', first, r.home);
      await serve(machineSettingsHeaders('https://s', r.home));
      expect(await row()).toMatchObject({ application: 'pending', appliedRevision: first.revision, effective: machinePlanDirs('https://s', r.home), nextEffective: ['second/plans'], storedApplies: false });
    });

    it(`${target}: withdraws confirmed values after a local edit and fences delayed acknowledgments and invalidations`, async () => {
      const r = await rig(target);
      r.sqlite.run(`INSERT INTO machine_settings(machine_id, leaf, value, updated_at, updated_by) VALUES ('machine_1', 'capture.connect_roots', ?, 1, 'test')`, [JSON.stringify({ [ROOT_KEY]: 'proj_1' })]);
      await r.sync();
      await r.sync();
      const oldReport = machineSettingsHeaders('https://s', r.home);
      expect((await r.rows())[0]!.application).toBe('applied');
      forgetConnectRoot('https://s', ROOT_KEY, r.home);
      expect(machineAutoJoinLeaves('https://s', r.home).connectRoots).toEqual({});
      const invalidated = machineSettingsHeaders('https://s', r.home);
      expect(invalidated[MACHINE_SETTINGS_INVALIDATED_HEADER]).toBe('1');
      expect(invalidated[MACHINE_SETTINGS_REVISION_HEADER]).toBeUndefined();
      await r.request(memberPost(r.token, {}, '/members/settings', { [MACHINE_SETTINGS_INVALIDATED_HEADER]: '1', [MACHINE_SETTINGS_ORDER_HEADER]: invalidated[MACHINE_SETTINGS_ORDER_HEADER]! }));
      expect((await r.rows())[0]!.application).toBe('applied');
      await r.request(memberPost(r.token, {}, '/members/settings', invalidated));
      expect((await r.rows()).every((leaf) => leaf.application === 'unreported' && leaf.effective === null)).toBe(true);
      await r.request(memberPost(r.token, {}, '/members/settings', oldReport));
      expect((await r.rows()).every((leaf) => leaf.application === 'unreported' && leaf.effective === null)).toBe(true);
      await r.sync();
      expect((await r.rows())[0]!.application).toBe('unreported');
      await r.sync();
      expect((await r.rows()).find((leaf) => leaf.leaf === 'capture.connect_roots')!).toMatchObject({ application: 'applied', effective: machineAutoJoinLeaves('https://s', r.home).connectRoots, storedApplies: true });
      await r.request(memberPost(r.token, {}, '/members/settings', invalidated));
      expect((await r.rows())[0]!.application).toBe('applied');
    });

    it(`${target}: marks a changed default pending even when no stored row or counter changed`, async () => {
      const r = await rig(target);
      await r.sync();
      await r.sync();
      const row = async () => (await r.rows()).find((leaf) => leaf.leaf === 'capture.plan_dirs')!;
      const initial = await row();
      const defaults = MACHINE_SETTING_SPECS['capture.plan_dirs'].default;
      const previous = [...defaults];
      try {
        defaults.push('release/plans');
        const changed = await row();
        expect(changed).toMatchObject({ application: 'pending', effective: machinePlanDirs('https://s', r.home), nextEffective: ['release/plans'] });
        expect(parseMachineSettingsRevision(changed.revision)!.counter).toBe(parseMachineSettingsRevision(initial.revision)!.counter);
        expect(changed.revision).not.toBe(initial.revision);
        await r.sync();
        await r.sync();
        expect(await row()).toMatchObject({ application: 'applied', effective: machinePlanDirs('https://s', r.home), nextEffective: ['release/plans'] });
      } finally { defaults.splice(0, defaults.length, ...previous); }
    });

    it(`${target}: never aliases an old cache after a same-URL portable restore loses the replacement response`, async () => {
      const source = await rig(target);
      expect((await source.set('capture.plan_dirs', ['stored/plans'])).status).toBe(200);
      await source.sync();
      await source.sync();
      const oldHeaders = machineSettingsHeaders('https://s', source.home);
      const oldRevision = oldHeaders[MACHINE_SETTINGS_REVISION_HEADER]!;
      const saved = await createBackup(source.env.db, source.bucket, { producer: 'test', now: Date.now() });
      const artifact = (await backupArtifact(source.env.db, source.bucket, saved.id))!;
      const restored = await rig(target);
      restored.sqlite.run(`DELETE FROM machine_claims WHERE machine_id = 'machine_1'`);
      await restoreArtifact(restored.env.db, { text: artifact.text, allowForeignLineage: true });
      const ask = (headers: Record<string, string>) => restored.request(memberPost(source.token, {}, '/members/settings', headers));
      const lostResponse = await ask(oldHeaders);
      expect(lostResponse.status).toBe(200);
      const lost = (await lostResponse.json() as { machine: { revision: string; leaves: Record<string, unknown> } }).machine;
      expect(parseMachineSettingsRevision(lost.revision)!.counter).toBe(parseMachineSettingsRevision(oldRevision)!.counter);
      expect(lost.revision).not.toBe(oldRevision);
      const stillOld = await ask(oldHeaders);
      expect(stillOld.status).toBe(200);
      const replacement = (await stillOld.json() as { machine: unknown }).machine;
      expect(machinePlanDirs('https://s', source.home)).toEqual(['stored/plans']);
      expect((await restored.rows()).find((leaf) => leaf.leaf === 'capture.plan_dirs')!).toMatchObject({ application: 'unreported', effective: null, nextEffective: [] });
      cacheMachineSettings('https://s', replacement, source.home);
      expect((await ask(machineSettingsHeaders('https://s', source.home))).status).toBe(200);
      expect((await restored.rows()).find((leaf) => leaf.leaf === 'capture.plan_dirs')!).toMatchObject({ application: 'applied', effective: machinePlanDirs('https://s', source.home), nextEffective: [] });
    });

    it(`${target}: refuses to clear a valid server-written connection document`, async () => {
      const r = await rig(target);
      const value = { [ROOT_KEY]: 'proj_1' };
      r.sqlite.run(`INSERT INTO machine_settings(machine_id, leaf, value, updated_at, updated_by) VALUES ('machine_1', 'capture.connect_roots', ?, 1, 'test')`, [JSON.stringify(value)]);
      expect((await r.set('capture.connect_roots', null, true)).status).toBe(400);
      expect((r.sqlite.query(`SELECT value FROM machine_settings WHERE machine_id = 'machine_1' AND leaf = 'capture.connect_roots'`).get() as { value: string }).value).toBe(JSON.stringify(value));
    });

    it(`${target}: preserves malformed JSON and reports the fallback that the member uses`, async () => {
      const r = await rig(target);
      r.sqlite.run(`INSERT INTO machine_settings(machine_id, leaf, value, updated_at, updated_by) VALUES ('machine_1', 'capture.plan_dirs', '{bad', 1, 'test')`);
      await r.sync();
      const row = (await r.rows()).find((answer) => answer.leaf === 'capture.plan_dirs')!;
      expect(row).toMatchObject({ stored: '{bad', effective: null, nextEffective: [], state: 'invalid', storedApplies: false });
      await r.sync();
      expect((await r.rows()).find((answer) => answer.leaf === 'capture.plan_dirs')!.effective).toEqual(machinePlanDirs('https://s', r.home));
      expect((r.sqlite.query(`SELECT value FROM machine_settings WHERE machine_id = 'machine_1' AND leaf = 'capture.plan_dirs'`).get() as { value: string }).value).toBe('{bad');
    });
  }
});
