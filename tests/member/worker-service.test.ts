/**
 * A member's worker as a login service.
 *
 * Rendered and installed against a platform that is recorded rather than run:
 * a test that loaded a real launch agent would start a real worker. Each
 * assertion is a way a worker service fails quietly — it runs under another
 * home than the hooks, it cannot find a harness, it writes nowhere, it never
 * comes back, it restarts all day into a refusal, a second install interrupts
 * the worker the first one started, or an uninstall leaves a unit behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSpec, installService, renderUnit, servicePaths, statusOfService, uninstallService, type ServiceRunner } from '@myco/server/service.js';
import {
  harnessDirectories,
  installWorkerService,
  listWorkerUnits,
  uninstallWorkerService,
  WORKER_RESTART_DELAY_SECONDS,
  workerServiceRefusal,
  workerServiceSpec,
  workerServiceUnit,
  type WorkerServiceTarget,
} from '@myco/runner/service.js';
import {
  describeWorkerService,
  ensuredWorkerWords,
  ensureWorkerService,
  sweepWorkerServices,
  workerServiceWords,
  type WorkerServiceDeps,
} from '@myco/cli/worker-service.js';
import { checkWorkerServices } from '@myco/cli/doctor.js';
import { removeRegistryEntry, writeDeploymentMembership } from '@myco/member/registry.js';
import { holdWorkerInstance } from '@myco/runner/instance.js';
import { readWorkerRefusal, recordWorkerRefusal } from '@myco/runner/refusal.js';
import { resolveMycoHome } from '@myco/paths/home.js';
import { recordingPlatform } from './helpers/service-platform.js';

const URL_ = 'https://myco.example';
const PLATFORMS = ['darwin', 'linux', 'win32'] as const;
const LOGGED_IN = [{ id: 'claude-code', installed: true, authenticated: true }];

let scratch: string;
let home: string;
let mycoHome: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worker-service-'));
  home = path.join(scratch, 'home');
  mycoHome = path.join(home, '.myco-dev');
  fs.mkdirSync(mycoHome, { recursive: true });
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

const target = (over: Partial<WorkerServiceTarget> = {}): WorkerServiceTarget => ({
  serverUrl: URL_, mycoHome, binaryPath: path.join(home, '.myco', 'bin', 'myco'), home, platform: 'darwin', ...over,
});

const member = (at = mycoHome, url = URL_): void => {
  writeDeploymentMembership({ serverUrl: url, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: at });
};

describe('the worker unit', () => {
  for (const platform of PLATFORMS) {
    it(`runs \`worker --server\` for the Deployment under the member home on ${platform}`, () => {
      const spec = workerServiceSpec(target({ platform }), ['/opt/harness/bin']);
      const unit = renderUnit(spec, servicePaths(spec, platform), platform);
      expect(unit).toMatch(platform === 'darwin'
        ? /<string>worker<\/string>\s*<string>--server<\/string>\s*<string>https:\/\/myco\.example<\/string>/
        : /myco worker --server https:\/\/myco\.example/);
      // The hooks read the membership from this home; a worker under any other finds none.
      expect(unit).toContain(platform === 'darwin'
        ? `<key>MYCO_HOME</key><string>${mycoHome}</string>`
        : platform === 'linux' ? `Environment=MYCO_HOME=${mycoHome}` : `set &quot;MYCO_HOME=${mycoHome}&quot;`);
      // A harness found at install is found by the service, which has no login shell's PATH.
      expect(unit).toContain('/opt/harness/bin');
    });

    it(`writes both streams under the member home and restarts after a delay on ${platform}`, () => {
      const spec = workerServiceSpec(target({ platform }), []);
      const paths = servicePaths(spec, platform);
      expect(paths.outLog).toBe(path.join(mycoHome, 'logs', 'worker-myco.example.log'));
      expect(paths.errLog).toBe(path.join(mycoHome, 'logs', 'worker-myco.example.error.log'));
      const unit = renderUnit(spec, paths, platform);
      expect(unit).toContain(paths.outLog);
      expect(unit).toContain(paths.errLog);
      if (platform === 'darwin') expect(unit).toContain(`<key>ThrottleInterval</key><integer>${WORKER_RESTART_DELAY_SECONDS}</integer>`);
      if (platform === 'linux') expect(unit).toContain(`RestartSec=${WORKER_RESTART_DELAY_SECONDS}`);
      if (platform === 'win32') expect(unit).toContain('RestartOnFailure');
    });
  }

  it('names one unit per Deployment per member home, and the same one for either spelling of the address', () => {
    const a = workerServiceUnit(URL_, mycoHome);
    expect(workerServiceUnit(`${URL_}/`, mycoHome)).toEqual(a);
    expect(workerServiceUnit(URL_, path.join(home, '.myco')).label).not.toBe(a.label);
    expect(workerServiceUnit('https://other.example', mycoHome).label).not.toBe(a.label);
    expect(a.label).toMatch(/^co\.goondocks\.myco-worker\.[0-9a-f]{16}$/);
  });

  it('puts the directory of every harness it finds on the service PATH', () => {
    const found: Record<string, string> = { claude: '/Users/dev/.local/bin/claude', codex: '/Users/dev/.nvm/versions/node/v22/bin/codex' };
    expect(harnessDirectories((binary) => found[binary] ?? null)).toEqual(['/Users/dev/.local/bin', '/Users/dev/.nvm/versions/node/v22/bin']);
  });

  for (const platform of PLATFORMS) {
    it(`reads the Deployment and home back from a unit on disk on ${platform}`, () => {
      const spec = workerServiceSpec(target({ platform }), []);
      const { unitFile } = servicePaths(spec, platform);
      fs.mkdirSync(path.dirname(unitFile), { recursive: true });
      fs.writeFileSync(unitFile, renderUnit(spec, servicePaths(spec, platform), platform));
      expect(listWorkerUnits(home, platform)).toEqual([expect.objectContaining({ unitFile, serverUrl: URL_, mycoHome })]);
      expect(listWorkerUnits(home, platform)[0]!.spec.unit.label).toBe(spec.unit.label);
    });
  }
});

describe('installing and removing the worker service', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`installs once, leaves a running worker alone on a second install, and removes it on ${platform}`, () => {
      const rec = recordingPlatform();
      const first = installWorkerService(target({ platform }), [], { runner: rec.runner });
      expect(first).toMatchObject({ loaded: true, running: true, changed: true });
      expect(fs.statSync(first.unitFile).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(path.join(mycoHome, 'logs'))).toBe(true);

      rec.commands.length = 0;
      expect(installWorkerService(target({ platform }), [], { runner: rec.runner })).toMatchObject({ running: true, changed: false });
      // A PATH that differs because the install ran from another shell is no reason to interrupt a run.
      expect(installWorkerService(target({ platform }), ['/opt/new/bin'], { runner: rec.runner })).toMatchObject({ running: true, changed: false });
      expect(rec.commands.every((line) => /launchctl list|is-enabled|is-active/.test(line))).toBe(true);

      // A unit that runs something else is replaced and restarted.
      const moved = installWorkerService(target({ platform, binaryPath: path.join(home, 'bin', 'myco') }), [], { runner: rec.runner });
      expect(moved).toMatchObject({ running: true, changed: true });
      expect(rec.commands.some((line) => /launchctl load|systemctl --user restart/.test(line))).toBe(true);

      expect(uninstallWorkerService(target({ platform }), { runner: rec.runner })).toMatchObject({ removed: true });
      expect(fs.existsSync(first.unitFile)).toBe(false);
      expect(rec.loaded.size).toBe(0);
    });
  }

  it('asks the platform to let go of a unit whose file is already gone', () => {
    for (const platform of PLATFORMS) {
      const rec = recordingPlatform();
      expect(uninstallWorkerService(target({ platform }), { runner: rec.runner })).toMatchObject({ removed: false });
      const label = workerServiceUnit(URL_, mycoHome);
      const expected = platform === 'darwin'
        ? `launchctl remove ${label.label}`
        : platform === 'linux' ? `systemctl --user disable --now ${label.unitName}.service` : `schtasks /Delete /TN ${label.unitName} /F`;
      expect({ platform, asked: rec.commands.includes(expected) }).toEqual({ platform, asked: true });
      // The Deployment's own unit is let go the same way.
      const server = recordingPlatform();
      uninstallService(defaultSpec(path.join(home, '.myco', 'bin', 'myco'), home, platform), { platform, runner: server.runner });
      expect({ platform, commands: server.commands.length > 0 }).toEqual({ platform, commands: true });
    }
  });

  it('starts an enabled unit whose process failed, and does not call it running', () => {
    const rec = recordingPlatform();
    const spec = workerServiceSpec(target({ platform: 'linux' }), []);
    rec.dies.add(spec.unit.unitName);
    installWorkerService(target({ platform: 'linux' }), [], { runner: rec.runner });
    expect(statusOfService(spec, { platform: 'linux', runner: rec.runner })).toMatchObject({ loaded: true, running: false });

    rec.dies.clear();
    rec.commands.length = 0;
    expect(installWorkerService(target({ platform: 'linux' }), [], { runner: rec.runner })).toMatchObject({ running: true, changed: true });
    expect(rec.commands).toContain(`systemctl --user restart ${spec.unit.unitName}.service`);
  });

  it('restarts the Deployment on every install, so it runs what its unit now says', () => {
    const rec = recordingPlatform();
    const spec = defaultSpec(path.join(home, '.myco', 'bin', 'myco'), home, 'darwin');
    installService(spec, { platform: 'darwin', runner: rec.runner });
    rec.commands.length = 0;
    expect(installService(spec, { platform: 'darwin', runner: rec.runner })).toMatchObject({ running: true, changed: true });
    expect(rec.commands).toContain(`launchctl load -w ${servicePaths(spec, 'darwin').unitFile}`);
  });

  it('reports a unit the platform would not load rather than assuming it runs', () => {
    const refusing: ServiceRunner = (command, args) => ({ status: [command, ...args].join(' ').startsWith('launchctl list') ? 113 : 0 });
    const outcome = installWorkerService(target(), [], { runner: refusing });
    expect(outcome.loaded).toBe(false);
    expect(outcome.detail).toMatch(/not holding it/);
  });
});

describe('when a worker service belongs on this machine', () => {
  const pre = { member: true, ownDeploymentUrls: [] as string[], harnesses: LOGGED_IN };

  it('needs a membership, a Deployment that runs no worker of its own here, and a harness logged in', () => {
    expect(workerServiceRefusal(URL_, pre)).toBeNull();
    expect(workerServiceRefusal(URL_, { ...pre, member: false })?.reason).toBe('no_membership');
    expect(workerServiceRefusal(URL_, { ...pre, ownDeploymentUrls: ['http://127.0.0.1:8787', `${URL_}/`] })?.reason).toBe('own_deployment');
    const none = workerServiceRefusal(URL_, { ...pre, harnesses: [{ id: 'codex', installed: true, authenticated: false }] });
    expect(none?.reason).toBe('no_harness');
    expect(none?.detail).toContain('installed: codex');
  });

  const deps = (over: WorkerServiceDeps = {}): WorkerServiceDeps & { rec: ReturnType<typeof recordingPlatform> } => {
    const rec = recordingPlatform();
    return {
      rec, mycoHome, home, platform: 'darwin', binaryPath: path.join(home, '.myco', 'bin', 'myco'), runner: rec.runner,
      detect: () => LOGGED_IN, harnessDirs: () => [], ownDeploymentUrls: async () => [], admission: async () => 'admitted',
      lockDir: path.join(scratch, 'locks'), now: () => 1_800_000_000_000, ...over,
    };
  };

  it('installs for an administrator\'s membership with a logged-in harness, and twice is the same as once', async () => {
    member();
    const d = deps();
    expect((await ensureWorkerService(URL_, d)).kind).toBe('installed');
    const second = await ensureWorkerService(URL_, d);
    expect(second).toMatchObject({ kind: 'installed', outcome: { running: true, changed: false } });
    expect(ensuredWorkerWords(second).line).toMatch(/^the worker was already running/);
  });

  it('refuses a membership the Deployment will not admit as a worker, records why, and does not install over the record', async () => {
    member();
    const refused = await ensureWorkerService(URL_, deps({ admission: async () => 'not_admin' }));
    expect(refused).toMatchObject({ kind: 'refused', refusal: { reason: 'not_admin' } });
    expect(ensuredWorkerWords(refused).ok).toBe(true);
    expect(readWorkerRefusal(mycoHome, URL_)?.code).toBe('not_admin');
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents'))).toBe(false);

    // The Deployment cannot be asked again: the recorded refusal stands, until forced.
    const later = await ensureWorkerService(URL_, deps({ admission: async () => 'unknown' }));
    expect(later).toMatchObject({ kind: 'refused', refusal: { reason: 'not_admin', detail: expect.stringContaining('--force') } });
    expect((await ensureWorkerService(URL_, deps({ admission: async () => 'unknown', force: true } as WorkerServiceDeps))).kind).toBe('installed');
    // The worker it starts records a refusal again if the Deployment still has one.
    expect(readWorkerRefusal(mycoHome, URL_)).toBeNull();
  });

  it('refuses a development build for the default home, before asking anything', async () => {
    let asked = false;
    const outcome = await ensureWorkerService(URL_, deps({
      mycoHome: resolveMycoHome({ env: {} }),
      binaryPath: '/Users/dev/Repos/myco/packages/myco-darwin-arm64/bin/myco',
      detect: () => { asked = true; return LOGGED_IN; },
    }));
    expect(outcome).toMatchObject({ kind: 'unsupported', detail: expect.stringContaining('development build') });
    expect(asked).toBe(false);
  });

  it('refuses before detecting anything when this process is not the installed binary', async () => {
    member();
    let detected = false;
    const outcome = await ensureWorkerService(URL_, deps({ binaryPath: '/opt/homebrew/bin/bun', detect: () => { detected = true; return LOGGED_IN; } }));
    expect(outcome.kind).toBe('unsupported');
    expect(detected).toBe(false);
  });

  it('writes nothing for a home with no membership, or for the Deployment this machine runs itself', async () => {
    const d = deps();
    expect(await ensureWorkerService(URL_, d)).toMatchObject({ kind: 'refused', refusal: { reason: 'no_membership' } });
    member();
    expect(await ensureWorkerService(URL_, deps({ ownDeploymentUrls: async () => [URL_] }))).toMatchObject({ kind: 'refused', refusal: { reason: 'own_deployment' } });
    expect(d.rec.commands).toEqual([]);
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents'))).toBe(false);
  });

  it('says whether the service is installed, running, and which process serves the Deployment', async () => {
    member();
    const d = deps();
    expect(workerServiceWords(describeWorkerService(URL_, d))).toMatchObject({ status: 'warn', line: expect.stringMatching(/^not installed, and no worker on this machine serves this Deployment/) });
    await ensureWorkerService(URL_, d);
    expect(workerServiceWords(describeWorkerService(URL_, d))).toMatchObject({ status: 'warn', line: expect.stringMatching(/^running at login, and not yet serving/) });

    const held = holdWorkerInstance(d.lockDir!, [URL_]);
    if (!held.held) throw new Error('the lock should be free');
    try {
      expect(workerServiceWords(describeWorkerService(URL_, d))).toMatchObject({ status: 'ok', line: expect.stringContaining(`process ${process.pid} is serving this Deployment`) });
    } finally {
      held.release();
    }
    expect(workerServiceWords(null).status).toBe('warn');
  });

  it('tells a membership that cannot run a worker so, and never to install one', async () => {
    member();
    recordWorkerRefusal(mycoHome, URL_, 'not_admin', 1);
    const words = workerServiceWords(describeWorkerService(URL_, deps()));
    expect(words).toEqual({ status: 'ok', line: 'no worker: this membership is not an administrator\'s, so it cannot run work for this Deployment' });
    const [check] = await checkWorkerServices(scratch, deps());
    expect(check).toMatchObject({ status: 'ok' });
    expect(check!.detail).not.toContain('worker install');

    recordWorkerRefusal(mycoHome, URL_, 'unauthorized', 2);
    expect(workerServiceWords(describeWorkerService(URL_, deps()))).toMatchObject({ status: 'warn', line: expect.stringContaining('myco login') });
  });
});

describe('removing every worker unit a home is responsible for', () => {
  it('removes this home\'s units and units whose membership is gone, and leaves another home\'s live one', () => {
    const rec = recordingPlatform();
    const other = path.join(home, '.myco');
    const gone = path.join(home, '.myco-gone');
    member();
    member(other, 'https://other.example');
    for (const [at, url] of [[mycoHome, URL_], [other, 'https://other.example'], [gone, 'https://gone.example']] as const) {
      installWorkerService(target({ mycoHome: at, serverUrl: url }), [], { runner: rec.runner });
    }
    // A membership whose unit file is already gone is still unregistered.
    member(mycoHome, 'https://second.example');

    rec.commands.length = 0;
    const removed = sweepWorkerServices({ mycoHome, home, platform: 'darwin', runner: rec.runner });
    expect(removed.map((file) => path.basename(file)).sort()).toEqual([
      `${workerServiceUnit(URL_, mycoHome).label}.plist`,
      `${workerServiceUnit('https://gone.example', gone).label}.plist`,
    ].sort());
    expect(listWorkerUnits(home, 'darwin').map((u) => u.mycoHome)).toEqual([other]);
    expect(rec.commands).toContain(`launchctl remove ${workerServiceUnit('https://second.example', mycoHome).label}`);
    expect([...rec.loaded]).toEqual([workerServiceUnit('https://other.example', other).label]);
  });

  it('removes a unit whose home left its last project', () => {
    const rec = recordingPlatform();
    const other = path.join(home, '.myco');
    member(other, 'https://other.example');
    installWorkerService(target({ mycoHome: other, serverUrl: 'https://other.example' }), [], { runner: rec.runner });
    removeRegistryEntry('/nowhere', other);
    fs.rmSync(path.join(other, 'member', 'deployments'), { recursive: true, force: true });
    expect(sweepWorkerServices({ mycoHome, home, platform: 'darwin', runner: rec.runner })).toHaveLength(1);
    expect(listWorkerUnits(home, 'darwin')).toEqual([]);
  });
});
