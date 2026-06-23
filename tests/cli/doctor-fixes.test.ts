import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeServiceManager } from '../helpers/fake-service-manager.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';
import { serviceLabel } from '@myco/service/labels';

// Service-manager calls must NEVER hit real launchctl/systemctl from a
// test — route everything to the shared fake.
let fakeServiceManager = new FakeServiceManager();
mock.module('@myco/service/manager.js', () => ({
  getServiceManager: () => fakeServiceManager,
}));

// Drive the cli/service.js seams per-scenario through mutable handles.
let refusal: string | null = null;
let resolvedExecutable = '';
mock.module('@myco/cli/service.js', () => ({
  resolveServiceExecutable: () => resolvedExecutable,
  assertSafeServiceMutation: () => refusal,
}));

// Capture the executable handed to buildServiceSpec — the real builder
// throws on bun/node basenames (which process.execPath is under the test
// runner), and the fallback contract is exactly what these tests assert.
// Identity is the home now, not a variant.
const builtSpecs: Array<{ mycoHome?: string; executable: string }> = [];
mock.module('@myco/service/spec-builder.js', () => ({
  buildServiceSpec: (opts: { mycoHome?: string; executable: string }) => {
    builtSpecs.push({ mycoHome: opts.mycoHome, executable: opts.executable });
    return {
      label: 'co.goondocks.myco',
      executable: opts.executable,
      args: ['daemon'],
      env: {},
    };
  },
}));

describe('DOCTOR_FIXERS service-reinstall', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-doctor-fixes-');
    fakeServiceManager = new FakeServiceManager();
    refusal = null;
    resolvedExecutable = '';
    builtSpecs.length = 0;
  });

  afterEach(() => {
    sandbox.restore();
  });

  async function runServiceReinstall(): Promise<string[]> {
    const { DOCTOR_FIXERS } = await import('@myco/cli/doctor-fixes');
    const { createDaemonStateAuthority } = await import('@myco/daemon/daemon-state-authority.js');
    const { resolveDaemonServiceState } = await import('@myco/daemon/service-state.js');
    const vaultDir = '/tmp/unused';
    const ctx = {
      vaultDir,
      authority: createDaemonStateAuthority(
        resolveDaemonServiceState(vaultDir, { env: process.env }),
        { info: () => {} },
      ),
    };
    return DOCTOR_FIXERS['service-reinstall'](ctx, [{
      name: 'Service',
      status: 'fail',
      detail: 'co.goondocks.myco executable not found',
      fixable: true,
      fixId: 'service-reinstall',
    }]);
  }

  it('stops at the safety refusal without touching the service manager', async () => {
    refusal = 'Refusing to install the *prod* service from a dev-build binary';
    const actions = await runServiceReinstall();

    expect(actions).toEqual([refusal]);
    expect(fakeServiceManager.installCalls).toHaveLength(0);
    expect(fakeServiceManager.startCalls).toHaveLength(0);
    expect(builtSpecs).toHaveLength(0);
  });

  it('falls back to process.execPath when the resolved executable is missing, then installs and starts', async () => {
    resolvedExecutable = path.join(os.tmpdir(), `myco-gone-${Date.now()}`, 'myco');
    expect(fs.existsSync(resolvedExecutable)).toBe(false);

    const actions = await runServiceReinstall();

    expect(builtSpecs).toHaveLength(1);
    expect(builtSpecs[0]!.executable).toBe(process.execPath);
    expect(builtSpecs[0]!.mycoHome).toBe(sandbox.mycoHome);
    expect(fakeServiceManager.installCalls).toHaveLength(1);
    expect(fakeServiceManager.installOptions[0]).toEqual({ force: true });
    const label = serviceLabel(sandbox.mycoHome);
    expect(fakeServiceManager.startCalls).toEqual([label]);
    expect(actions).toEqual([`Reinstalled ${label} service and started it`]);
  });

  it('reports a throwing service manager as a failed action instead of escaping fix()', async () => {
    // A manager whose install throws must surface as an action string —
    // an escaped throw would discard other fixers' reports and skip the
    // post-fix recheck.
    fakeServiceManager.install = async () => {
      throw new Error('launchctl bootstrap failed: Input/output error');
    };

    const actions = await runServiceReinstall();

    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain('Service reinstall failed');
    expect(actions[0]).toContain('launchctl bootstrap failed: Input/output error');
    expect(fakeServiceManager.startCalls).toHaveLength(0);
  });

  it('uses the resolved executable directly when it exists on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-fixes-bin-'));
    try {
      resolvedExecutable = path.join(dir, 'myco');
      fs.writeFileSync(resolvedExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const actions = await runServiceReinstall();

      expect(builtSpecs).toHaveLength(1);
      expect(builtSpecs[0]!.executable).toBe(resolvedExecutable);
      expect(fakeServiceManager.installCalls).toHaveLength(1);
      expect(actions).toEqual([`Reinstalled ${serviceLabel(sandbox.mycoHome)} service and started it`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
