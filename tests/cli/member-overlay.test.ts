/**
 * Member overlay supervision + `myco join`/`myco leave` (Task 2.2).
 *
 * Hermetic: MYCO_TEAM_HOME → a fresh tmpdir per test (so the real ~/.myco-team is
 * never touched), and EVERY system/network effect is an injected seam — a fake
 * CommandRunner (no tailscale/brew), a fake ServiceManager (no launchctl), a fake
 * EnrollmentClient (no host round-trip). No real network, no real service.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION, MEMBER_OVERLAY_PROXY_PORT } from '@myco/constants';
import { createHostId, createProjectId, createGroveId } from '@myco/grove/ids';
import { resolveMemberTailscaledSocketPath } from '@myco/grove/paths';
import { classifyRoute } from '@myco/host/routing';
import { getHost, readHostRegistry, readHostSecrets, upsertHost, type HostRecord } from '@myco/host/registry';
import {
  MEMBER_TAILSCALED_LABEL,
  joinHost,
  leaveHost,
  stubEnrollmentClient,
  type EnrollmentClient,
  type EnrollmentContext,
  type HostEnrollment,
  type MemberOverlayDeps,
} from '@myco/host/member-overlay';
import { TAILSCALE_VERSION, type CommandRunner } from '@myco/host/overlay-binaries';
import { getServiceManager } from '@myco/service/manager';
import type { InstallResult, ServiceManager, ServiceSpec, ServiceStatus } from '@myco/service/types';

// --- fakes -----------------------------------------------------------------

/** Records install/start/uninstall + toggles "running" on start, so a join's
 *  install→status→start sequence is observable and idempotent re-joins converge. */
