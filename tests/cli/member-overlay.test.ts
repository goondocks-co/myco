/**
 * Member overlay supervision + `myco join`/`myco leave` (Task 2.2, multi-host).
 *
 * Hermetic: MYCO_TEAM_HOME + HOME → a fresh tmpdir per test (so neither the real
 * ~/.myco-team nor ~/.myco-ts is touched), and EVERY system/network effect is an
 * injected seam — a fake CommandRunner (no tailscale/brew, joined state keyed PER
 * SOCKET so per-host tailnets are independent), a fake ServiceManager (no
 * launchctl, running tracked PER LABEL), a stubbed socket-readiness wait, a fake
 * EnrollmentClient. No real network, no launchctl, no real service.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION, MEMBER_OVERLAY_PROXY_PORT_BASE } from '@myco/constants';
import { createHostId, createProjectId, createGroveId } from '@myco/grove/ids';
import { resolveMemberTailscaledSocketPath } from '@myco/grove/paths';
import { classifyRoute } from '@myco/host/routing';
import { getHost, readHostRegistry, readHostSecrets } from '@myco/host/registry';
import {
  memberTailscaledLabel,
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

/** Records install/start/uninstall; tracks `running` PER LABEL so multiple
 *  per-host instances are independently observable. */
class FakeServiceManager implements ServiceManager {
  readonly supported = true;
  readonly platformName = 'fake';
  installed: ServiceSpec[] = [];
  started: string[] = [];
  uninstalled: string[] = [];
  private running = new Set<string>();
  isRunning(label: string): boolean { return this.running.has(label); }
  specFor(label: string): ServiceSpec | undefined { return this.installed.find((s) => s.label === label); }
  async isInstalled(label: string): Promise<boolean> { return this.installed.some((s) => s.label === label); }
  async install(spec: ServiceSpec): Promise<InstallResult> {
    const changed = !this.installed.some((s) => s.label === spec.label);
    if (changed) this.installed.push(spec);
    return { changed, supervisorReloaded: changed };
  }
  async uninstall(label: string): Promise<void> {
    this.uninstalled.push(label);
    this.running.delete(label);
    this.installed = this.installed.filter((s) => s.label !== label);
  }
  async start(label: string): Promise<void> { this.started.push(label); this.running.add(label); }
  async stop(label: string): Promise<void> { this.running.delete(label); }
  async restart(label: string): Promise<void> { this.started.push(label); this.running.add(label); }
  restartShellCommand(): string { return ''; }
  async status(label: string): Promise<ServiceStatus> {
    const installed = this.installed.some((s) => s.label === label);
    const running = this.running.has(label);
    return { installed, running, pid: running ? 4242 : null, lastExitCode: null, unitPath: installed ? `/fake/${label}.plist` : null };
  }
}

function socketFromArgs(args: string[]): string | undefined {
  const i = args.indexOf('--socket');
  return i >= 0 ? args[i + 1] : undefined;
}

/** Darwin (brew) runner. `joined` state is keyed PER SOCKET — each per-host
 *  tailscaled joins its own tailnet independently. `ups` records which sockets ran
 *  `tailscale up`, so we can assert both hosts joined and no re-`up` on converge. */
