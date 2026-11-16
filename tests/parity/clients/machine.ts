import { runHelperVerb } from '@myco/cli/member-helper.js';
import { setAutomaticUpdates } from '@myco/member/automatic-update-state.js';
import { readAutomaticUpdatePreference } from '@myco/install/marker-reader.js';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import type { ParityTarget } from '../harness.ts';

/** A member's delivery pass and local update command, using its isolated home and real transport. */
export function machineMember(target: ParityTarget, machine: { token: string; machineId: string }, home: string) {
  const route = { serverUrl: target.url, projectId: target.projectId };
  writeRegistryEntry({ ...route, ...machine, version: REGISTRY_VERSION, root: home, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome: home });
  return {
    pass: () => runHelperVerb(['--project', target.projectId, '--server', target.url, '--home', home], {
      lingerMs: 0, deadlineMs: 15_000, keepStderr: true, keepCurrent: () => null, spawn: () => ({ started: false }),
      fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cf-connecting-ip': '1.2.3.4' } }),
    }),
    automatic: () => readAutomaticUpdatePreference(home).enabled,
    localAutomatic: (enabled: boolean) => setAutomaticUpdates(home, enabled),
  };
}
