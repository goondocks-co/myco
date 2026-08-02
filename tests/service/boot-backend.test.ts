/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BootServiceManager,
  SandboxedBootScopeError,
  type ServiceCommandRunner,
} from '@myco/service/boot-backend.js';
import { getScopedServiceManager, supportsScope, type LoginctlRunner } from '@myco/service/scoped.js';
import { SERVICE_UNIT_DIR_ENV } from '@myco/service/paths.js';
import { renderLaunchdPlist } from '@myco/service/launchd-plist.js';
import type { ServiceSpec } from '@myco/service/types.js';

const LABEL = 'co.goondocks.myco-boot-test';

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    label: LABEL,
    variant: 'prod',
    executable: '/usr/local/bin/myco',
    args: ['daemon'],
    workingDir: '/tmp',
    env: {},
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/err.log',
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
    scope: { startAt: 'boot', runAs: 'root' },
    ...overrides,
  };
}

function fakeRunner(calls: string[][]): ServiceCommandRunner {
  return {
    async run(command, args) {
      calls.push([command, ...args]);
      return { stdout: '', exitCode: 0 };
    },
  };
}

function tmpDirs(): { unitDir: string; stagingDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-boot-backend-'));
  const unitDir = path.join(root, 'daemons');
  const stagingDir = path.join(root, 'staging');
  fs.mkdirSync(unitDir, { recursive: true });
  return { unitDir, stagingDir };
}

const savedSandbox = process.env[SERVICE_UNIT_DIR_ENV];
afterEach(() => {
  if (savedSandbox === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
  else process.env[SERVICE_UNIT_DIR_ENV] = savedSandbox;
});

describe('BootServiceManager', () => {
  it('installs via staged sudo copy + system-domain bootstrap, and is idempotent WITHOUT sudo on a content match', async () => {
    delete process.env[SERVICE_UNIT_DIR_ENV];
    const calls: string[][] = [];
    const { unitDir, stagingDir } = tmpDirs();
    const runner: ServiceCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        // The fake "sudo install" actually lands the staged file so the
        // idempotence read has real bytes to compare.
        if (args[0] === 'install') {
          fs.copyFileSync(args[args.length - 2]!, args[args.length - 1]!);
        }
        return { stdout: '', exitCode: 0 };
      },
    };
    const mgr = new BootServiceManager({ runner, platform: 'darwin', unitDir, stagingDir });

    const first = await mgr.install(spec());
    expect(first).toEqual({ changed: true, supervisorReloaded: true });
    expect(calls.some((c) => c[0] === 'sudo' && c[1] === 'launchctl' && c[2] === 'bootstrap')).toBe(true);

    calls.length = 0;
    const second = await mgr.install(spec());
    expect(second).toEqual({ changed: false, supervisorReloaded: false });
    // The whole point: a no-op re-install never elevates.
    expect(calls).toEqual([]);
  });

  it('GATE (spec R-B3): every mutation THROWS under a sandboxed unit dir — never a success-shaped no-op', async () => {
    const calls: string[][] = [];
    const { unitDir, stagingDir } = tmpDirs();
    const mgr = new BootServiceManager({ runner: fakeRunner(calls), platform: 'darwin', unitDir, stagingDir });
    process.env[SERVICE_UNIT_DIR_ENV] = unitDir;

    await expect(mgr.install(spec())).rejects.toThrow(SandboxedBootScopeError);
    await expect(mgr.uninstall(LABEL)).rejects.toThrow(SandboxedBootScopeError);
    await expect(mgr.start(LABEL)).rejects.toThrow(SandboxedBootScopeError);
    await expect(mgr.stop(LABEL)).rejects.toThrow(SandboxedBootScopeError);
    await expect(mgr.restart(LABEL)).rejects.toThrow(SandboxedBootScopeError);
    // Zero runner invocations: the refusal happens before any shell-out.
    expect(calls).toEqual([]);
  });

  it('refuses a login-scoped (or scope-less) spec — the facade owns dispatch', async () => {
    delete process.env[SERVICE_UNIT_DIR_ENV];
    const { unitDir, stagingDir } = tmpDirs();
    const mgr = new BootServiceManager({ runner: fakeRunner([]), platform: 'darwin', unitDir, stagingDir });
    await expect(mgr.install(spec({ scope: undefined }))).rejects.toThrow(/refuses a login-scoped spec/);
  });

  it("status degrades to running:'unknown' when the system domain is unreadable — never false", async () => {
    delete process.env[SERVICE_UNIT_DIR_ENV];
    const { unitDir, stagingDir } = tmpDirs();
    fs.writeFileSync(path.join(unitDir, `${LABEL}.plist`), renderLaunchdPlist(spec()), 'utf-8');
    const refusingRunner: ServiceCommandRunner = {
      async run() { return { stdout: 'Could not find service', exitCode: 1 }; },
    };
    const mgr = new BootServiceManager({ runner: refusingRunner, platform: 'darwin', unitDir, stagingDir });

    const status = await mgr.status(LABEL);
    expect(status.installed).toBe(true);
    expect(status.running).toBe('unknown');
  });

  it('inspect reads the on-disk unit unprivileged', async () => {
    delete process.env[SERVICE_UNIT_DIR_ENV];
    const { unitDir, stagingDir } = tmpDirs();
    fs.writeFileSync(path.join(unitDir, `${LABEL}.plist`), renderLaunchdPlist(spec()), 'utf-8');
    const mgr = new BootServiceManager({ runner: fakeRunner([]), platform: 'darwin', unitDir, stagingDir });

    expect(await mgr.inspect(LABEL)).toEqual({ executable: '/usr/local/bin/myco', args: ['daemon'] });
  });
});

