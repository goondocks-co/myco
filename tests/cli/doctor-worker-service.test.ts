/**
 * `myco doctor` reports the worker login service for every Deployment the
 * member home holds a membership of. A Deployment nothing on this machine
 * serves is a healthy member-only machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWorkerServices } from '@myco/cli/doctor.js';
import { type WorkerServiceDeps } from '@myco/cli/worker-service.js';
import { installWorkerService } from '@myco/runner/service.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { holdWorkerInstance } from '@myco/runner/instance.js';
import { recordingPlatform } from '../member/helpers/service-platform.js';

let scratch: string;
let deps: WorkerServiceDeps;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-worker-'));
  const home = path.join(scratch, 'home');
  const mycoHome = path.join(home, '.myco');
  fs.mkdirSync(mycoHome, { recursive: true });
  deps = {
    mycoHome, home, platform: 'linux', binaryPath: path.join(mycoHome, 'bin', 'myco'), lockDir: path.join(scratch, 'locks'),
    detect: () => [{ id: 'claude-code', installed: true, authenticated: true }], harnessDirs: () => [], ownDeploymentUrls: async () => [],
    admission: async () => 'admitted', runner: recordingPlatform().runner,
  };
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe('the doctor worker service check', () => {
  it('names explicit runner opt-in on the native server host', async () => {
    const checks = await checkWorkerServices(scratch, { ...deps, ownDeploymentUrls: async () => ['http://127.0.0.1:8787'] });
    expect(checks).toContainEqual(expect.objectContaining({ name: 'Agent execution', status: 'ok', detail: expect.stringContaining('myco runner register http://127.0.0.1:8787') }));
    expect(checks[0]!.detail).toContain('this machine or another');
  });
  it('reports nothing for a home that holds no membership', async () => {
    expect(await checkWorkerServices(scratch, deps)).toEqual([]);
  });

  it('treats member-only execution as healthy and reports an existing worker', async () => {
    writeDeploymentMembership({ serverUrl: 'https://myco.example', token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: deps.mycoHome });
    const [missing] = await checkWorkerServices(scratch, deps);
    expect(missing).toMatchObject({ name: 'Worker service', status: 'ok' });
    expect(missing!.detail).toContain('no executor on this machine (member only)');
    expect(missing!.detail).not.toContain('install');

    installWorkerService({ ...deps, mycoHome: deps.mycoHome!, home: deps.home!, binaryPath: deps.binaryPath!, serverUrl: 'https://myco.example' }, [], { runner: deps.runner });
    const held = holdWorkerInstance(deps.lockDir!, ['https://myco.example']);
    try {
      const [serving] = await checkWorkerServices(scratch, deps);
      expect(serving).toMatchObject({ status: 'ok' });
      expect(serving!.detail).toContain('running at login');
    } finally {
      if (held.held) held.release();
    }
  });
});
