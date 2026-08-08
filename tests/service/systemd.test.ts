import { describe, expect, test, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemdUserServiceManager, type SystemctlRunner } from '../../packages/myco/src/service/systemd';
import type { ServiceSpec } from '../../packages/myco/src/service/types';

class FakeRunner implements SystemctlRunner {
  calls: string[][] = [];
  showResponse = 'MainPID=4321\nActiveState=active\n';
  showExitCode = 0;
  showResponses: Array<{ stdout: string; exitCode: number }> = [];
  inspectResponse: { stdout: string; exitCode: number } | null = null;
  exitAfterStop = true;
  /** Map from systemctl subcommand (e.g. "restart") to forced exit code+stdout. */
  exitOverrides: Map<string, { stdout: string; exitCode: number }> = new Map();
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    this.calls.push(args);
    if (args.includes('show')) {
      if (args.includes('--property=FragmentPath')) {
        return this.inspectResponse ?? { stdout: '', exitCode: 0 };
      }
      return this.showResponses.shift()
        ?? { stdout: this.showResponse, exitCode: this.showExitCode };
    }
    for (const [key, override] of this.exitOverrides) {
      if (args.includes(key)) return override;
    }
    if (args.includes('stop') && this.exitAfterStop && this.showResponses.length === 0) {
      this.showResponse = 'MainPID=0\nExecMainStatus=0\nActiveState=inactive\n';
    }
    return { stdout: '', exitCode: 0 };
  }
}

function fakeBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bin-'));
  const bin = path.join(dir, 'myco');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

const spec = (home: string): ServiceSpec => ({
  label: 'co.goondocks.myco.test',
  variant: 'prod',
  executable: fakeBinary(),
  args: ['daemon'],
  workingDir: home,
  env: { MYCO_HOME: home, PATH: '/usr/bin:/bin' },
  stdoutPath: path.join(home, 'service', 'logs', 'daemon.out.log'),
  stderrPath: path.join(home, 'service', 'logs', 'daemon.err.log'),
  runAtLoad: true,
  keepAlive: true,
  throttleSeconds: 10,
});