class FakeServiceManager implements ServiceManager {
  readonly supported = true;
  readonly platformName = 'fake';
  installed: ServiceSpec[] = [];
  started: string[] = [];
  uninstalled: string[] = [];
  running = false;
  async isInstalled(label: string): Promise<boolean> { return this.installed.some((s) => s.label === label); }
  async install(spec: ServiceSpec): Promise<InstallResult> {
    const changed = !this.installed.some((s) => s.label === spec.label);
    this.installed.push(spec);
    return { changed, supervisorReloaded: changed };
  }
  async uninstall(label: string): Promise<void> { this.uninstalled.push(label); this.running = false; }
  async start(label: string): Promise<void> { this.started.push(label); this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  async restart(label: string): Promise<void> { this.started.push(label); this.running = true; }
  restartShellCommand(): string { return ''; }
  async status(label: string): Promise<ServiceStatus> {
    const installed = this.installed.some((s) => s.label === label);
    return { installed, running: this.running, pid: this.running ? 4242 : null, lastExitCode: null, unitPath: installed ? `/fake/${label}.plist` : null };
  }
}

/** Darwin (brew) runner: brew-list ok, version → the pin, `ip -4` empty until
 *  `up` runs (then a 100.64 IP). Records every call for sudo/idempotency asserts. */
function fakeDarwinRunner(state: { joined: boolean; ups: number; calls: string[][] }): CommandRunner {
  return {
    async run(command: string, args: string[]) {
      state.calls.push([command, ...args]);
      if (command === 'brew' && args[0] === 'list') return { stdout: 'tailscale', exitCode: 0 };
      if (args.length === 1 && args[0] === 'version') return { stdout: `${TAILSCALE_VERSION}\n  tailscale commit: abc\n`, exitCode: 0 };
      if (args.includes('up')) { state.joined = true; state.ups += 1; return { stdout: 'Success.', exitCode: 0 }; }
      if (args.includes('ip')) return { stdout: state.joined ? '100.64.0.5\n' : '\n', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    },
  };
}

function fakeEnrollment(hostId: string, bearer: string, projects: HostEnrollment['projects'] = []): EnrollmentClient {
  return {
    async enroll(_ctx: EnrollmentContext): Promise<HostEnrollment> {
      return { host_id: hostId, label: 'Mac Studio', overlay_address: '100.64.0.1:7433', protocol_version: HOST_PROTOCOL_VERSION, bearer, projects };
    },
  };
}

describe('member overlay — join / leave', () => {
  let tmp: string;
  let brewDir: string;
  let savedTeamHome: string | undefined;
  let runnerState: { joined: boolean; ups: number; calls: string[][] };
  let svc: FakeServiceManager;
  const shortSocket = '/tmp/myco-td-test.sock';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-'));
    brewDir = path.join(tmp, 'brew');
    fs.mkdirSync(brewDir, { recursive: true });
    // Pretend brew already linked the two binaries (verify-landed needs +x).
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    runnerState = { joined: false, ups: 0, calls: [] };
    svc = new FakeServiceManager();
  });
  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function deps(overrides: Partial<MemberOverlayDeps> = {}): MemberOverlayDeps {
    return {
      platform: 'darwin',
      arch: 'arm64',
      runner: fakeDarwinRunner(runnerState),
      serviceManager: svc,
      brewBinDirs: [brewDir],
      socketPath: shortSocket,
      stateDir: path.join(tmp, 'state'),
      binDir: path.join(tmp, 'bin'),
      checkHostReachable: async () => true,
      logger: () => {},
      ...overrides,
    };
  }

  const hostId = () => createHostId();

  // --- short socket (macOS 104-byte sun_path limit) ------------------------

  test('default tailscaled socket path stays under the macOS 104-byte AF_UNIX limit', () => {
    expect(Buffer.byteLength(resolveMemberTailscaledSocketPath())).toBeLessThan(104);
  });

  test('join REFUSES a too-long injected socket path on darwin (loud, not a runtime bind failure)', async () => {
    const tooLong = '/tmp/' + 'x'.repeat(110) + '.sock';
    await expect(joinHost(
      { hostRef: hostId(), key: 'k', serverUrl: 'https://h:8080' },
      deps({ socketPath: tooLong }),
    )).rejects.toThrow(/AF_UNIX limit/);
  });

  // --- the LaunchAgent is USER-domain, never root --------------------------

  test('supervises tailscaled as a per-user LaunchAgent (userspace, HTTP-CONNECT), never root/sudo', async () => {
    const id = hostId();
    await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-xyz') }),
    );

    // Installed through the injected USER-domain manager, started once.
    expect(svc.installed.map((s) => s.label)).toEqual([MEMBER_TAILSCALED_LABEL]);
    expect(svc.started).toContain(MEMBER_TAILSCALED_LABEL);
    const spec = svc.installed[0];
    expect(spec.args).toContain('--tun=userspace-networking');
    expect(spec.args).toContain(`--socket=${shortSocket}`);
    expect(spec.args).toContain(`--outbound-http-proxy-listen=localhost:${MEMBER_OVERLAY_PROXY_PORT}`);
    // No SOCKS listener — the proxy dials HTTP-CONNECT, so we expose only that.
    expect(spec.args.some((a) => a.includes('--socks5-server'))).toBe(false);
    // Executable is the located brew tailscaled (provisioning reuse).
    expect(spec.executable).toBe(path.join(brewDir, 'tailscaled'));

    // Never elevated: not a single sudo call crossed the runner.
    expect(runnerState.calls.some((c) => c[0] === 'sudo')).toBe(false);

    // Structural user-domain proof: the real darwin manager targets ~/Library/
    // LaunchAgents (gui/<uid>), NOT /Library/LaunchDaemons (root).
    const real = getServiceManager({ platform: 'darwin' }) as unknown as { agentsDir: string };
    expect(real.agentsDir).toContain('LaunchAgents');
    expect(real.agentsDir).not.toContain('LaunchDaemons');
  });

  // --- join writes the record the proxy consumes ---------------------------