describe('getScopedServiceManager — the §13 dispatch table', () => {
  it('login scope (or no scope) returns the existing platform manager untouched', () => {
    const login = getScopedServiceManager({ platform: 'darwin' });
    expect(login.platformName).toBe('launchd');
    const explicit = getScopedServiceManager({
      platform: 'linux',
      scope: { startAt: 'login', runAs: 'invoking-user' },
    });
    expect(explicit.platformName).toBe('systemd --user');
  });

  it('win32 boot returns the unsupported-SHAPED backend: reads benign, mutations throw', async () => {
    const mgr = getScopedServiceManager({ platform: 'win32', scope: { startAt: 'boot', runAs: 'invoking-user' } });
    expect(mgr.supported).toBe(false);
    expect(await mgr.isInstalled(LABEL)).toBe(false);
    expect((await mgr.status(LABEL)).installed).toBe(false);
    await expect(mgr.install(spec())).rejects.toThrow(/not supported/);
  });

  it('GATE (§13.13 gate 5): Linux boot+invoking-user enables lingering even when the unit bytes are UNCHANGED', async () => {
    const loginctlCalls: string[][] = [];
    const disclosures: string[] = [];
    const loginctl: LoginctlRunner = {
      async run(args) {
        loginctlCalls.push(args);
        if (args[0] === 'show-user') return { stdout: 'Linger=no', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
      },
    };
    expect(getScopedServiceManager({
      platform: 'linux',
      scope: { startAt: 'boot', runAs: 'invoking-user' },
      loginctl,
    }).platformName).toBe('systemd --user + linger');

    // Drive install through the wrapper with a stubbed inner via a unit dir
    // we own — the inner manager is the REAL systemd login backend, so give
    // it a sandbox dir; its own neutered runner makes install a pure file
    // write, which is exactly the content-match-early-return shape gate 5
    // guards.
    const { unitDir } = tmpDirs();
    process.env[SERVICE_UNIT_DIR_ENV] = unitDir;
    const inner = getScopedServiceManager({
      platform: 'linux',
      scope: { startAt: 'boot', runAs: 'invoking-user' },
      loginctl,
      disclose: (message) => { disclosures.push(message); },
    });
    await inner.install(spec({ scope: { startAt: 'boot', runAs: 'invoking-user' } }));
    const firstEnables = loginctlCalls.filter((c) => c[0] === 'enable-linger').length;
    expect(firstEnables).toBe(1);
    expect(disclosures.some((d) => d.includes('machine-wide'))).toBe(true);

    // Second install: unit bytes identical (content-match early return fires
    // in the inner manager) — the linger check must STILL run.
    loginctlCalls.length = 0;
    await inner.install(spec({ scope: { startAt: 'boot', runAs: 'invoking-user' } }));
    expect(loginctlCalls.some((c) => c[0] === 'show-user')).toBe(true);
    // The fake still reports Linger=no, so the unchanged install must have
    // re-run enable-linger — the content-match early return did NOT swallow
    // the linger half (minor 18's tightening).
    expect(loginctlCalls.filter((c) => c[0] === 'enable-linger').length).toBe(1);
  });

  it('supportsScope matrix: per-cell probes', async () => {
    const okRunner: ServiceCommandRunner = { async run() { return { stdout: '', exitCode: 0 }; } };
    const noRunner: ServiceCommandRunner = { async run() { return { stdout: 'no sudo', exitCode: 1 }; } };
    const loginctlYes: LoginctlRunner = { async run() { return { stdout: '', exitCode: 0 }; } };
    const loginctlNo: LoginctlRunner = { async run() { return { stdout: '', exitCode: 127 }; } };

    expect((await supportsScope({ startAt: 'login', runAs: 'invoking-user' }, { platform: 'darwin' })).supported).toBe(true);
    expect((await supportsScope({ startAt: 'login', runAs: 'root' }, { platform: 'darwin' })).supported).toBe(false);
    expect((await supportsScope({ startAt: 'boot', runAs: 'root' }, { platform: 'darwin', bootOverrides: { runner: okRunner } })).supported).toBe(true);
    expect((await supportsScope({ startAt: 'boot', runAs: 'root' }, { platform: 'darwin', bootOverrides: { runner: noRunner } })).supported).toBe(false);
    expect((await supportsScope({ startAt: 'boot', runAs: 'invoking-user' }, { platform: 'linux', loginctl: loginctlYes })).supported).toBe(true);
    expect((await supportsScope({ startAt: 'boot', runAs: 'invoking-user' }, { platform: 'linux', loginctl: loginctlNo })).supported).toBe(false);
    expect((await supportsScope({ startAt: 'boot', runAs: 'invoking-user' }, { platform: 'win32' })).supported).toBe(false);
  });
});

describe('GATE (spec R-B1): restart/recovery resolves the OWNING domain', () => {
  it('a home whose unit exists ONLY in the boot domain resolves THE BOOT MANAGER — the mutant that deletes the probe goes red here', async () => {
    const { findInstalledServiceLabel } = await import('@myco/daemon/api/restart.js');
    const { serviceLabel } = await import('@myco/service/labels.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rb1-home-'));
    const label = serviceLabel(home);
    // Login manager: genuinely empty dir — no unit.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rb1-login-'));
    const { LaunchdServiceManager } = await import('@myco/service/launchd.js');
    const loginMgr = new LaunchdServiceManager({ agentsDir: emptyDir });
    // Boot manager: a REAL BootServiceManager over an injected unit dir that
    // DOES contain the unit (the seam blocker 2 demanded — without it no
    // fixture can exist and removing the probe leaves everything green).
    const { unitDir, stagingDir } = tmpDirs();
    fs.writeFileSync(path.join(unitDir, `${label}.plist`), renderLaunchdPlist(spec({ label })), 'utf-8');
    const bootManager = new BootServiceManager({
      runner: { async run() { return { stdout: '', exitCode: 1 }; } },
      platform: 'darwin',
      unitDir,
      stagingDir,
    });

    const found = await findInstalledServiceLabel(loginMgr, home, { bootManager });
    expect(found).not.toBeNull();
    expect(found!.manager).toBe(bootManager);
    expect(found!.label).toBe(label);
    // Unprivileged status read refused → 'unknown', never a fabricated false.
    expect(found!.status.installed).toBe(true);
    expect(found!.status.running).toBe('unknown');
  });

  it('no unit anywhere resolves null (the real boot dir never contains a home-suffixed label)', async () => {
    if (process.platform !== 'darwin') return;
    const { findInstalledServiceLabel } = await import('@myco/daemon/api/restart.js');
    const { serviceLabel } = await import('@myco/service/labels.js');
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rb1-login2-'));
    const { LaunchdServiceManager } = await import('@myco/service/launchd.js');
    const loginMgr = new LaunchdServiceManager({ agentsDir: emptyDir });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rb1-home2-'));
    expect(await findInstalledServiceLabel(loginMgr, home)).toBeNull();
    expect(serviceLabel(home)).not.toBe('co.goondocks.myco');
  });

  it('the resolver returns the manager that found the unit (login domain)', async () => {
    const { findInstalledServiceLabel } = await import('@myco/daemon/api/restart.js');
    const { serviceLabel } = await import('@myco/service/labels.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rb1-home2-'));
    const label = serviceLabel(home);
    const fakeLogin = {
      supported: true,
      platformName: 'fake-login',
      async isInstalled(l: string) { return l === label; },
      async inspect() { return null; },
      async install() { return { changed: false, supervisorReloaded: false }; },
      async uninstall() {},
      async start() {},
      async stop() {},
      async restart() {},
      restartShellCommand() { return 'true'; },
      async status() {
        return { installed: true, running: true as const, pid: 42, lastExitCode: null, unitPath: null };
      },
    };
    const found = await findInstalledServiceLabel(fakeLogin, home);
    expect(found?.manager).toBe(fakeLogin);
    expect(found?.status.pid).toBe(42);
  });
});