describe('SystemdUserServiceManager', () => {
  let runner: FakeRunner;
  let home: string;
  let unitDir: string;
  let mgr: SystemdUserServiceManager;

  beforeEach(() => {
    runner = new FakeRunner();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-systemd-home-'));
    unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-systemd-units-'));
    mgr = new SystemdUserServiceManager({ runner, unitDir });
  });

  test('install RE-CREATES a removed log directory, even when the unit is unchanged', async () => {
    // systemd redirects the daemon's output to an absolute path and will not
    // create the parent: a missing directory fails the unit with
    // `status=209/STDOUT` before the daemon runs at all. Install used to make
    // these dirs only on the write path, so a home that lost them after install
    // — and any re-install whose unit file was byte-identical, which returns
    // early — left the service crash-looping. Measured on the rig: 41 restarts,
    // every one reported as a successful start.
    const s = spec(home);
    await mgr.install(s);
    expect(fs.existsSync(path.dirname(s.stdoutPath))).toBe(true);

    fs.rmSync(path.join(home, 'service'), { recursive: true, force: true });
    expect(fs.existsSync(path.dirname(s.stdoutPath))).toBe(false);

    // Byte-identical unit -> install takes the early return. The directories
    // must still come back.
    await mgr.install(s);
    expect(fs.existsSync(path.dirname(s.stdoutPath))).toBe(true);
    expect(fs.existsSync(path.dirname(s.stderrPath))).toBe(true);
  });

  test('install writes <label>.service, daemon-reloads, enables (no auto-start)', async () => {
    const s = spec(home);
    await mgr.install(s);
    const unitPath = path.join(unitDir, `${s.label}.service`);
    expect(fs.existsSync(unitPath)).toBe(true);
    expect(runner.calls[0]).toEqual(['--user', 'daemon-reload']);
    expect(runner.calls[1]).toEqual(['--user', 'enable', `${s.label}.service`]);
    expect(runner.calls.length).toBe(2);
  });

  test('install is idempotent on identical spec', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.calls.length = 0;
    await mgr.install(s);
    expect(runner.calls).toEqual([]);
  });

  test('uninstall stops, disables, removes file, daemon-reloads', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.calls.length = 0;
    await mgr.uninstall(s.label);
    expect(runner.calls).toEqual([
      [
        '--user', 'show', `${s.label}.service`,
        '--property=MainPID',
        '--property=ActiveState',
      ],
      ['--user', 'stop', `${s.label}.service`],
      [
        '--user', 'show', `${s.label}.service`,
        '--property=MainPID',
        '--property=ActiveState',
      ],
      ['--user', 'disable', `${s.label}.service`],
      ['--user', 'daemon-reload'],
    ]);
    expect(fs.existsSync(path.join(unitDir, `${s.label}.service`))).toBe(false);
  });

  test('uninstall rejects a failed stop and preserves the unit file', async () => {
    const s = spec(home);
    await mgr.install(s);
    const unitPath = path.join(unitDir, `${s.label}.service`);
    runner.calls.length = 0;
    runner.exitOverrides.set('stop', { stdout: 'Failed to connect to bus', exitCode: 1 });

    await expect(mgr.uninstall(s.label)).rejects.toThrow(/systemctl --user stop.*failed.*exit 1/i);

    expect(fs.existsSync(unitPath)).toBe(true);
    expect(runner.calls.some((call) => call.includes('disable'))).toBe(false);
  });

  test('uninstall polls systemd until MainPID=0 and ActiveState=inactive', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.calls.length = 0;
    runner.exitAfterStop = false;
    runner.showResponses = [
      { stdout: 'MainPID=4321\nActiveState=active\n', exitCode: 0 },
      { stdout: 'MainPID=4321\nActiveState=deactivating\n', exitCode: 0 },
      { stdout: 'MainPID=0\nActiveState=inactive\n', exitCode: 0 },
    ];
    mgr = new SystemdUserServiceManager({ runner, unitDir, sleep: async () => {} });

    await mgr.uninstall(s.label);

    expect(runner.calls.filter((call) => call.includes('show'))).toHaveLength(3);
    expect(fs.existsSync(path.join(unitDir, `${s.label}.service`))).toBe(false);
  });

  test('uninstall stops a loaded systemd service even when its unit file is absent', async () => {
    const label = 'co.goondocks.myco.orphaned';
    runner.showResponses = [
      { stdout: 'MainPID=4321\nActiveState=active\n', exitCode: 0 },
      { stdout: 'MainPID=0\nActiveState=inactive\n', exitCode: 0 },
    ];

    await mgr.uninstall(label);

    expect(runner.calls.some((call) => call.includes('stop'))).toBe(true);
    expect(runner.calls.some((call) => call.includes('disable'))).toBe(true);
    expect(runner.calls.at(-1)).toEqual(['--user', 'daemon-reload']);
  });

  test('uninstall is idempotent when the unit file and systemd service are already absent', async () => {
    const label = 'co.goondocks.myco.absent';
    runner.showExitCode = 4;
    runner.showResponse = 'Unit not found';

    await mgr.uninstall(label);

    expect(runner.calls).toEqual([[
      '--user', 'show', `${label}.service`,
      '--property=MainPID',
      '--property=ActiveState',
    ]]);
  });

  test('uninstall rejects an inconclusive systemd query failure', async () => {
    const label = 'co.goondocks.myco.unknown';
    runner.showExitCode = 1;
    runner.showResponse = 'Failed to connect to bus';

    await expect(mgr.uninstall(label)).rejects.toThrow(/systemctl --user show.*failed.*exit 1/i);
  });

  test('uninstall rejects an inactive response with no MainPID proof', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.calls.length = 0;
    runner.exitAfterStop = false;
    runner.showResponses = [
      { stdout: 'MainPID=4321\nActiveState=active\n', exitCode: 0 },
      { stdout: 'ActiveState=inactive\n', exitCode: 0 },
    ];
    mgr = new SystemdUserServiceManager({ runner, unitDir, sleep: async () => {} });

    await expect(mgr.uninstall(s.label)).rejects.toThrow(/missing or invalid MainPID/i);

    expect(fs.existsSync(path.join(unitDir, `${s.label}.service`))).toBe(true);
  });

  test('uninstall times out while systemd still reports a live process and preserves the unit', async () => {
    const s = spec(home);
    await mgr.install(s);
    const unitPath = path.join(unitDir, `${s.label}.service`);
    runner.calls.length = 0;
    runner.exitAfterStop = false;
    runner.showResponse = 'MainPID=4321\nActiveState=deactivating\n';
    mgr = new SystemdUserServiceManager({ runner, unitDir, sleep: async () => {} });

    await expect(mgr.uninstall(s.label)).rejects.toThrow(/timed out.*systemd.*stop/i);

    expect(runner.calls.filter((call) => call.includes('show')).length).toBeGreaterThan(1);
    expect(fs.existsSync(unitPath)).toBe(true);
    expect(runner.calls.some((call) => call.includes('disable'))).toBe(false);
  });

  test('status parses MainPID and ExecMainStatus from systemctl show', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.showResponse = 'MainPID=4242\nExecMainStatus=0\nActiveState=active\n';
    const st = await mgr.status(s.label);
    expect(st.installed).toBe(true);
    expect(st.running).toBe(true);
    expect(st.pid).toBe(4242);
    expect(st.lastExitCode).toBe(0);
  });

  test('status reports running=false when MainPID=0', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.showResponse = 'MainPID=0\nExecMainStatus=78\nActiveState=failed\n';
    const st = await mgr.status(s.label);
    expect(st.running).toBe(false);
    expect(st.pid).toBe(null);
    expect(st.lastExitCode).toBe(78);
  });

  test('inspect returns the exact executable and arguments from the installed unit', async () => {
    const s = spec(home);
    s.args = ['daemon', '--port', '28876', '--home', 'path with spaces'];
    await mgr.install(s);
    runner.inspectResponse = {
      stdout: `FragmentPath=${path.join(unitDir, `${s.label}.service`)}\nDropInPaths=\n`,
      exitCode: 0,
    };

    await expect(mgr.inspect(s.label)).resolves.toEqual({
      executable: s.executable,
      args: s.args,
    });
  });

  test('inspect fails closed for a malformed installed unit', async () => {
    const label = 'co.goondocks.myco.malformed';
    fs.writeFileSync(
      path.join(unitDir, `${label}.service`),
      '[Unit]\nExecStart="/plausible" "daemon" "--port" "28876"\n[Service]\nType=simple\n',
    );
    runner.inspectResponse = {
      stdout: `FragmentPath=${path.join(unitDir, `${label}.service`)}\nDropInPaths=\n`,
      exitCode: 0,
    };

    await expect(mgr.inspect(label)).resolves.toBeNull();
  });

  test('inspect fails closed when systemd reports an effective external drop-in', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.inspectResponse = {
      stdout: [
        `FragmentPath=${path.join(unitDir, `${s.label}.service`)}`,
        'DropInPaths=/etc/systemd/user/service.d/override.conf',
        '',
      ].join('\n'),
      exitCode: 0,
    };

    await expect(mgr.inspect(s.label)).resolves.toBeNull();
  });

  test('inspect returns null when a live systemd service has no installed unit file', async () => {
    const label = 'co.goondocks.myco.orphaned';
    runner.showResponse = 'MainPID=4321\nExecMainStatus=0\nActiveState=active\n';

    const status = await mgr.status(label);
    expect(status).toMatchObject({ installed: false, running: true, pid: 4321 });
    await expect(mgr.inspect(label)).resolves.toBeNull();
  });

  test('platformName is "systemd --user"', () => {
    expect(mgr.platformName).toBe('systemd --user');
  });

  test('restart issues `--user restart <label>.service` and succeeds on exit 0', async () => {
    await mgr.restart('co.goondocks.myco');
    expect(runner.calls).toEqual([['--user', 'restart', 'co.goondocks.myco.service']]);
  });

  test('restart throws when systemctl exits non-zero', async () => {
    runner.exitOverrides.set('restart', { stdout: 'Unit not loaded', exitCode: 5 });
    await expect(mgr.restart('co.goondocks.missing')).rejects.toThrow(/systemctl.*restart.*exit 5/i);
  });

  test('start throws when systemctl exits non-zero (no silent success)', async () => {
    runner.exitOverrides.set('start', { stdout: 'Failed to connect to bus', exitCode: 1 });
    await expect(mgr.start('co.goondocks.myco')).rejects.toThrow(/systemctl.*start.*exit 1/i);
  });

  test('install throws when systemctl enable fails (no silent success)', async () => {
    runner.exitOverrides.set('enable', { stdout: 'Failed to connect to bus', exitCode: 1 });
    await expect(mgr.install(spec(home))).rejects.toThrow(/systemctl.*enable.*exit 1/i);
  });

  test('restartShellCommand returns the literal `systemctl --user restart <label>.service`', () => {
    // Baked into the detached update / restart script after the daemon exits.
    expect(mgr.restartShellCommand('co.goondocks.myco')).toBe(
      'systemctl --user restart co.goondocks.myco.service',
    );
    expect(mgr.restartShellCommand('co.goondocks.myco-dev')).toBe(
      'systemctl --user restart co.goondocks.myco-dev.service',
    );
  });

  test('isInstalled returns true after install, false after uninstall', async () => {
    const s = spec(home);
    expect(await mgr.isInstalled(s.label)).toBe(false);
    await mgr.install(s);
    expect(await mgr.isInstalled(s.label)).toBe(true);
    await mgr.uninstall(s.label);
    expect(await mgr.isInstalled(s.label)).toBe(false);
  });
});