function fakeDarwinRunner(state: { joinedSockets: Set<string>; ups: string[]; calls: string[][] }): CommandRunner {
  return {
    async run(command: string, args: string[]) {
      state.calls.push([command, ...args]);
      if (command === 'brew' && args[0] === 'list') return { stdout: 'tailscale', exitCode: 0 };
      if (args.length === 1 && args[0] === 'version') return { stdout: `${TAILSCALE_VERSION}\n  tailscale commit: abc\n`, exitCode: 0 };
      const socket = socketFromArgs(args);
      if (args.includes('up')) { if (socket) state.joinedSockets.add(socket); state.ups.push(socket ?? ''); return { stdout: 'Success.', exitCode: 0 }; }
      if (args.includes('ip')) return { stdout: socket && state.joinedSockets.has(socket) ? '100.64.0.5\n' : '\n', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    },
  };
}

function fakeEnrollment(hostId: string, bearer: string, overlayAddress = '100.64.0.1:7433', projects: HostEnrollment['projects'] = []): EnrollmentClient {
  return {
    async enroll(_ctx: EnrollmentContext): Promise<HostEnrollment> {
      return { host_id: hostId, label: `host ${hostId.slice(0, 9)}`, overlay_address: overlayAddress, protocol_version: HOST_PROTOCOL_VERSION, bearer, projects };
    },
  };
}

describe('member overlay — multi-host join / leave', () => {
  let tmp: string;
  let brewDir: string;
  let savedTeamHome: string | undefined;
  let savedHome: string | undefined;
  let runnerState: { joinedSockets: Set<string>; ups: string[]; calls: string[][] };
  let svc: FakeServiceManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-'));
    brewDir = path.join(tmp, 'brew');
    fs.mkdirSync(brewDir, { recursive: true });
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedHome = process.env.HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    process.env.HOME = tmp; // home-anchored socket path resolves under tmp (hermetic)
    runnerState = { joinedSockets: new Set(), ups: [], calls: [] };
    svc = new FakeServiceManager();
  });
  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Deps with all seams faked; per-host socket/statedir/port DERIVE (not injected)
   *  so the real per-host path/label/port logic is exercised. */
  function deps(overrides: Partial<MemberOverlayDeps> = {}): MemberOverlayDeps {
    return {
      platform: 'darwin',
      arch: 'arm64',
      runner: fakeDarwinRunner(runnerState),
      serviceManager: svc,
      brewBinDirs: [brewDir],
      waitForSocket: async () => true,
      checkHostReachable: async () => true,
      logger: () => {},
      ...overrides,
    };
  }

  const hostId = () => createHostId();

  // --- short socket (macOS 104-byte sun_path limit) ------------------------

  test('per-host socket paths stay under the macOS 104-byte AF_UNIX limit and differ per host', () => {
    const a = resolveMemberTailscaledSocketPath(hostId());
    const b = resolveMemberTailscaledSocketPath(hostId());
    expect(Buffer.byteLength(a)).toBeLessThan(104);
    expect(Buffer.byteLength(b)).toBeLessThan(104);
    expect(a).not.toBe(b);
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

    const label = memberTailscaledLabel(id);
    expect(svc.installed.map((s) => s.label)).toEqual([label]);
    expect(svc.started).toContain(label);
    const spec = svc.specFor(label)!;
    expect(spec.args).toContain('--tun=userspace-networking');
    expect(spec.args).toContain(`--socket=${resolveMemberTailscaledSocketPath(id)}`);
    expect(spec.args).toContain(`--outbound-http-proxy-listen=localhost:${MEMBER_OVERLAY_PROXY_PORT_BASE}`);
    expect(spec.args.some((a) => a.includes('--socks5-server'))).toBe(false);
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

  test('join writes a correct HostRecord (overlay_address, allocated proxy_port) + bearer in secrets.env only', async () => {
    const id = hostId();
    const result = await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-xyz') }),
    );

    expect(result.created).toBe(true);
    const rec = getHost(id)!;
    expect(rec.overlay_address).toBe('100.64.0.1:7433');
    expect(rec.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE); // first host → base
    expect(rec.protocol_version).toBe(HOST_PROTOCOL_VERSION);

    expect(readHostSecrets(id)[HOST_BEARER_SECRET]).toBe('bearer-xyz');
    const hostJsonPath = path.join(tmp, 'hosts', id, 'host.json');
    expect(fs.readFileSync(hostJsonPath, 'utf-8')).not.toContain('bearer-xyz');
  });

  test('the written proxy_port is the field Task 1.3\'s proxy dials (classifyRoute → RemoteTarget)', async () => {
    const id = hostId();
    const project = createProjectId();
    await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-xyz', '100.64.0.1:7433', [{ grove_id: createGroveId(), project_id: project }]) }),
    );

    const decision = classifyRoute({ method: 'GET', pathname: '/api/spores', projectId: project as never });
    expect(decision.kind).toBe('remote');
    if (decision.kind === 'remote') {
      expect(decision.target.host.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE);
      expect(decision.target.bearer).toBe('bearer-xyz');
    }
  });

  // --- MULTI-HOST: distinct hosts on distinct tailnets ----------------------

  test('a member joined to two DISTINCT hosts runs two independent tailscaled instances with distinct sockets + proxy ports', async () => {
    const idA = hostId();
    const idB = hostId();
    const grove = createGroveId();
    const projA = createProjectId();
    const projB = createProjectId();

    await joinHost(
      { hostRef: idA, key: 'keyA', serverUrl: 'https://a:8080' },
      deps({ enrollmentClient: fakeEnrollment(idA, 'bearer-A', '100.64.0.1:7433', [{ grove_id: grove, project_id: projA }]) }),
    );
    await joinHost(
      { hostRef: idB, key: 'keyB', serverUrl: 'https://b:8080' },
      deps({ enrollmentClient: fakeEnrollment(idB, 'bearer-B', '100.64.0.2:7433', [{ grove_id: grove, project_id: projB }]) }),
    );

    // Two records, DISTINCT persisted proxy_ports (allocated base, base+1).
    expect(readHostRegistry()).toHaveLength(2);
    const recA = getHost(idA)!;
    const recB = getHost(idB)!;
    expect(recA.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE);
    expect(recB.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE + 1);
    expect(recA.proxy_port).not.toBe(recB.proxy_port);
    expect(recA.overlay_address).not.toBe(recB.overlay_address);

    // Two tailscaled instances: DISTINCT labels, sockets, and outbound-proxy ports.
    const labelA = memberTailscaledLabel(idA);
    const labelB = memberTailscaledLabel(idB);
    expect(labelA).not.toBe(labelB);
    const specA = svc.specFor(labelA)!;
    const specB = svc.specFor(labelB)!;
    const socketArg = (s: ServiceSpec) => s.args.find((a) => a.startsWith('--socket='))!;
    const portArg = (s: ServiceSpec) => s.args.find((a) => a.startsWith('--outbound-http-proxy-listen='))!;
    expect(socketArg(specA)).not.toBe(socketArg(specB));
    expect(portArg(specA)).toBe(`--outbound-http-proxy-listen=localhost:${MEMBER_OVERLAY_PROXY_PORT_BASE}`);
    expect(portArg(specB)).toBe(`--outbound-http-proxy-listen=localhost:${MEMBER_OVERLAY_PROXY_PORT_BASE + 1}`);
    expect(svc.isRunning(labelA)).toBe(true);
    expect(svc.isRunning(labelB)).toBe(true);

    // BOTH tailnets were actually joined — B's `up` was NOT skipped because A was
    // up (the old single-tailscaled bug). Distinct sockets ran `up`.
    expect(new Set(runnerState.ups).size).toBe(2);
    expect(runnerState.ups).toContain(socketArg(specA).slice('--socket='.length));
    expect(runnerState.ups).toContain(socketArg(specB).slice('--socket='.length));

    // The proxy dials the CORRECT per-host proxy_port per project.
    const dialPort = (project: string): number | undefined => {
      const d = classifyRoute({ method: 'GET', pathname: '/api/spores', projectId: project as never });
      return d.kind === 'remote' ? d.target.host.proxy_port : undefined;
    };
    expect(dialPort(projA)).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE);
    expect(dialPort(projB)).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE + 1);
  });

  test('leave X tears down ONLY X — Y\'s instance, record, and bearer are untouched', async () => {
    const idA = hostId();
    const idB = hostId();
    await joinHost({ hostRef: idA, key: 'keyA', serverUrl: 'https://a:8080' }, deps({ enrollmentClient: fakeEnrollment(idA, 'bearer-A', '100.64.0.1:7433') }));
    await joinHost({ hostRef: idB, key: 'keyB', serverUrl: 'https://b:8080' }, deps({ enrollmentClient: fakeEnrollment(idB, 'bearer-B', '100.64.0.2:7433') }));

    const labelA = memberTailscaledLabel(idA);
    const labelB = memberTailscaledLabel(idB);

    const result = await leaveHost(idA, deps());
    expect(result.removed).toBe(true);
    expect(result.tailscaledRemoved).toBe(true);

    // X gone.
    expect(getHost(idA)).toBeNull();
    expect(readHostSecrets(idA)[HOST_BEARER_SECRET]).toBeUndefined();
    expect(svc.uninstalled).toContain(labelA);
    // Y intact — record, bearer, and its running tailscaled.
    expect(getHost(idB)).not.toBeNull();
    expect(readHostSecrets(idB)[HOST_BEARER_SECRET]).toBe('bearer-B');
    expect(svc.uninstalled).not.toContain(labelB);
    expect(svc.isRunning(labelB)).toBe(true);
    expect(readHostRegistry()).toHaveLength(1);
  });

  // --- R1: proxy_port, not overlay_address, is the dial disambiguator -------

  test('two hosts at the SAME overlay_address route by their DISTINCT proxy_ports (proxy_port is the disambiguator)', async () => {
    // The real collision: each host is its own tailnet, both handing out
    // 100.64.0.1, so the overlay_address is IDENTICAL. Only the per-host persisted
    // proxy_port can select the right tailnet's tailscaled for the dial. A future
    // refactor that wrongly keyed routing on overlay_address would break here.
    const idA = hostId();
    const idB = hostId();
    const sameAddress = '100.64.0.1:7433';
    const projA = createProjectId();
    const projB = createProjectId();

    await joinHost(
      { hostRef: idA, key: 'keyA', serverUrl: 'https://a:8080' },
      deps({ enrollmentClient: fakeEnrollment(idA, 'bearer-A', sameAddress, [{ grove_id: createGroveId(), project_id: projA }]) }),
    );
    await joinHost(
      { hostRef: idB, key: 'keyB', serverUrl: 'https://b:8080' },
      deps({ enrollmentClient: fakeEnrollment(idB, 'bearer-B', sameAddress, [{ grove_id: createGroveId(), project_id: projB }]) }),
    );

    // Identical overlay_address, DISTINCT persisted proxy_ports.
    expect(getHost(idA)!.overlay_address).toBe(sameAddress);
    expect(getHost(idB)!.overlay_address).toBe(sameAddress);
    expect(getHost(idA)!.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE);
    expect(getHost(idB)!.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE + 1);

    // The proxy dials `CONNECT <overlay_address> via localhost:<proxy_port>`. With
    // the address identical, proxy_port ALONE selects the right host — assert each
    // project resolves to ITS host's proxy_port (and bearer), same address.
    const routeHostFor = (project: string) => {
      const d = classifyRoute({ method: 'GET', pathname: '/api/spores', projectId: project as never });
      if (d.kind !== 'remote') throw new Error(`expected remote route, got ${d.kind}`);
      return { host: d.target.host, bearer: d.target.bearer };
    };
    const a = routeHostFor(projA);
    const b = routeHostFor(projB);
    expect(a.host.overlay_address).toBe(sameAddress);
    expect(b.host.overlay_address).toBe(sameAddress);
    expect(a.host.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE);
    expect(b.host.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE + 1);
    expect(a.host.proxy_port).not.toBe(b.host.proxy_port);
    // Per-host bearer follows the record too, not the shared address.
    expect(a.bearer).toBe('bearer-A');
    expect(b.bearer).toBe('bearer-B');
  });

  // --- idempotency ---------------------------------------------------------

  test('re-join converges: no duplicate, projects preserved, proxy_port persisted, single-use key not re-`up`ed', async () => {
    const id = hostId();
    const grove = createGroveId();
    const project = createProjectId();

    await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-1', '100.64.0.1:7433', [{ grove_id: grove, project_id: project }]) }),
    );
    const createdAt = getHost(id)!.created_at;
    const port = getHost(id)!.proxy_port;
    expect(runnerState.ups).toHaveLength(1);

    await joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'bearer-2', '100.64.0.1:7433', []) }),
    );

    expect(readHostRegistry()).toHaveLength(1);
    const rec = getHost(id)!;
    expect(rec.projects).toEqual([{ grove_id: grove, project_id: project }]);
    expect(rec.created_at).toBe(createdAt);
    expect(rec.proxy_port).toBe(port); // persisted port reused, not re-allocated
    expect(runnerState.ups).toHaveLength(1); // still only the first join ran `tailscale up`
    expect(readHostSecrets(id)[HOST_BEARER_SECRET]).toBe('bearer-2'); // bearer refreshed
  });

  // --- leave (single) ------------------------------------------------------

  test('leave clears the record + bearer and tears down this host\'s LaunchAgent', async () => {
    const id = hostId();
    await joinHost({ hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' }, deps({ enrollmentClient: fakeEnrollment(id, 'bearer-xyz') }));

    const result = await leaveHost(id, deps());
    expect(result.removed).toBe(true);
    expect(result.tailscaledRemoved).toBe(true);
    expect(getHost(id)).toBeNull();
    expect(readHostRegistry()).toHaveLength(0);
    expect(readHostSecrets(id)[HOST_BEARER_SECRET]).toBeUndefined();
    expect(svc.uninstalled).toContain(memberTailscaledLabel(id));
  });

  test('leave is idempotent — an unknown host is a clean no-op', async () => {
    const result = await leaveHost(hostId(), deps());
    expect(result.removed).toBe(false);
    expect(result.tailscaledRemoved).toBe(false);
  });

  // --- readiness poll (start→up race) --------------------------------------

  test('join fails with a socket-not-ready error when the tailscaled socket never appears', async () => {
    const id = hostId();
    await expect(joinHost(
      { hostRef: id, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({ enrollmentClient: fakeEnrollment(id, 'b'), waitForSocket: async () => false }),
    )).rejects.toThrow(/socket .* did not appear/);
  });

  // --- the Task 2.4 enrollment seam (stub) ---------------------------------

  test('the default enrollment stub throws a clear TODO(2.4) error without the manual bridge flags', async () => {
    await expect(stubEnrollmentClient.enroll({
      hostId: hostId(), hostRef: 'x', oneTimeKey: 'k', memberHostname: 'm', memberOverlayIp: '100.64.0.5',
    })).rejects.toThrow(/enrollment is not available yet/);
  });

  test('join works today via the manual enrollment bridge (--overlay-address / --bearer)', async () => {
    const id = hostId();
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
