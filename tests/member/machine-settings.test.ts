/**
 * The settings a Deployment holds for this machine, as the machine caches them (#1393): one file per Deployment,
 * beside its membership, never read as a membership, and never cleared by an answer that carries none.
 */
import { describe, expect, it } from 'bun:test';
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
});