describe('GATE (§13.13 gate 6): transition is one operation; failed install-new restores the OLD unit', () => {
  function fakeManager(state: { units: Map<string, string>; started: Set<string> }, opts: { failInstall?: boolean } = {}) {
    return {
      supported: true,
      platformName: 'fake',
      async isInstalled(l: string) { return state.units.has(l); },
      async inspect() { return null; },
      async install(s: ServiceSpec) {
        if (opts.failInstall) throw new Error('bootstrap refused');
        state.units.set(s.label, JSON.stringify(s.scope ?? null));
        return { changed: true, supervisorReloaded: true };
      },
      async uninstall(l: string) { state.units.delete(l); state.started.delete(l); },
      async start(l: string) { state.started.add(l); },
      async stop(l: string) { state.started.delete(l); },
      async restart() {},
      restartShellCommand() { return 'true'; },
      async status(l: string) {
        return {
          installed: state.units.has(l),
          running: state.started.has(l) as boolean | 'unknown',
          pid: null,
          lastExitCode: null,
          unitPath: null,
        };
      },
    };
  }

  it('success path leaves exactly ONE unit (the target scope) and starts it', async () => {
    const { transitionServiceScope } = await import('@myco/service/scoped.js');
    const oldState = { units: new Map([[LABEL, 'old-bytes']]), started: new Set([LABEL]) };
    const newState = { units: new Map<string, string>(), started: new Set<string>() };
    const unitFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-gate6-')), 'unit.plist');
    fs.writeFileSync(unitFile, 'OLD UNIT BYTES', 'utf-8');

    await transitionServiceScope({
      label: LABEL,
      spec: spec({ scope: undefined }),
      from: { manager: fakeManager(oldState), scope: { startAt: 'login', runAs: 'invoking-user' }, unitPath: unitFile },
      to: { manager: fakeManager(newState), scope: { startAt: 'boot', runAs: 'invoking-user' } },
      runner: { async run() { return { stdout: '', exitCode: 0 }; } },
      platform: 'darwin',
    });

    expect(oldState.units.size).toBe(0);
    expect(newState.units.get(LABEL)).toContain('boot');
    expect(newState.started.has(LABEL)).toBe(true);
  });

  it('failed install-new RESTORES the old unit bytes, re-registers, starts it, and reports loudly', async () => {
    const { transitionServiceScope } = await import('@myco/service/scoped.js');
    const oldState = { units: new Map([[LABEL, 'x']]), started: new Set([LABEL]) };
    const newState = { units: new Map<string, string>(), started: new Set<string>() };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-gate6b-'));
    const unitFile = path.join(dir, 'unit.plist');
    fs.writeFileSync(unitFile, 'HAND-EDITED OLD BYTES', 'utf-8');
    const registration: string[][] = [];
    const oldMgr = fakeManager(oldState);
    // uninstall removes the on-disk unit too, like the real managers.
    const origUninstall = oldMgr.uninstall.bind(oldMgr);
    oldMgr.uninstall = async (l: string) => { await origUninstall(l); fs.rmSync(unitFile, { force: true }); };

    await expect(transitionServiceScope({
      label: LABEL,
      spec: spec({ scope: undefined }),
      from: { manager: oldMgr, scope: { startAt: 'login', runAs: 'invoking-user' }, unitPath: unitFile },
      to: { manager: fakeManager(newState, { failInstall: true }), scope: { startAt: 'boot', runAs: 'invoking-user' } },
      runner: { async run(command, args) { registration.push([command, ...args]); return { stdout: '', exitCode: 0 }; } },
      platform: 'darwin',
    })).rejects.toThrow(/RESTORED and started/);

    // Byte-faithful: the hand-edited content is back, NOT a fresh render.
    expect(fs.readFileSync(unitFile, 'utf-8')).toBe('HAND-EDITED OLD BYTES');
    // Re-registered with the login supervisor and started.
    expect(registration.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true);
    expect(oldState.started.has(LABEL)).toBe(true);
    expect(newState.units.size).toBe(0);
  });
});

