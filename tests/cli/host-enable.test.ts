import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostDisable, hostEnable, type HostEnableDeps } from '@myco/team-host/overlay.js';
import { headscaleAssetName, headscaleAssetUrl, HEADSCALE_VERSION, type BinaryFetcher, type CommandRunner } from '@myco/team-host/binaries.js';
import { HEADSCALE_SERVICE_LABEL } from '@myco/team-host/system-service.js';
import { readHostState } from '@myco/team-host/state.js';
import { loadMachineConfig } from '@myco/config/loader.js';
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';
import type { ServiceManager, ServiceStatus, InstallResult } from '@myco/service/types.js';

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const bytes = (s: string) => new TextEncoder().encode(s);
const HEADSCALE_BYTES = bytes('#!/fake headscale\n');
const TARGET = { os: 'darwin' as const, arch: 'arm64' as const };

function fetcher(): BinaryFetcher {
  const routes: Record<string, Uint8Array> = {
    [headscaleAssetUrl(TARGET)]: HEADSCALE_BYTES,
    [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
      bytes(`${sha256(HEADSCALE_BYTES)}  ${headscaleAssetName(TARGET)}\n`),
  };
  return { async download(url) { const b = routes[url]; if (!b) throw new Error(`404 ${url}`); return b; } };
}

/** Records argv; performs the fs effects a real sudo install/rm + tailscaled
 *  install-system-daemon would, so idempotency checks reflect reality. */
function overlayRunner(launchDaemonsDir: string): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const tailscaledPlist = path.join(launchDaemonsDir, 'com.tailscale.tailscaled.plist');
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push([command, ...args]);
      const joined = [command, ...args].join(' ');
      if (command === 'brew' && args[0] === 'list') return { stdout: 'tailscale', exitCode: 0 };
      if (args[0] === 'version') {
        return command.endsWith('headscale')
          ? { stdout: `v${HEADSCALE_VERSION}\n`, exitCode: 0 }
          : { stdout: '1.98.8\n', exitCode: 0 };
      }
      if (joined.includes('users create')) return { stdout: '{"id":"1","name":"myco-host"}', exitCode: 0 };
      if (joined.includes('users list')) return { stdout: '[{"id":"1","name":"myco-host"}]', exitCode: 0 };
      if (joined.includes('preauthkeys create')) return { stdout: '{"key":"onetimekeyvalue123"}', exitCode: 0 };
      if (joined.includes('nodes list')) return { stdout: '[{"id":"9","name":"testhost"}]', exitCode: 0 };
      if (command === 'sudo' && args[0] === 'install') {
        fs.mkdirSync(path.dirname(args[args.length - 1]), { recursive: true });
        fs.copyFileSync(args[args.length - 2], args[args.length - 1]);
      }
      if (command === 'sudo' && args[0] === 'rm') fs.rmSync(args[args.length - 1], { force: true });
      if (joined.includes('install-system-daemon')) { fs.mkdirSync(launchDaemonsDir, { recursive: true }); fs.writeFileSync(tailscaledPlist, 'plist'); }
      if (joined.includes('uninstall-system-daemon')) fs.rmSync(tailscaledPlist, { force: true });
      return { stdout: '', exitCode: 0 };
    },
  };
  return { runner, calls };
}

function fakeManager(): { manager: ServiceManager; restarts: string[] } {
  const restarts: string[] = [];
  const manager: ServiceManager = {
    supported: true, platformName: 'launchd',
    isInstalled: async () => true,
    install: async (): Promise<InstallResult> => ({ changed: false, supervisorReloaded: false }),
    uninstall: async () => {}, start: async () => {}, stop: async () => {},
    restart: async (l) => { restarts.push(l); },
    restartShellCommand: (l) => l,
    status: async (): Promise<ServiceStatus> => ({ installed: true, running: true, pid: 1, lastExitCode: null, unitPath: null }),
  };
  return { manager, restarts };
}

