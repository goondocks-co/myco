/**
 * The settings a Deployment holds for this machine, as the machine caches them (#1393): one file per Deployment,
 * beside its membership, never read as a membership, and never cleared by an answer that carries none.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { cacheMachineSettings, machinePlanDirs, beginMachineSettingsRequest, machineSettingsHeaders, forgetConnectRoot } from '@myco/member/machine-settings.js';
import { MACHINE_SETTINGS_FEATURE, MACHINE_SETTINGS_REVISION_HEADER, MACHINE_SETTINGS_INVALIDATED_HEADER, MACHINE_SETTINGS_ORDER_HEADER } from '@goondocks/myco-shared/member-protocol';
import { listDeploymentMemberships, machineSettingsPath } from '@myco/member/registry.js';
import { tempMycoHome } from './helpers/server.js';

const revision = (counter: number) => `m${counter}-${'a'.repeat(64)}`;

describe('the machine settings cache', () => {
  it('keeps one file per Deployment, each untouched by the other, and none read as a membership', () => {
    const home = tempMycoHome();
    expect(cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['a/plans'] } }, home)).toBe(true);
    expect(cacheMachineSettings('https://two.example/', { leaves: { 'capture.plan_dirs': ['~/b'] } }, home)).toBe(true);
    expect({ one: machinePlanDirs('https://one.example', home), two: machinePlanDirs('https://two.example', home) }).toEqual({ one: ['a/plans'], two: ['~/b'] });
    expect(listDeploymentMemberships(home)).toEqual([]);
    expect((fs.statSync(machineSettingsPath('https://one.example', home)).mode & 0o777).toString(8)).toBe('600');
  });

  it('leaves the cache as it was on an answer that carries no settings, and reads defaults where it has none', () => {
    const home = tempMycoHome();
    expect(machinePlanDirs('https://one.example', home)).toEqual([]);
    cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['a/plans'] } }, home);
    for (const answer of [undefined, null, 'x', { leaves: null }, { leaves: [] }]) expect(cacheMachineSettings('https://one.example', answer, home)).toBe(false);
    expect(machinePlanDirs('https://one.example', home)).toEqual(['a/plans']);
  });

  it('is written whole or not at all: a sibling file renamed onto it, never the file itself opened for writing', () => {
    const home = tempMycoHome();
    const target = machineSettingsPath('https://one.example', home);
    cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['old/plans'] } }, home);
    const writes = spyOn(fs, 'writeFileSync');
    const renames = spyOn(fs, 'renameSync');
    try {
      cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['new/plans'] } }, home);
      const written = writes.mock.calls.map((c) => String(c[0]));
      const renamed = renames.mock.calls.map((c) => [String(c[0]), String(c[1])]).filter((pair) => pair[1] === target);
      expect(written).not.toContain(target);
      expect(renamed).toHaveLength(1);
      expect(renamed[0]![1]).toBe(target);
      expect({ dir: path.dirname(renamed[0]![0]), staged: written.includes(renamed[0]![0]) }).toEqual({ dir: path.dirname(target), staged: true });
    } finally {
      writes.mockRestore();
      renames.mockRestore();
    }
    expect(machinePlanDirs('https://one.example', home)).toEqual(['new/plans']);
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the newest requested settings when responses race, while accepting a later restored revision', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const earlier = beginMachineSettingsRequest(server, home);
    const later = beginMachineSettingsRequest(server, home);
    const block = (revision: string, folder: string) => ({ feature: MACHINE_SETTINGS_FEATURE, revision, leaves: { 'capture.plan_dirs': [folder] } });
    expect(cacheMachineSettings(server, block(revision(2), 'new/plans'), home, later)).toBe(true);
    expect(cacheMachineSettings(server, block(revision(1), 'old/plans'), home, earlier)).toBe(false);
    expect(machinePlanDirs(server, home)).toEqual(['new/plans']);
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBe(revision(2));
    expect(cacheMachineSettings(server, block(revision(0), 'restored/plans'), home, beginMachineSettingsRequest(server, home))).toBe(true);
    expect(machinePlanDirs(server, home)).toEqual(['restored/plans']);
  });

  it('publishes the cached generation with its values even when its order sidecar write fails', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const earlier = beginMachineSettingsRequest(server, home);
    const later = beginMachineSettingsRequest(server, home);
    const rename = fs.renameSync;
    const writes = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('.order')) throw new Error('order write failed');
      return rename(from, to);
    });
    try {
      expect(() => cacheMachineSettings(server, { feature: MACHINE_SETTINGS_FEATURE, revision: revision(2), leaves: { 'capture.plan_dirs': ['new/plans'] } }, home, later)).toThrow('order write failed');
    } finally { writes.mockRestore(); }
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_ORDER_HEADER]).toBe(String(later));
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBe(revision(2));
    expect(cacheMachineSettings(server, { feature: MACHINE_SETTINGS_FEATURE, revision: revision(1), leaves: { 'capture.plan_dirs': ['old/plans'] } }, home, earlier)).toBe(false);
    expect(machinePlanDirs(server, home)).toEqual(['new/plans']);
    expect(beginMachineSettingsRequest(server, home)).toBeGreaterThan(later);
  });

  it('never reports a cached revision without the Deployment feature and withdraws it after a local disconnect', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    for (const feature of [undefined, 'unknown-feature']) {
      cacheMachineSettings(server, { feature, revision: revision(1), leaves: { 'capture.plan_dirs': ['plans'] } }, home);
      expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBeUndefined();
    }
    const root = 'a'.repeat(64);
    const block = { feature: MACHINE_SETTINGS_FEATURE, revision: revision(1), leaves: { 'capture.connect_roots': { [root]: 'proj_1' } } };
    cacheMachineSettings(server, block, home);
    const request = beginMachineSettingsRequest(server, home);
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBe(revision(1));
    forgetConnectRoot(server, root, home);
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_INVALIDATED_HEADER]).toBe('1');
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBeUndefined();
    expect(cacheMachineSettings(server, block, home, request)).toBe(false);
  });

  it('reads no folder the Deployment would refuse, whatever the file holds', () => {
    const home = tempMycoHome();
    cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['/', '~', '~/', '.', '../up', 'docs/plans', '~/notes'] } }, home);
    expect(machinePlanDirs('https://one.example', home)).toEqual(['docs/plans', '~/notes']);
  });
});
