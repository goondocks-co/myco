import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostDisable, hostEnable, HOST_TAILSCALED_LABEL, type HostEnableDeps } from '@myco/team-host/overlay.js';
import { headscaleAssetName, headscaleAssetUrl, HEADSCALE_VERSION, type BinaryFetcher, type CommandRunner } from '@myco/team-host/binaries.js';
import { HEADSCALE_SERVICE_LABEL } from '@myco/team-host/system-service.js';
import { serviceLabel } from '@myco/service/labels';
import { readHostState } from '@myco/team-host/state.js';
import { loadMachineConfig } from '@myco/config/loader.js';
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';
import type { ServiceManager, ServiceStatus, InstallResult, ServiceSpec } from '@myco/service/types.js';

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
function overlayRunner(launchDaemonsDir: string): { runner: CommandRunner; calls: string[][]; servePorts: Set<number> } {
  const calls: string[][] = [];
  // Models tailscaled's persisted serve config, so teardown-by-ENUMERATION
  // (`serve status --json` → retire each) is exercised for real.
  const servePorts = new Set<number>();
  const tailscaledPlist = path.join(launchDaemonsDir, 'com.tailscale.tailscaled.plist');
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push([command, ...args]);
      const joined = [command, ...args].join(' ');
      if (args.includes('serve')) {
        const tcpFlag = args.find((a) => a.startsWith('--tcp='));
        const port = tcpFlag ? Number(tcpFlag.slice('--tcp='.length)) : NaN;
        if (args.includes('status')) {
          return {
            stdout: servePorts.size === 0 ? '{}' : JSON.stringify({
              TCP: Object.fromEntries([...servePorts].map((p) => [String(p), { TCPForward: `127.0.0.1:${p}` }])),
            }),
            exitCode: 0,
          };
        }
        if (args.includes('off')) {
          if (!servePorts.has(port)) {
            return { stdout: 'error: failed to remove TCP serve: serve config does not exist', exitCode: 1 };
          }
          servePorts.delete(port);
          return { stdout: '', exitCode: 0 };
        }
        servePorts.add(port);
        return { stdout: '', exitCode: 0 };
      }
      if (command === 'brew' && args[0] === 'list' && args[1] === '--formula') return { stdout: 'tailscale', exitCode: 0 };
      if (args[0] === 'list' && args[1] === '--versions' && args[2] === 'tailscale') {
        return { stdout: 'tailscale 1.98.8\n', exitCode: 0 };
      }
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
  return { runner, calls, servePorts };
}

