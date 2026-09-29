/**
 * The settings a Deployment holds for this machine, as the machine caches them (#1393): one file per Deployment,
 * beside its membership, never read as a membership, and never cleared by an answer that carries none.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { cacheMachineSettings, machinePlanDirs } from '@myco/member/machine-settings.js';
import { listDeploymentMemberships, machineSettingsPath } from '@myco/member/registry.js';
import { tempMycoHome } from './helpers/server.js';

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
      const renamed = renames.mock.calls.map((c) => [String(c[0]), String(c[1])]);
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

  it('reads no folder the Deployment would refuse, whatever the file holds', () => {
    const home = tempMycoHome();
    cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['/', '~', '~/', '.', '../up', 'docs/plans', '~/notes'] } }, home);
    expect(machinePlanDirs('https://one.example', home)).toEqual(['docs/plans', '~/notes']);
  });
});