  test('join writes a correct HostRecord (overlay_address, proxy_port) + stores the bearer in secrets.env only', async () => {
    const id = hostId();
    const result = await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-xyz') }),
    );

    expect(result.created).toBe(true);
    const rec = getHost(id)!;
    expect(rec.overlay_address).toBe('100.64.0.1:7433'); // host IP:daemon-port
    expect(rec.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT); // local HTTP-CONNECT listener
    expect(rec.protocol_version).toBe(HOST_PROTOCOL_VERSION);

    // Bearer lives ONLY in secrets.env, NEVER in host.json.
    expect(readHostSecrets(id)[HOST_BEARER_SECRET]).toBe('bearer-xyz');
    const hostJsonPath = path.join(tmp, 'hosts', id, 'host.json');
    expect(fs.readFileSync(hostJsonPath, 'utf-8')).not.toContain('bearer-xyz');
  });

  test('the written proxy_port is the field Task 1.3\'s proxy dials (classifyRoute → RemoteTarget)', async () => {
    const id = hostId();
    const grove = createGroveId();
    const project = createProjectId();
    await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-xyz', [{ grove_id: grove, project_id: project }]) }),
    );

    const decision = classifyRoute({ method: 'GET', pathname: '/api/spores', projectId: project as never });
    expect(decision.kind).toBe('remote');
    if (decision.kind === 'remote') {
      // host-proxy.ts defaultDial dials 127.0.0.1:<proxy_port> via CONNECT.
      expect(decision.target.host.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT);
      expect(decision.target.bearer).toBe('bearer-xyz'); // read from the secrets.env we wrote
    }
  });

  // --- idempotency ---------------------------------------------------------

  test('re-join converges: no duplicate record, projects preserved, single-use key not re-`up`ed', async () => {
    const id = hostId();
    const grove = createGroveId();
    const project = createProjectId();

    // First join with a pre-attached project (as if a later attach had run).
    await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-1', [{ grove_id: grove, project_id: project }]) }),
    );
    const createdAt = getHost(id)!.created_at;
    expect(runnerState.ups).toBe(1);

    // Second join: overlay already up (ip resolves), enrollment returns NO
    // projects — the existing attach must survive; the used key must not re-`up`.
    await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-2', []) }),
    );

    expect(readHostRegistry()).toHaveLength(1);
    const rec = getHost(id)!;
    expect(rec.projects).toEqual([{ grove_id: grove, project_id: project }]);
    expect(rec.created_at).toBe(createdAt);
    expect(runnerState.ups).toBe(1); // still only the first join ran `tailscale up`
    expect(readHostSecrets(id)[HOST_BEARER_SECRET]).toBe('bearer-2'); // bearer refreshed
  });

  // --- leave ---------------------------------------------------------------

  test('leave clears the record + bearer and tears down the LaunchAgent when no host remains', async () => {
    const id = hostId();
    await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-xyz') }),
    );

    const result = await leaveHost(id, deps());
    expect(result.removed).toBe(true);
    expect(result.tailscaledRemoved).toBe(true);
    expect(getHost(id)).toBeNull();
    expect(readHostRegistry()).toHaveLength(0);
    expect(readHostSecrets(id)[HOST_BEARER_SECRET]).toBeUndefined();
    expect(svc.uninstalled).toContain(MEMBER_TAILSCALED_LABEL);
  });

  test('leave keeps the LaunchAgent running when another host is still joined', async () => {
    const idA = hostId();
    const idB = hostId();
    await joinHost({ hostRef: idA, key: 'k', serverUrl: 'https://a:8080' }, deps({ enrollmentClient: fakeEnrollment(idA, 'ba') }));
    // Second host already on the overlay (no re-up); just record it.
    await joinHost({ hostRef: idB, key: 'k', serverUrl: 'https://b:8080' }, deps({ enrollmentClient: fakeEnrollment(idB, 'bb') }));
    expect(readHostRegistry()).toHaveLength(2);

    const result = await leaveHost(idA, deps());
    expect(result.removed).toBe(true);
    expect(result.tailscaledRemoved).toBe(false);
    expect(getHost(idB)).not.toBeNull();
    expect(svc.uninstalled).not.toContain(MEMBER_TAILSCALED_LABEL);
  });

  test('leave is idempotent — an unknown host is a clean no-op', async () => {
    const result = await leaveHost(hostId(), deps());
    expect(result.removed).toBe(false);
    expect(result.tailscaledRemoved).toBe(false);
  });

  // --- the Task 2.4 enrollment seam (stub) ---------------------------------

  test('the default enrollment stub throws a clear TODO(2.4) error without the manual bridge flags', async () => {
    await expect(stubEnrollmentClient.enroll({
      hostRef: hostId(), oneTimeKey: 'k', memberHostname: 'm', memberOverlayIp: '100.64.0.5',
    })).rejects.toThrow(/enrollment is not available yet/);
  });

  test('join works today via the manual enrollment bridge (--overlay-address / --bearer)', async () => {
    const id = hostId();
    // No enrollmentClient injected → the default stub; supply the bridge flags.
    const result = await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080', overlayAddress: '100.64.0.1:7433', bearer: 'manual-bearer' },
      deps(),
    );
    expect(result.hostId).toBe(id);
    expect(getHost(id)!.overlay_address).toBe('100.64.0.1:7433');
    expect(readHostSecrets(id)[HOST_BEARER_SECRET]).toBe('manual-bearer');
  });

  test('join fails clean when the overlay never comes up (no 100.64 IP resolves)', async () => {
    const id = hostId();
    await expect(joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({
        enrollmentClient: fakeEnrollment(id, 'b'),
        // Runner that never reports an overlay IP even after `up`.
        runner: { async run(cmd, args) {
          if (cmd === 'brew') return { stdout: 'tailscale', exitCode: 0 };
          if (args.length === 1 && args[0] === 'version') return { stdout: `${TAILSCALE_VERSION}\n`, exitCode: 0 };
          if (args.includes('ip')) return { stdout: '\n', exitCode: 0 };
          return { stdout: '', exitCode: 0 };
        } },
      }),
    )).rejects.toThrow(/Could not resolve a 100\.64/);
  });
});