describe('resolveObservedScope — file existence across both domains + the Linux linger cell', () => {
  it('reads login/boot/both/none from the unit dirs', async () => {
    const { resolveObservedScope } = await import('@myco/service/scoped.js');
    const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-obs-login-'));
    const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-obs-boot-'));
    const opts = { platform: 'darwin' as const, loginUnitDir: loginDir, bootUnitDir: bootDir };

    expect(await resolveObservedScope(LABEL, opts)).toBe('none');
    fs.writeFileSync(path.join(loginDir, `${LABEL}.plist`), 'x', 'utf-8');
    expect(await resolveObservedScope(LABEL, opts)).toBe('login');
    fs.writeFileSync(path.join(bootDir, `${LABEL}.plist`), 'x', 'utf-8');
    expect(await resolveObservedScope(LABEL, opts)).toBe('both');
    fs.rmSync(path.join(loginDir, `${LABEL}.plist`));
    expect(await resolveObservedScope(LABEL, opts)).toBe('boot');
  });

  it('GATE (spec M7): a lingering Linux user unit observes as BOOT — no permanent doctor warn, no destructive reinstall loop', async () => {
    const { resolveObservedScope } = await import('@myco/service/scoped.js');
    const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-obs-linger-'));
    const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-obs-linger-boot-'));
    fs.writeFileSync(path.join(loginDir, `${LABEL}.service`), 'x', 'utf-8');
    const lingering: LoginctlRunner = { async run() { return { stdout: 'Linger=yes', exitCode: 0 }; } };
    const notLingering: LoginctlRunner = { async run() { return { stdout: 'Linger=no', exitCode: 0 }; } };

    expect(await resolveObservedScope(LABEL, {
      platform: 'linux', loginUnitDir: loginDir, bootUnitDir: bootDir, loginctl: lingering,
    })).toBe('boot');
    expect(await resolveObservedScope(LABEL, {
      platform: 'linux', loginUnitDir: loginDir, bootUnitDir: bootDir, loginctl: notLingering,
    })).toBe('login');
  });
});

