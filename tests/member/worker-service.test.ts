/**
 * A member's worker as a login service.
 *
 * Rendered and installed against a platform that is recorded rather than run:
 * a test that loaded a real launch agent would start a real worker. Each
 * assertion is a way a worker service fails quietly — it runs under another
 * home than the hooks, it cannot find a harness, it writes nowhere, it never
 * comes back, or a second install restarts the worker the first one started.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderUnit, servicePaths, type CommandResult, type ServiceRunner } from '@myco/server/service.js';
import {
  harnessDirectories,
  installWorkerService,
  uninstallWorkerService,
  WORKER_RESTART_DELAY_SECONDS,
  workerServiceRefusal,
  workerServiceSpec,
  workerServiceUnit,
  type WorkerServiceTarget,
} from '@myco/runner/service.js';
import { describeWorkerService, ensureWorkerService, workerServiceWords, type WorkerServiceDeps } from '@myco/cli/worker-service.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { holdWorkerInstance } from '@myco/runner/instance.js';

const URL_ = 'https://myco.example';
const PLATFORMS = ['darwin', 'linux', 'win32'] as const;
const LOGGED_IN = [{ id: 'claude-code', installed: true, authenticated: true }];

/**
 * A platform that records every command and answers the status probe from
 * what it was told to load, the way launchd and systemd do.
 */
function recordingPlatform(): { runner: ServiceRunner; commands: string[][]; loaded: Set<string> } {
  const commands: string[][] = [];
  const loaded = new Set<string>();
  const runner: ServiceRunner = (command, args): CommandResult => {
    commands.push([command, ...args]);
    const joined = [command, ...args].join(' ');
    if (joined.startsWith('launchctl load')) loaded.add(path.basename(args.at(-1)!, '.plist'));
    else if (joined.startsWith('launchctl unload')) loaded.delete(path.basename(args.at(-1)!, '.plist'));
    else if (joined.startsWith('launchctl list')) return { status: loaded.has(args.at(-1)!) ? 0 : 113 };
    else if (joined.startsWith('systemctl --user enable')) loaded.add(args.at(-1)!.replace(/\.service$/, ''));
    else if (joined.startsWith('systemctl --user disable')) loaded.delete(args.at(-1)!.replace(/\.service$/, ''));
    else if (joined.startsWith('systemctl --user is-enabled')) return { status: loaded.has(args.at(-1)!.replace(/\.service$/, '')) ? 0 : 1 };
    return { status: 0 };
  };
  return { runner, commands, loaded };
}

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
});

describe('installing and removing the worker service', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`installs once, leaves a running worker alone on a second install, and removes it on ${platform}`, () => {
      const platformRec = recordingPlatform();
      const first = installWorkerService(target({ platform }), [], { runner: platformRec.runner });
      expect(first).toMatchObject({ loaded: true, changed: true });
      expect(fs.existsSync(first.unitFile)).toBe(true);
      expect(fs.statSync(first.unitFile).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(path.join(mycoHome, 'logs'))).toBe(true);

      platformRec.commands.length = 0;
      const second = installWorkerService(target({ platform }), [], { runner: platformRec.runner });
      expect(second).toMatchObject({ loaded: true, changed: false });
      // Only the status probe: nothing unloaded, nothing restarted.
      expect(platformRec.commands.every(([command, ...args]) => [command, ...args].join(' ').match(/launchctl list|is-enabled/))).toBe(true);

      const moved = installWorkerService(target({ platform }), ['/opt/new/bin'], { runner: platformRec.runner });
      expect(moved).toMatchObject({ loaded: true, changed: true });

      expect(uninstallWorkerService(target({ platform }), { runner: platformRec.runner })).toMatchObject({ removed: true });
      expect(fs.existsSync(first.unitFile)).toBe(false);
      expect(platformRec.loaded.size).toBe(0);

      platformRec.commands.length = 0;
      expect(uninstallWorkerService(target({ platform }), { runner: platformRec.runner })).toMatchObject({ removed: false });
      expect(platformRec.commands).toEqual([]);
    });
  }

  it('reports a unit the platform would not load rather than assuming it runs', () => {
    const refusing: ServiceRunner = (command, args) => ({ status: [command, ...args].join(' ').startsWith('launchctl list') ? 113 : 0 });
    const outcome = installWorkerService(target(), [], { runner: refusing });
    expect(outcome.loaded).toBe(false);
    expect(outcome.detail).toMatch(/platform is not running it/);
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

  const deps = (over: WorkerServiceDeps = {}): WorkerServiceDeps & { platformRec: ReturnType<typeof recordingPlatform> } => {
    const platformRec = recordingPlatform();
    return {
      platformRec, mycoHome, home, platform: 'darwin', binaryPath: path.join(home, '.myco', 'bin', 'myco'), runner: platformRec.runner,
      detect: () => LOGGED_IN, harnessDirs: () => [], ownDeploymentUrls: async () => [], lockDir: path.join(scratch, 'locks'), ...over,
    };
  };
  const member = (): void => {
    writeDeploymentMembership({ serverUrl: URL_, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
  };

  it('installs for a member with a logged-in harness, and twice is the same as once', async () => {
    member();
    const d = deps();
    const first = await ensureWorkerService(URL_, d);
    expect(first.kind).toBe('installed');
    const second = await ensureWorkerService(URL_, d);
    expect(second).toMatchObject({ kind: 'installed', outcome: { loaded: true, changed: false } });
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
    expect(d.platformRec.commands).toEqual([]);
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents'))).toBe(false);
  });

  it('says whether the service is installed, held by the platform, and which process serves the Deployment', async () => {
    member();
    const d = deps();
    expect(workerServiceWords(describeWorkerService(URL_, d))).toMatchObject({ ok: false, line: expect.stringMatching(/^not installed, and no worker on this machine serves this Deployment/) });
    await ensureWorkerService(URL_, d);
    expect(workerServiceWords(describeWorkerService(URL_, d))).toMatchObject({ ok: false, line: expect.stringMatching(/^running at login, and no worker holds this Deployment yet/) });

    const held = holdWorkerInstance(d.lockDir!, [URL_]);
    if (!held.held) throw new Error('the lock should be free');
    try {
      expect(workerServiceWords(describeWorkerService(URL_, d))).toMatchObject({ ok: true, line: expect.stringContaining(`process ${process.pid} is serving this Deployment`) });
    } finally {
      held.release();
    }
    expect(workerServiceWords(null).ok).toBe(false);
  });
});