function fakeManager(): {
  manager: ServiceManager;
  restarts: string[];
  installs: ServiceSpec[];
  uninstalls: string[];
} {
  const restarts: string[] = [];
  const installs: ServiceSpec[] = [];
  const uninstalls: string[] = [];
  // Honest double: uninstall genuinely removes — §15's prove-gone reads
  // status AFTER uninstall, so a fixture that stays "installed" forever
  // would abort every disable.
  const removed = new Set<string>();
  const everInstalled = new Set<string>([serviceLabel(process.env.MYCO_HOME!)]);
  const manager: ServiceManager = {
    supported: true, platformName: 'launchd',
    // Honest: a never-installed label is NOT installed — R-M5's existence
    // guard (skip the proof when nothing was installed) is exercised by the
    // never-enabled idempotency test only if this tells the truth.
    isInstalled: async (label) => everInstalled.has(label) && !removed.has(label),
    inspect: async (label) => (everInstalled.has(label) && !removed.has(label)
      ? { executable: '/provisioned/bin', args: [] }
      : null),
    install: async (spec): Promise<InstallResult> => {
      installs.push(spec);
      removed.delete(spec.label);
      everInstalled.add(spec.label);
      return { changed: false, supervisorReloaded: false };
    },
    uninstall: async (label) => { uninstalls.push(label); removed.add(label); },
    start: async () => {}, stop: async () => {},
    restart: async (l) => { restarts.push(l); },
    restartShellCommand: (l) => l,
    status: async (label): Promise<ServiceStatus> => (everInstalled.has(label) && !removed.has(label)
      ? { installed: true, running: true, pid: 1, lastExitCode: null, unitPath: null }
      : { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null }),
  };
  return { manager, restarts, installs, uninstalls };
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

  function deps(overrides: Partial<HostEnableDeps> = {}): {
    deps: HostEnableDeps; calls: string[][]; restarts: string[];
    installs: ServiceSpec[]; uninstalls: string[];
    servePorts: Set<number>;
  } {
    const { runner, calls, servePorts } = overlayRunner(launchDaemonsDir);
    const { manager, restarts, installs, uninstalls } = fakeManager();
    const base: HostEnableDeps = {
      fetcher: fetcher(),
      runner,
      platform: 'darwin',
      arch: 'arm64',
      serviceManager: manager,
      brewBinDirs: [brewDir],
      systemCtx: { launchDaemonsDir, stagingDir: path.join(tmp, 'staging') },
      // The fake ServiceManager installs no real tailscaled, so nothing ever
      // binds the control socket. Short-circuit the wait; the socket-race
      // behaviour itself is covered by its own test below.
      hostTailscaledSocketPath: path.join(tmp, 'ts', 'host.sock'),
      hostTailscaledStateDir: path.join(tmp, 'ts', 'state'),
      waitForSocket: async () => true,
      resolveNodeId: async () => 'node-9',
      verifyOverlayListener: async () => true,
      logger: () => {},
      ...overrides,
    };
    return { deps: base, calls, restarts, installs, uninstalls, servePorts };
  }

  it('stands up the overlay end-to-end: services, join, host_serve wired, state recorded', async () => {
    // Not joined yet, then joined after `tailscale up`.
    const ips = [null as string | null, '100.64.0.5'];
    let call = 0;
    const { deps: d, calls, restarts, installs } = deps({ resolveOverlayIp: async () => ips[Math.min(call++, ips.length - 1)] });

    const result = await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);

    expect(result.overlayAddress).toBe('100.64.0.5');
    expect(isOverlayRangeAddress(result.overlayAddress)).toBe(true);
    expect(result.daemonRestarted).toBe(true);
    expect(restarts).toHaveLength(1);

    // headscale supervised as a root LaunchDaemon.
    expect(fs.existsSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`))).toBe(true);
    // tailscaled is supervised UNPRIVILEGED in the user domain — never via the
    // vendor's native system-daemon installer (coexistence C1/C2).
    expect(calls.some((c) => c.join(' ').includes('install-system-daemon'))).toBe(false);
    expect(installs.some((spec) => spec.label === HOST_TAILSCALED_LABEL)).toBe(true);
    const tsSpec = installs.find((spec) => spec.label === HOST_TAILSCALED_LABEL)!;
    expect(tsSpec.args).toEqual([
      '--tun=userspace-networking',
      `--socket=${path.join(tmp, 'ts', 'host.sock')}`,
      `--statedir=${path.join(tmp, 'ts', 'state')}`,
    ]);
    // Joined against THIS instance's private socket, with NO sudo — the
    // unsocketed form read the vendor tailnet and skipped the join entirely.
    const up = calls.find((c) => c.includes('up'))!;
    expect(up).toEqual([path.join(brewDir, 'tailscale'),
      '--socket', path.join(tmp, 'ts', 'host.sock'), 'up',
      '--login-server', 'https://host.example:8080', '--auth-key', 'onetimekeyvalue123', '--hostname', 'testhost']);
    expect(up).not.toContain('sudo');

    // The headscale admin socket is root-owned — the key-mint calls (users
    // create/list, preauthkeys create) all route through sudo.
    const mintCall = calls.find((c) => c.join(' ').includes('preauthkeys create'))!;
    expect(mintCall[0]).toBe('sudo');

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
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const d = first.deps;
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);
    expect(fs.existsSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`))).toBe(true);

    // A live bearer exists (as after real serving) — gate 9 asserts DEC-2's
    // credential destruction, which a bearer-less fixture proves vacuously.
    const { createSecretsOperations: mkSecrets } = await import('@myco/config/secrets');
    const { HOST_SERVE_BEARER_SECRET: BEARER_KEY } = await import('@myco/constants');
    mkSecrets().writeSecret(process.env.MYCO_HOME!, BEARER_KEY, 'live-bearer-value');

    // Same manager across enable→disable: the real supervisor's units
    // persist between CLI invocations, and the honest fixture only knows
    // what was installed through it.
    const dis = deps({ serviceManager: d.serviceManager });
    const { deps: dd, calls } = dis;
    const uninstalls = first.uninstalls;
    const result = await hostDisable(dd);

    expect(result.cleared).toBe(true);
    expect(result.errors).toEqual([]);
    // host_serve cleared.
    const machine = loadMachineConfig(process.env.MYCO_HOME);
    expect(machine.daemon.host_serve).toEqual({
      enabled: false,
      overlay_address: null,
      overlay_port: null,
      host_id: null,
      label: null,
      served_grove_id: null,
    });
    // Both services torn down — but NEVER via the vendor's own uninstaller,
    // which is byte-identical to removing the user's genuine Tailscale.
    expect(calls.some((c) => c.join(' ').includes('uninstall-system-daemon'))).toBe(false);
    expect(uninstalls).toContain(HOST_TAILSCALED_LABEL);
    expect(calls.some((c) => c.includes('bootout'))).toBe(true);
    expect(fs.existsSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`))).toBe(false);
    // State removed.
    expect(readHostState()).toBeNull();
    // §15 GATE 9: identity, node state, socket, and CREDENTIAL are all gone —
    // and only the INJECTED paths were touched (spec R-B3: a resolver-path
    // removal here would delete a dogfooding developer's live socket).
    expect(fs.existsSync(dd.hostTailscaledStateDir!)).toBe(false);
    expect(fs.existsSync(dd.hostTailscaledSocketPath!)).toBe(false);
    const { readSecrets } = await import('@myco/config/secrets');
    expect(readSecrets(process.env.MYCO_HOME!)[BEARER_KEY]).toBeUndefined();
  });

  it('GATE 1 (§14.4/§14.9): a converged binary RESTARTS both supervised services, socket unlinked first, and a restart failure aborts before state is written', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    // First enable: stand everything up.
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, first.deps);
    const enabledAt = readHostState()!.enabled_at;

    // Second enable with a provisioner that reports BOTH binaries changed.
    let socketExistedAtRestart: boolean | null = null;
    const second = deps({
      serviceManager: first.deps.serviceManager,
      provisionBinaries: async () => ({
        headscaleBin: '/tmp/hs', tailscaleBin: '/tmp/ts', tailscaledBin: '/tmp/tsd',
        headscaleVersion: HEADSCALE_VERSION, tailscaleVersion: '1.98.8',
        changed: ['headscale', 'tailscaled'],
        source: { headscale: 'download' as const, tailscale: 'brew' as const },
      }),
    });
    fs.writeFileSync(second.deps.hostTailscaledSocketPath!, '');
    const origRestart = first.deps.serviceManager!.restart.bind(first.deps.serviceManager);
    first.deps.serviceManager!.restart = async (label: string) => {
      socketExistedAtRestart = fs.existsSync(second.deps.hostTailscaledSocketPath!);
      await origRestart(label);
    };
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, {
      ...second.deps,
      resolveOverlayIp: async () => '100.64.0.5',
    });

    // (a) tailscaled restarted via its manager; (b) headscale via the
    // systemCtx runner argv; (c) socket unlinked BEFORE the restart.
    // The restart flowed through the SHARED (first) manager.
    expect(first.restarts).toContain(HOST_TAILSCALED_LABEL);
    expect(second.calls.some((c) => c[0] === 'sudo' && c[1] === 'launchctl' && c[2] === 'kickstart' && c[3] === '-k')).toBe(true);
    expect(socketExistedAtRestart).toBe(false);
    expect(readHostState()!.enabled_at).toBe(enabledAt);

    // (d) a throwing headscale restart fails the enable BEFORE writeHostState.
    const stateBefore = readHostState();
    const third = deps({
      serviceManager: first.deps.serviceManager,
      provisionBinaries: async () => ({
        headscaleBin: '/tmp/hs', tailscaleBin: '/tmp/ts', tailscaledBin: '/tmp/tsd',
        headscaleVersion: HEADSCALE_VERSION, tailscaleVersion: '9.9.9',
        changed: ['headscale'],
        source: { headscale: 'download' as const, tailscale: 'brew' as const },
      }),
      systemCtx: {
        launchDaemonsDir,
        stagingDir: path.join(tmp, 'staging'),
        runner: { async run(command: string, args: string[]) {
          if (args.includes('kickstart')) return { stdout: 'kickstart refused', exitCode: 1 };
          return { stdout: '', exitCode: 0 };
        } },
      },
    });
    await expect(hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, {
      ...third.deps,
      resolveOverlayIp: async () => '100.64.0.5',
    })).rejects.toThrow(/kickstart/);
    expect(readHostState()).toEqual(stateBefore);
  });

  it("GATE (R-M4a): a post-uninstall status of 'unknown' is NOT proof — disable aborts and destroys nothing", async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, first.deps);
    fs.mkdirSync(first.deps.hostTailscaledStateDir!, { recursive: true });

    const dis = deps({ serviceManager: first.deps.serviceManager });
    const origStatus = first.deps.serviceManager!.status.bind(first.deps.serviceManager);
    let uninstalled = false;
    first.deps.serviceManager!.uninstall = async () => { uninstalled = true; };
    first.deps.serviceManager!.status = async (label: string) => (uninstalled && label === HOST_TAILSCALED_LABEL
      ? { installed: false, running: 'unknown' as const, pid: null, lastExitCode: null, unitPath: null }
      : origStatus(label));

    const result = await hostDisable(dis.deps);

    expect(result.cleared).toBe(false);
    expect(result.errors.some((e) => /running \(state unknown\)/.test(e))).toBe(true);
    expect(fs.existsSync(first.deps.hostTailscaledStateDir!)).toBe(true);
    expect(readHostState()).not.toBeNull();
  });

  it('GATE (R-M4b): a socket that still ACCEPTS after uninstall aborts the disable — the statedir is never destroyed under a live tailscaled', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, first.deps);
    fs.mkdirSync(first.deps.hostTailscaledStateDir!, { recursive: true });
    // A LIVE process still owns the control socket (uninstall "succeeded"
    // per the supervisor, but the daemon survived — e.g. a bootout that only
    // removed the job record).
    fs.rmSync(first.deps.hostTailscaledSocketPath!, { force: true });
    const net = await import('node:net');
    const liveOwner = net.createServer(() => {});
    await new Promise<void>((resolve) => liveOwner.listen(first.deps.hostTailscaledSocketPath!, resolve));
    try {
      const dis = deps({ serviceManager: first.deps.serviceManager });
      const result = await hostDisable(dis.deps);

      expect(result.cleared).toBe(false);
      expect(result.errors.some((e) => /still accepts connections/.test(e))).toBe(true);
      expect(fs.existsSync(first.deps.hostTailscaledStateDir!)).toBe(true);
      expect(readHostState()).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => liveOwner.close(() => resolve()));
    }
  });

  it('GATE (R-B2 write side): the darwin enable records the digest of the supervised brew binary', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);

    const { sha256OfFile } = await import('@myco/host/overlay-provisioning-manifest.js');
    const state = readHostState()!;
    expect(state.tailscaled_sha256).toBe(sha256OfFile(state.tailscaled_bin));
  });

  it('§15 GATE 10 (the unhappy path): a failed tailscaled uninstall keeps the statedir, host state, AND bearer — and reports loudly', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);
    // A bearer exists (as after real serving).
    const { createSecretsOperations } = await import('@myco/config/secrets');
    const { HOST_SERVE_BEARER_SECRET } = await import('@myco/constants');
    const { writeSecret } = createSecretsOperations();
    writeSecret(process.env.MYCO_HOME!, HOST_SERVE_BEARER_SECRET, 'live-bearer-value');
    fs.mkdirSync(d.hostTailscaledStateDir!, { recursive: true });
    fs.writeFileSync(d.hostTailscaledSocketPath!, '');

    const failing = deps({ serviceManager: d.serviceManager });
    d.serviceManager!.uninstall = async () => { throw new Error('bootout refused'); };
    const summaries: string[] = [];
    const result = await hostDisable({ ...failing.deps, logger: (m) => summaries.push(m) });

    expect(result.cleared).toBe(false);
    expect(result.errors.some((e) => e.includes('bootout refused'))).toBe(true);
    // Fail CLOSED: everything a retry (or recovery-by-re-enable) needs survives.
    expect(fs.existsSync(d.hostTailscaledStateDir!)).toBe(true);
    expect(fs.existsSync(d.hostTailscaledSocketPath!)).toBe(true);
    expect(readHostState()).not.toBeNull();
    const { readSecrets } = await import('@myco/config/secrets');
    expect(readSecrets(process.env.MYCO_HOME!)[HOST_SERVE_BEARER_SECRET]).toBe('live-bearer-value');
    // Loud: the abort summary names the kept state and the possibly-live forward.
    expect(summaries.some((m) => /ABORTED/.test(m) && /forward may still be live/.test(m) && /doctor/.test(m))).toBe(true);
  });

  it('resolves the node id via the default headscale client, sudo\'d (no resolveNodeId override)', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d, calls } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)], resolveNodeId: undefined });

    const result = await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);

    expect(result.hostId).toBeDefined();
    const state = readHostState()!;
    expect(state.node_id).toBe('9'); // from overlayRunner's `nodes list` fixture
    const nodesListCall = calls.find((c) => c.join(' ').includes('nodes list'))!;
    expect(nodesListCall[0]).toBe('sudo');
  });

  it('disable is safe when never enabled (idempotent teardown)', async () => {
    const { deps: dd } = deps();
    const result = await hostDisable(dd);
    expect(result.cleared).toBe(true);
    expect(readHostState()).toBeNull();
  });
  it('retires forwards by ENUMERATION, before the config clear, so a retry converges', async () => {
    const ips = [null as string | null, '100.64.0.5'];
    let i = 0;
    const { deps: d } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);

    const { deps: dd, calls, servePorts } = deps();
    // A forward exists on a port that is NOT the currently-configured one —
    // the shape a previous life leaves behind. Reading the port from config
    // would miss it entirely.
    servePorts.add(41999);
    await hostDisable(dd);

    const offs = calls.filter((c) => c.includes('off') && c.some((a) => a.startsWith('--tcp=')));
    expect(offs.length, `no \`serve --tcp=<port> off\` in:\n${calls.map((c) => c.join(' ')).join('\n')}`)
      .toBeGreaterThan(0);
    expect(offs.some((c) => c.join(' ').includes('--tcp=41999'))).toBe(true);
    // Socketed at THIS instance, never the ambient daemon.
    expect(offs[0]!).toContain('--socket');
    expect([...servePorts]).toEqual([]);
  });
});

