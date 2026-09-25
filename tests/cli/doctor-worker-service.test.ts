/**
 * `myco doctor` reports the worker login service for every Deployment the
 * member home holds a membership of. A Deployment nothing on this machine
 * serves is a warning: its runs wait in the queue until a worker attaches.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWorkerServices } from '@myco/cli/doctor.js';
import { ensureWorkerService, type WorkerServiceDeps } from '@myco/cli/worker-service.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { holdWorkerInstance } from '@myco/runner/instance.js';

let scratch: string;
let deps: WorkerServiceDeps;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-worker-'));
  const home = path.join(scratch, 'home');
  const mycoHome = path.join(home, '.myco');
  fs.mkdirSync(mycoHome, { recursive: true });
  const loaded = new Set<string>();
  deps = {
    mycoHome, home, platform: 'linux', binaryPath: path.join(mycoHome, 'bin', 'myco'), lockDir: path.join(scratch, 'locks'),
    detect: () => [{ id: 'claude-code', installed: true, authenticated: true }], harnessDirs: () => [], ownDeploymentUrls: async () => [],
    runner: (command, args) => {
      const line = [command, ...args].join(' ');
      if (line.startsWith('systemctl --user enable')) loaded.add(args.at(-1)!);
      if (line.startsWith('systemctl --user is-enabled')) return { status: loaded.has(args.at(-1)!) ? 0 : 1 };
      return { status: 0 };
    },
  };
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe('the doctor worker service check', () => {
  it('reports nothing for a home that holds no membership', async () => {
    expect(await checkWorkerServices(scratch, deps)).toEqual([]);
  });

  it('warns when nothing serves a Deployment, and is ok once a worker holds it', async () => {
    writeDeploymentMembership({ serverUrl: 'https://myco.example', token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: deps.mycoHome });
    const [missing] = await checkWorkerServices(scratch, deps);
    expect(missing).toMatchObject({ name: 'Worker service', status: 'warn' });
    expect(missing!.detail).toMatch(/^https:\/\/myco\.example: not installed.*myco worker install/);

    expect((await ensureWorkerService('https://myco.example', deps)).kind).toBe('installed');
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
