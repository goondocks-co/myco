import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostDisable, hostEnable, HOST_TAILSCALED_LABEL, type HostEnableDeps } from '@myco/team-host/overlay.js';
import { createHostAdminDisableHandler, createHostAdminEnableHandler } from '@myco/daemon/api/host-admin.js';
import { ProgressTracker } from '@myco/daemon/api/progress.js';
import { headscaleAssetName, headscaleAssetUrl, HEADSCALE_VERSION, type BinaryFetcher, type CommandRunner } from '@myco/team-host/binaries.js';
import { HEADSCALE_SERVICE_LABEL } from '@myco/team-host/system-service.js';
import { serviceLabel } from '@myco/service/labels';
import { readHostState } from '@myco/team-host/state.js';
import { loadMachineConfig } from '@myco/config/loader.js';
import { createGrove, loadGroveRecord } from '@myco/grove/registry.js';
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
      logger: () => {},
      ...overrides,
    };
    // Headscale seams derive from the EFFECTIVE manager (post-overrides), so
    // tests that share one manager across enable→disable bundles get a scope
    // observation that follows the honest double's installed state.
    base.headscaleServiceManager ??= base.serviceManager;
    base.resolveHeadscaleScope ??= async () => (
      (await base.headscaleServiceManager!.isInstalled(HEADSCALE_SERVICE_LABEL)) ? 'login' : 'none');
    base.waitForAdminSocket ??= async () => true;
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

    // headscale supervised at the DAEMON'S scope as the invoking user (E1
    // §3.2) — via the scoped manager, never the root boot backend. Explicit
    // start follows install (systemd user units only reload+enable).
    const hsSpec = installs.find((spec) => spec.label === HEADSCALE_SERVICE_LABEL)!;
    expect(hsSpec).toBeDefined();
    expect(hsSpec.scope).toEqual({ startAt: 'login', runAs: 'invoking-user' });
    // NOTHING lands in the system domain on the default login-scope path.
    expect(fs.existsSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`))).toBe(false);
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

    // The headscale admin socket is USER-owned (pinned via `unix_socket`) —
    // the key-mint calls run unprivileged, which is what makes member adds
    // daemon-callable (E1 §3.2 family-B collapse).
    const mintCall = calls.find((c) => c.join(' ').includes('preauthkeys create'))!;
    expect(mintCall[0]).not.toBe('sudo');
    expect(mintCall[0]).toContain('headscale');

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

  it('login scope is ZERO-sudo: no root preflight, no root note, even when sudo is unavailable', async () => {
    // E1 §3.2: the default enable path is fully unprivileged. The old
    // unconditional preflight pushed "root privileges are required" into
    // notes[] — factually wrong post-re-scope, and §4.1 routes notes[] to
    // the UI as failure copy (review CORRECTION 9).
    const { runner } = overlayRunner(launchDaemonsDir);
    const wrapped: CommandRunner = {
      async run(command, args) {
        if (command === 'sudo' && args[0] === '-n') return { stdout: '', exitCode: 1 };
        return runner.run(command, args);
      },
    };
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({ runner: wrapped, resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const result = await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);
    expect(result.notes.some((n) => /root privileges are required/.test(n))).toBe(false);
  });

  it('darwin+boot is the ONE cell that surfaces the root requirement (no smuggled credentials)', async () => {
    // An operator-converged boot-scope host still needs sudo for the
    // system-domain unit step — and only that cell says so up front.
    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), 'daemon:\n  service_scope: boot\n');
    const { runner } = overlayRunner(launchDaemonsDir);
    const wrapped: CommandRunner = {
      async run(command, args) {
        if (command === 'sudo' && args[0] === '-n') return { stdout: '', exitCode: 1 };
        return runner.run(command, args);
      },
    };
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d, installs } = deps({ runner: wrapped, resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    try {
      const result = await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);
      expect(result.notes.some((n) => /root privileges are required/.test(n))).toBe(true);
      // And the configured scope carried end to end into the unit spec.
      const hsSpec = installs.find((spec) => spec.label === HEADSCALE_SERVICE_LABEL)!;
      expect(hsSpec.scope).toEqual({ startAt: 'boot', runAs: 'invoking-user' });
    } finally {
      fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'config.yaml'), '');
    }
  });

  it('disable clears host_serve, tears down both services, and removes state', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const d = first.deps;
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);
    expect(first.installs.some((spec) => spec.label === HEADSCALE_SERVICE_LABEL)).toBe(true);

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
    expect(machine.daemon.host_serve).toMatchObject({
      enabled: false,
      overlay_address: null,
      overlay_port: null,
      host_id: null,
      label: null,
      served_grove_id: null,
    });
    // Disable REMEMBERS the outgoing storage so re-enable adopts it instead
    // of orphaning the team's history (E1 §4.1 rev 5).
    expect(machine.daemon.host_serve.last_served_grove_id).toMatch(/^grove_/);
    // Both services torn down — but NEVER via the vendor's own uninstaller,
    // which is byte-identical to removing the user's genuine Tailscale.
    expect(calls.some((c) => c.join(' ').includes('uninstall-system-daemon'))).toBe(false);
    expect(uninstalls).toContain(HOST_TAILSCALED_LABEL);
    // Headscale torn down through the USER-domain manager (E1 §3.2) — and
    // nothing on the login-scope path ever elevates: no sudo, no bootout.
    expect(uninstalls).toContain(HEADSCALE_SERVICE_LABEL);
    expect(calls.some((c) => c[0] === 'sudo')).toBe(false);
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

    // (a) tailscaled restarted via its manager; (b) headscale via the SCOPED
    // manager — never `restartSystemService`, which is boot-domain-only
    // (E1 §3.2); (c) socket unlinked BEFORE the restart.
    // Both restarts flowed through the SHARED (first) manager.
    expect(first.restarts).toContain(HOST_TAILSCALED_LABEL);
    expect(first.restarts).toContain(HEADSCALE_SERVICE_LABEL);
    expect(socketExistedAtRestart).toBe(false);
    expect(readHostState()!.enabled_at).toBe(enabledAt);

    // (d) a throwing headscale restart fails the enable BEFORE writeHostState.
    const stateBefore = readHostState();
    const throwingRestart: ServiceManager = {
      ...first.deps.serviceManager!,
      restart: async (label: string) => {
        if (label === HEADSCALE_SERVICE_LABEL) throw new Error('kickstart refused');
        return first.deps.serviceManager!.restart(label);
      },
    };
    const third = deps({
      serviceManager: first.deps.serviceManager,
      headscaleServiceManager: throwingRestart,
      resolveHeadscaleScope: async () => 'login',
      provisionBinaries: async () => ({
        headscaleBin: '/tmp/hs', tailscaleBin: '/tmp/ts', tailscaledBin: '/tmp/tsd',
        headscaleVersion: HEADSCALE_VERSION, tailscaleVersion: '9.9.9',
        changed: ['headscale'],
        source: { headscale: 'download' as const, tailscale: 'brew' as const },
      }),
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

  it('resolves the node id via the default headscale client, UNPRIVILEGED (no resolveNodeId override)', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d, calls } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)], resolveNodeId: undefined });

    const result = await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d);

    expect(result.hostId).toBeDefined();
    const state = readHostState()!;
    expect(state.node_id).toBe('9'); // from overlayRunner's `nodes list` fixture
    // The admin socket is user-owned post-re-scope — no sudo anywhere in the
    // admin-CLI family (E1 §3.2: this is what makes it daemon-callable).
    const nodesListCall = calls.find((c) => c.join(' ').includes('nodes list'))!;
    expect(nodesListCall[0]).not.toBe('sudo');
  });

  it('enable REFUSES a wrong-domain headscale unit with the remedy matched to the cell', async () => {
    // A unit observed outside the configured domain is never converged
    // in-place — installing at the target domain anyway would create two
    // supervisors over one SQLite file (E1 review RC1). The remedy DIFFERS
    // by cell: transitionable drift gets the non-destructive command;
    // prescribing teardown for drift would destroy the team's control-plane
    // state for a condition `myco service install` fixes (diff review C4).
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    // Drift: boot observed, no system-domain unit file (a Myco boot-user cell).
    const { deps: d } = deps({
      resolveOverlayIp: async () => ips[Math.min(i++, 1)],
      resolveHeadscaleScope: async () => 'boot',
    });
    await expect(hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d))
      .rejects.toThrow(/myco service install/);

    // Legacy root cell: boot observed AND a root-rendered system unit file.
    fs.mkdirSync(launchDaemonsDir, { recursive: true });
    fs.writeFileSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`), '<plist>legacy root cell — no UserName key</plist>');
    const legacy = deps({ resolveHeadscaleScope: async () => 'boot' });
    await expect(hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, legacy.deps))
      .rejects.toThrow(/legacy root service.*myco host disable/s);
    fs.rmSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`));

    const both = deps({ resolveHeadscaleScope: async () => 'both' });
    await expect(hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, both.deps))
      .rejects.toThrow(/BOTH supervision domains/);
  });

  it('disable tears headscale out of BOTH domains, routed by ACTUAL unit location', async () => {
    // Disable is the one operation that must converge to ZERO units in ANY
    // domain. Routing is by unit-file presence, never semantic scope — the
    // Linux linger cell is a USER unit whose observation reads 'boot', and
    // routing that to the system domain demands sudo for a unit that does
    // not exist, aborting before the REAL unit is touched (diff review B1).
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, first.deps);

    // A legacy system-domain unit ALSO exists (bad-day coexistence).
    fs.mkdirSync(launchDaemonsDir, { recursive: true });
    fs.writeFileSync(path.join(launchDaemonsDir, `${HEADSCALE_SERVICE_LABEL}.plist`), '<plist>legacy</plist>');
    const dis = deps({ serviceManager: first.deps.serviceManager });
    const result = await hostDisable(dis.deps);
    expect(result.cleared).toBe(true);
    // System domain: torn down via the boot backend (sudo bootout + rm)
    // because the unit FILE was present.
    expect(dis.calls.some((c) => c[0] === 'sudo' && c.includes('bootout'))).toBe(true);
    // User domain: torn down via the manager, and proven gone.
    expect(first.uninstalls).toContain(HEADSCALE_SERVICE_LABEL);
  });

  it('a Linux-linger-shaped disable (boot observation, NO system unit) never touches the system domain', async () => {
    // The B1 regression pin: user unit + 'boot' observation (linger/marker),
    // no /etc/systemd/system file. Disable must go straight to the user
    // manager — zero sudo — and still fully converge.
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, first.deps);

    const dis = deps({
      serviceManager: first.deps.serviceManager,
      resolveHeadscaleScope: async () => 'boot', // enable-side seam; disable must IGNORE semantic scope
    });
    const result = await hostDisable(dis.deps);
    expect(result.cleared).toBe(true);
    expect(result.errors).toEqual([]);
    expect(first.uninstalls).toContain(HEADSCALE_SERVICE_LABEL);
    expect(dis.calls.some((c) => c[0] === 'sudo')).toBe(false);
  });

  it('LINUX HOSTING: both overlay units are explicitly STARTED after install — systemd only enables (live rig regression)', async () => {
    // Found by the 1.3.1 live rig pass: `SystemdUserServiceManager.install`
    // only daemon-reloads + enables, so on Linux the freshly-installed
    // tailscaled unit sat `enabled; inactive (dead)`, its control socket
    // never appeared, and enable died at the 5s wait — hosting on Linux was
    // impossible. launchd bootstraps with RunAtLoad, which is why macOS
    // hosting (all of Stage E) never saw it.
    const started: string[] = [];
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const baseStart = d.serviceManager!.start.bind(d.serviceManager);
    d.serviceManager!.start = async (label: string) => { started.push(label); return baseStart(label); };
    // Honest systemd shape: installed + enabled, but NOT running until started.
    const running = new Set<string>();
    d.serviceManager!.status = async (label: string) => ({
      installed: true,
      running: running.has(label),
      pid: null,
      lastExitCode: null,
      unitPath: null,
    });
    const trackedStart = d.serviceManager!.start;
    d.serviceManager!.start = async (label: string) => { running.add(label); return trackedStart(label); };
    d.headscaleServiceManager = d.serviceManager;

    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh' }, d);

    expect(started).toContain(HOST_TAILSCALED_LABEL);
    expect(started).toContain(HEADSCALE_SERVICE_LABEL);
  });

  it("a service whose owning domain is UNREADABLE ('unknown') is never blind-started", async () => {
    // The member path's rule (member-overlay.ts), now shared: `running:
    // 'unknown'` means we could not read the owning domain — starting there
    // could double-start a live service.
    const started: string[] = [];
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const baseStart = d.serviceManager!.start.bind(d.serviceManager);
    d.serviceManager!.start = async (label: string) => { started.push(label); return baseStart(label); };
    d.serviceManager!.status = async () => ({
      installed: true, running: 'unknown' as const, pid: null, lastExitCode: null, unitPath: null,
    });
    d.headscaleServiceManager = d.serviceManager;
    d.resolveHeadscaleScope = async () => 'none';

    await hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh' }, d);

    expect(started).not.toContain(HOST_TAILSCALED_LABEL);
    expect(started).not.toContain(HEADSCALE_SERVICE_LABEL);
  });

  it('enable fails LOUD when the admin socket never appears (a dead control plane, not a hang)', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({
      resolveOverlayIp: async () => ips[Math.min(i++, 1)],
      waitForAdminSocket: async () => false,
    });
    await expect(hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d))
      .rejects.toThrow(/did not bind its admin socket/);
  });

  it('FIRST designation on a machine with existing Groves requires an explicit choice (rev 6 breaking change)', async () => {
    createGrove('Personal', process.env.MYCO_HOME!);
    const { deps: d } = deps();
    await expect(hostEnable({ serverUrl: 'https://host.example:8080', hostname: 'testhost' }, d))
      .rejects.toThrow(/explicit choice/);
    // The refusal is a PREFLIGHT — nothing was provisioned or installed.
    expect(d.headscaleServiceManager && (await d.headscaleServiceManager.isInstalled(HEADSCALE_SERVICE_LABEL))).toBe(false);
  });

  it('fresh designation names the team storage; a colliding name refuses BEFORE provisioning', async () => {
    createGrove('Taken', process.env.MYCO_HOME!);
    const bad = deps();
    await expect(hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh', storageName: 'Taken' },
      bad.deps,
    )).rejects.toThrow(/already names a Grove/);

    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const { deps: d } = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const result = await hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh', storageName: 'Acme Team' },
      d,
    );
    expect(loadGroveRecord(result.servedGroveId, process.env.MYCO_HOME!)?.name).toBe('Acme Team');
  });

  it('disable → re-enable ADOPTS the previously-served storage — same Grove, history intact, no collision throw', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const enabled = await hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh', storageName: 'Acme Team' },
      first.deps,
    );

    const dis = deps({ serviceManager: first.deps.serviceManager });
    expect((await hostDisable(dis.deps)).cleared).toBe(true);

    // Re-enable with the SAME name — the old behavior orphaned the first
    // Grove and threw `Grove already exists` here (E1 review RC6).
    const again = deps({ serviceManager: first.deps.serviceManager, resolveOverlayIp: async () => '100.64.0.5' });
    const reEnabled = await hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh', storageName: 'Acme Team' },
      again.deps,
    );
    expect(reEnabled.servedGroveId).toBe(enabled.servedGroveId);
    // Consumed: the breadcrumb does not linger once re-adopted.
    expect(loadMachineConfig(process.env.MYCO_HOME).daemon.host_serve.last_served_grove_id).toBeNull();
  });

  it('after disable, a DIFFERENT --storage-name creates NEW storage and KEEPS the old Grove (diff review C5)', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const enabled = await hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh', storageName: 'First Team' },
      first.deps,
    );
    await hostDisable(deps({ serviceManager: first.deps.serviceManager }).deps);

    const logs: string[] = [];
    const again = deps({
      serviceManager: first.deps.serviceManager,
      resolveOverlayIp: async () => '100.64.0.5',
      logger: (m: string) => logs.push(m),
    });
    const second = await hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh', storageName: 'Second Team' },
      again.deps,
    );
    // New storage under the new name — the escape hatch out of adoption.
    expect(second.servedGroveId).not.toBe(enabled.servedGroveId);
    expect(loadGroveRecord(second.servedGroveId, process.env.MYCO_HOME!)?.name).toBe('Second Team');
    // The old team storage is KEPT and the skip was stated out loud.
    expect(loadGroveRecord(enabled.servedGroveId, process.env.MYCO_HOME!)?.name).toBe('First Team');
    expect(logs.some((m) => /KEPT but not adopted/.test(m))).toBe(true);
  });

  it('a re-run with a designation on record IGNORES --storage-name with a note, never silently', async () => {
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const logs: string[] = [];
    const first = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    await hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh', storageName: 'Acme Team' },
      first.deps,
    );
    const rerun = deps({
      serviceManager: first.deps.serviceManager,
      resolveOverlayIp: async () => '100.64.0.5',
      logger: (m: string) => logs.push(m),
    });
    await hostEnable(
      { serverUrl: 'https://host.example:8080', hostname: 'testhost', groveDesignation: 'fresh', storageName: 'Renamed Team' },
      rerun.deps,
    );
    expect(logs.some((m) => /storage-name .*ignored/i.test(m) || /"Renamed Team" ignored/.test(m))).toBe(true);
  });

  it('INTEGRATION: the host-admin handlers drive the REAL orchestration end to end (diff review B1 gate)', async () => {
    // The gate that would have caught BLOCKER 1: the route-level tests stub
    // the orchestration, so an injected dep that silently breaks
    // hostEnable/hostDisable internals (the deferring-ServiceManager bug —
    // tailscaled never supervised, disable aborted at its own prove-gone
    // gate) is invisible to them. This runs the REAL functions through the
    // handlers with the same honest fixture the CLI tests use.
    const ips = [null as string | null, '100.64.0.5']; let i = 0;
    const fixture = deps({ resolveOverlayIp: async () => ips[Math.min(i++, 1)] });
    const tracker = new ProgressTracker();
    let restartScheduled = 0;
    const routeDeps = {
      tracker,
      mycoHome: process.env.MYCO_HOME!,
      platform: 'darwin' as const,
      startedAt: () => 'T0',
      scheduleRestart: () => { restartScheduled += 1; },
      hostEnableDeps: fixture.deps,
    };

    const res = await createHostAdminEnableHandler(routeDeps)(
      { body: { server_url: 'https://host.example:8080', label: 'testhost', storage_name: 'Route Team' }, params: {}, query: {} } as never,
    );
    expect(res.status).toBe(202);
    const token = (res.body as { token: string }).token;
    // The real orchestration runs async — wait for the terminal state.
    for (let tries = 0; tries < 100 && tracker.get(token)?.status === 'running'; tries += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const entry = tracker.get(token)!;
    expect(entry.status).toBe('completed');
    // The REAL enable supervised tailscaled + headscale through the fixture
    // manager — the defect made this list empty and the job fail.
    expect(fixture.installs.some((sp) => sp.label === HOST_TAILSCALED_LABEL)).toBe(true);
    expect(fixture.installs.some((sp) => sp.label === HEADSCALE_SERVICE_LABEL)).toBe(true);
    expect(restartScheduled).toBe(1);
    expect(loadMachineConfig(process.env.MYCO_HOME).daemon.host_serve.enabled).toBe(true);
    expect(loadGroveRecord(readHostState() === null ? '' : loadMachineConfig(process.env.MYCO_HOME).daemon.host_serve.served_grove_id!, process.env.MYCO_HOME!)?.name).toBe('Route Team');

    // Disable through the route: the REAL teardown, §15 gates included.
    const disRes = await createHostAdminDisableHandler(routeDeps)({ body: {}, params: {}, query: {} } as never);
    const disToken = (disRes.body as { token: string }).token;
    for (let tries = 0; tries < 100 && tracker.get(disToken)?.status === 'running'; tries += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const disEntry = tracker.get(disToken)!;
    expect(disEntry.status).toBe('completed');
    expect(fixture.uninstalls).toContain(HOST_TAILSCALED_LABEL);
    expect(fixture.uninstalls).toContain(HEADSCALE_SERVICE_LABEL);
    expect(restartScheduled).toBe(2);
    expect(loadMachineConfig(process.env.MYCO_HOME).daemon.host_serve.enabled).toBe(false);
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
