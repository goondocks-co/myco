import { expect } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { CURATION_DAILY_LIMIT_LEAF } from '@myco-server-worker/core/settings.js';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { client, owner, pick, setting, type RouteTarget, type SeedTarget } from './requests.ts';

/** The settings and machines a Deployment's owner and members configured. */
export interface MachinesSeed {
  setting: { leaf: string; revision: string };
  projectLeaf: string;
  machine: { machineId: string; token: string; rootKey: string };
}

const SETTING_LEAF = 'agent.limits.concurrent_runs';
const MACHINE_LEAF = 'capture.plan_dirs';
const IDLE_CLOSE_LEAF = 'agent.titling_idle_close_minutes';

/**
 * A Deployment setting written at the revision the dashboard read, a changed idle close, a Project setting, and a second
 * machine signed in
 * through the device flow that reports its harnesses and a repository it cannot capture, polls for work, and holds a
 * setting of its own.
 */
export async function seedMachines(target: SeedTarget, stamp: number): Promise<MachinesSeed> {
  const revision = async () => String(((await owner(target, '/api/settings')).body.leaves as Array<{ leaf: string; revision: string }>).find((row) => row.leaf === SETTING_LEAF)!.revision);
  const written = await setting(target, `/api/settings/${SETTING_LEAF}`, { value: 3 });
  expect(written.status).toBe(200);
  const project = await setting(target, `/api/settings/${CURATION_DAILY_LIMIT_LEAF}`, { project_id: target.projectId, value: 7 });
  expect(project.status).toBe(200);
  // A changed idle close, which moves every session's quiet deadline under a new policy generation.
  expect((await setting(target, `/api/settings/${IDLE_CLOSE_LEAF}`, { value: 90 })).status).toBe(200);

  const machineId = `upgrade-laptop-${stamp}`;
  const started = await client(target, '/auth/device/start', { machineId, machineName: 'Upgrade laptop', os: 'linux' });
  expect(started.status).toBe(200);
  expect((await owner(target, '/api/device/approve', { method: 'POST', body: JSON.stringify({ user_code: started.body.user_code }) })).status).toBe(200);
  const polled = await client(target, '/auth/device/poll', { device_code: started.body.device_code });
  expect(polled.body).toMatchObject({ joined: true });
  const token = String(polled.body.token);
  const rootKey = `${stamp.toString(16)}`.padEnd(16, '0').slice(0, 16);
  const headers = (extra: Record<string, string> = {}) => ({ ...target.memberHeaders(extra), authorization: `Bearer ${token}` });
  const report = await fetch(`${target.url}/members/harnesses/report`, {
    method: 'POST', headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ harnesses: [{ id: 'codex', provisioned: true, state: 'ready', ranAt: stamp }] }),
  });
  expect(report.status).toBe(200);
  const listed = (await owner(target, '/api/status')).body.harnesses as Array<{ machineId: string }>;
  expect(listed.some((fact) => fact.machineId === machineId)).toBe(true);
  const uncaptured = await fetch(`${target.url}/members/uncaptured`, {
    method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ rootKey, label: 'scratch', reason: 'outside_folders' }),
  });
  expect(uncaptured.status).toBe(200);
  // The machine's worker polls for work, which records its contact.
  const work = await fetch(`${target.url}/worker/claim`, {
    method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ harnesses: [offeredHarness('codex')], capabilities: WORKER_CAPABILITIES }),
  });
  expect(work.status).toBe(200);
  const machineSetting = await owner(target, `/api/machines/${machineId}/settings/${MACHINE_LEAF}`, { method: 'PUT', body: JSON.stringify({ value: ['docs/plans', 'notes'] }) });
  expect(machineSetting.status).toBe(200);
  return { setting: { leaf: SETTING_LEAF, revision: await revision() }, projectLeaf: CURATION_DAILY_LIMIT_LEAF, machine: { machineId, token, rootKey } };
}

/** What the owner and the machine read of the seeded settings and machines, and the refusal a stale revision meets. */
export async function observeMachines(target: RouteTarget, seed: MachinesSeed): Promise<Record<string, unknown>> {
  const settings = await owner(target, '/api/settings');
  const machines = await owner(target, '/api/machines');
  const machineSettings = await owner(target, `/api/machines/${seed.machine.machineId}/settings`);
  const uncaptured = await owner(target, '/api/uncaptured');
  return {
    setting: [settings.status, pick(settings.body.leaves.find((row: { leaf: string }) => row.leaf === seed.setting.leaf), ['leaf', 'value', 'revision', 'updatedBy'])],
    // A Project setting is read back as the revision a stale write meets.
    projectSetting: await owner(target, `/api/settings/${seed.projectLeaf}`, { method: 'PUT', headers: { 'if-match': '0' }, body: JSON.stringify({ project_id: target.projectId, value: 9 }) }),
    machine: [machines.status, (machines.body.machines ?? []).filter((row: { machineId: string }) => row.machineId === seed.machine.machineId)
      .map((row: { member?: { id: string } }) => ({ ...pick(row, ['machineId', 'name', 'standing', 'credentialCount', 'lastContactAt', 'offers']), member: row.member?.id }))],
    machineSettings: [machineSettings.status, (machineSettings.body.leaves ?? []).map((leaf: unknown) => pick(leaf, ['leaf', 'configured', 'value', 'revision']))],
    uncaptured: [uncaptured.status, (uncaptured.body.items ?? []).filter((item: { machineId: string }) => item.machineId === seed.machine.machineId).map((item: unknown) => pick(item, ['machineId', 'rootKey', 'label', 'reason']))],
    staleRevision: await owner(target, `/api/settings/${seed.setting.leaf}`, { method: 'PUT', headers: { 'if-match': '0' }, body: JSON.stringify({ value: 4 }) }),
  };
}