describe('Windows stays explicitly unsupported', () => {
  it('hostEnable throws before touching the service manager', async () => {
    // Deleting `installTailscaledDaemon` removed the SECOND Windows guard (its
    // own `throw`), and the ServiceManager that replaced it DOES support win32
    // (WindowsTaskServiceManager) — it would happily install a scheduled task.
    // `resolveOverlayTarget` is now the only thing standing between a Windows
    // box and a half-configured overlay, so assert it fires first.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-win-'));
    const installs: ServiceSpec[] = [];
    const manager: ServiceManager = {
      supported: true, platformName: 'windows-task',
      isInstalled: async () => false,
      inspect: async () => null,
      install: async (spec): Promise<InstallResult> => {
        installs.push(spec);
        return { changed: true, supervisorReloaded: false };
      },
      uninstall: async () => {}, start: async () => {}, stop: async () => {},
      restart: async () => {},
      restartShellCommand: (l) => l,
      status: async (): Promise<ServiceStatus> => ({ installed: false, running: false, pid: null, lastExitCode: null, unitPath: null }),
    };

    await expect(hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'wintest' },
      {
        platform: 'win32',
        arch: 'x64',
        serviceManager: manager,
        fetcher: fetcher(),
        logger: () => {},
        systemCtx: { stagingDir: tmpDir },
      },
    )).rejects.toThrow();

    // Nothing was installed on the way to that throw.
    expect(installs).toHaveLength(0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