describe('GATE (round-2 B1): upgrade restart routes through the OWNING manager', () => {
  function stubManager(name: string, calls: string[]): import('@myco/service/types.js').ServiceManager {
    return {
      supported: true,
      platformName: name,
      async isInstalled() { return false; },
      async inspect() { return null; },
      async install() { return { changed: false, supervisorReloaded: false }; },
      async uninstall() { calls.push(`${name}:uninstall`); },
      async start() { calls.push(`${name}:start`); },
      async stop() { calls.push(`${name}:stop`); },
      async restart() { calls.push(`${name}:restart`); },
      restartShellCommand() { return 'true'; },
      async status() {
        return { installed: false, running: false as const, pid: null, lastExitCode: null, unitPath: null };
      },
    };
  }

  it('a boot-owned label restarts via the BOOT manager, never the login manager — the reverted-chokepoint mutant goes red here', async () => {
    const { restart } = await import('@myco/upgrade/orchestrator.js');
    const calls: string[] = [];
    const loginMgr = stubManager('login', calls);
    const bootMgr = stubManager('boot', calls);
    let spawned: string[][] = [];

    await restart(
      {
        getServiceManager: () => loginMgr,
        runNpm: async () => ({ ok: true, output: '' }),
        spawnDetached: (bin: string, args: string[]) => { spawned.push([bin, ...args]); },
        runFanout: async () => {},
        probeHealth: async () => null,
        probeDaemonState: () => null,
        sleep: async () => {},
        // The spec R-B1 seam: the boot domain owns this label.
        findInstalledService: async () => ({
          label: 'co.goondocks.myco',
          status: { installed: true, running: 'unknown' as const, pid: null, lastExitCode: null, unitPath: null },
          manager: bootMgr,
        }),
      },
      'co.goondocks.myco',
      '/usr/local/bin/myco',
      '/tmp',
    );

    expect(calls).toEqual(['boot:restart']);
    expect(spawned).toEqual([]);
  });
});

describe('round-3 follow-ups', () => {
  it('the CLI refuses a root boot install BEFORE any manager or preflight call (source-order pin)', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'packages/myco/src/cli/service.ts'),
      'utf-8',
    );
    const refusal = source.indexOf('Refusing to install a boot-scoped service as root');
    const preflight = source.indexOf('await supportsScope(targetScope)');
    const transition = source.indexOf('transitionServiceScope({');
    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(refusal);
    expect(transition).toBeGreaterThan(refusal);
  });

  it('GATE (M4): a failed sudo rm during uninstall THROWS — never "✓ Unregistered" over a surviving root unit', async () => {
    delete process.env[SERVICE_UNIT_DIR_ENV];
    const { unitDir, stagingDir } = tmpDirs();
    fs.writeFileSync(path.join(unitDir, `${LABEL}.plist`), 'unit', 'utf-8');
    const runner: ServiceCommandRunner = {
      async run(_command, args) {
        if (args[0] === 'rm') return { stdout: 'rm: permission denied', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
      },
    };
    const mgr = new BootServiceManager({ runner, platform: 'darwin', unitDir, stagingDir });
    await expect(mgr.uninstall(LABEL)).rejects.toThrow(/sudo rm/);
  });
});