describe('hostEnable / hostDisable orchestration', () => {
  let tmp: string;
  let launchDaemonsDir: string;
  let brewDir: string;
  let prevMyco: string | undefined;
  let prevTeam: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-enable-'));
    launchDaemonsDir = path.join(tmp, 'LaunchDaemons');
    brewDir = path.join(tmp, 'brew');
    fs.mkdirSync(brewDir, { recursive: true });
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    prevMyco = process.env.MYCO_HOME;
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = path.join(tmp, 'myco');
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team');
    fs.mkdirSync(process.env.MYCO_HOME, { recursive: true });
  });
  afterEach(() => {
    if (prevMyco === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMyco;
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function deps(overrides: Partial<HostEnableDeps> = {}): { deps: HostEnableDeps; calls: string[][]; restarts: string[] } {
    const { runner, calls } = overlayRunner(launchDaemonsDir);
    const { manager, restarts } = fakeManager();
    const base: HostEnableDeps = {
      fetcher: fetcher(),
      runner,
      platform: 'darwin',
      arch: 'arm64',
      serviceManager: manager,
      brewBinDirs: [brewDir],
      systemCtx: { launchDaemonsDir, stagingDir: path.join(tmp, 'staging') },
      resolveNodeId: async () => 'node-9',
      verifyOverlayListener: async () => true,
      logger: () => {},
      ...overrides,
    };
    return { deps: base, calls, restarts };
  }

  it('stands up the overlay end-to-end: services, join, host_serve wired, state recorded', async () => {
    // Not joined yet, then joined after `tailscale up`.
    const ips = [null as string | null, '100.64.0.5'];
    let call = 0;
    const { deps: d, calls, restarts } = deps({ resolveOverlayIp: async () => ips[Math.min(call++, ips.length - 1)] });

    const result = await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);

    expect(result.overlayAddress).toBe('100.64.0.5');
    expect(isOverlayRangeAddress(result.overlayAddress)).toBe(true);
    expect(result.daemonRestarted).toBe(true);
    expect(restarts).toHaveLength(1);

    // headscale supervised as a root LaunchDaemon.
    expect(fs.existsSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`))).toBe(true);
    // tailscaled supervised via the native installer.
    expect(calls.some((c) => c.join(' ').includes('install-system-daemon'))).toBe(true);
    // Joined with the pinned flag shape (spike 0.1b: --auth-key, hyphenated).
    const up = calls.find((c) => c.includes('up'))!;
    expect(up).toEqual(['sudo', path.join(brewDir, 'tailscale'), 'up',
      '--login-server', 'https://host.example:8080', '--auth-key', 'onetimekeyvalue123', '--hostname', 'testhost']);

    // Daemon wired: machine-tier host_serve written with the 100.64 IP + the host
    // id/label the enrollment endpoint self-reports (Task 2.4).
    const machine = loadMachineConfig(process.env.MYCO_HOME);
    expect(machine.daemon.host_serve).toMatchObject({ enabled: true, overlay_address: '100.64.0.5', label: 'testhost' });
    expect(machine.daemon.host_serve.host_id).toMatch(/^host_[0-9a-f]{32}$/);

    // Host state recorded with version provenance.
    const state = readHostState()!;
    expect(state.overlay_address).toBe('100.64.0.5');
    expect(state.headscale_version).toBe(HEADSCALE_VERSION);
    expect(state.tailscale_version).toBe('1.98.8');
    expect(state.node_id).toBe('node-9');
    expect(state.host_id).toMatch(/^host_[0-9a-f]{32}$/);
  });

  it('re-running after success converges: skips join + key mint, preserves host id', async () => {
    const first = deps({ resolveOverlayIp: (() => { const ips = [null as string | null, '100.64.0.5']; let i = 0; return async () => ips[Math.min(i++, 1)]; })() });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, first.deps);
    const firstState = readHostState()!;

    // Second run: node already on the overlay (resolveOverlayIp returns the IP immediately).
    const second = deps({ resolveOverlayIp: async () => '100.64.0.5' });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, second.deps);

    // No join + no key mint on the idempotent re-run.
    expect(second.calls.some((c) => c.includes('up'))).toBe(false);
    expect(second.calls.some((c) => c.join(' ').includes('preauthkeys create'))).toBe(false);
    // headscale install skipped (already installed).
    expect(second.calls.some((c) => c.join(' ').includes('bootstrap'))).toBe(false);
    // Host identity + enabled-at preserved across re-enable.
    const secondState = readHostState()!;
    expect(secondState.host_id).toBe(firstState.host_id);
    expect(secondState.enabled_at).toBe(firstState.enabled_at);
  });

  it('refuses to enable without --server-url', async () => {
    const { deps: d } = deps();
    await expect(hostEnable({ serverUrl: '' }, d)).rejects.toThrow(/requires --server-url/);
  });

  it('surfaces the root requirement when sudo is unavailable (no smuggled credentials)', async () => {
    const { runner } = overlayRunner(launchDaemonsDir);
    const wrapped: CommandRunner = {
      async run(command, args) {
        if (command === 'sudo' && args[0] === '-n') return { stdout: '', exitCode: 1 };
        return runner.run(command, args);
      },
    };
    const notes: string[] = [];
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({ runner: wrapped, resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const result = await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, { ...d, logger: (m) => notes.push(m) });
    expect(result.notes.some((n) => /root privileges are required/.test(n))).toBe(true);
  });

  it('disable clears host_serve, tears down both services, and removes state', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);
    expect(fs.existsSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`))).toBe(true);

    const { deps: dd, calls } = deps();
    const result = await hostDisable(dd);

    expect(result.cleared).toBe(true);
    expect(result.errors).toEqual([]);
    // host_serve cleared.
    const machine = loadMachineConfig(process.env.MYCO_HOME);
    expect(machine.daemon.host_serve).toEqual({
      enabled: false,
      overlay_address: null,
      host_id: null,
      label: null,
      served_grove_id: null,
    });
    // Both services torn down.
    expect(calls.some((c) => c.join(' ').includes('uninstall-system-daemon'))).toBe(true);
    expect(calls.some((c) => c.includes('bootout'))).toBe(true);
    expect(fs.existsSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`))).toBe(false);
    // State removed.
    expect(readHostState()).toBeNull();
  });

  it('disable is safe when never enabled (idempotent teardown)', async () => {
    const { deps: dd } = deps();
    const result = await hostDisable(dd);
    expect(result.cleared).toBe(true);
    expect(readHostState()).toBeNull();
  });
});
