import { describe, expect, test, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemdUserServiceManager, type SystemctlRunner } from '../../packages/myco/src/member/legacy-service/systemd';

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

const spec = (home: string) => ({
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

  test('uninstall stops, disables, removes file, daemon-reloads', async () => {
    const s = spec(home);
    fs.writeFileSync(path.join(unitDir, s.label + '.service'), '[Service]');
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
    fs.writeFileSync(path.join(unitDir, s.label + '.service'), '[Service]');
    const unitPath = path.join(unitDir, `${s.label}.service`);
    runner.calls.length = 0;
    runner.exitOverrides.set('stop', { stdout: 'Failed to connect to bus', exitCode: 1 });

    await expect(mgr.uninstall(s.label)).rejects.toThrow(/systemctl --user stop.*failed.*exit 1/i);

    expect(fs.existsSync(unitPath)).toBe(true);
    expect(runner.calls.some((call) => call.includes('disable'))).toBe(false);
  });

  test('uninstall polls systemd until MainPID=0 and ActiveState=inactive', async () => {
    const s = spec(home);
    fs.writeFileSync(path.join(unitDir, s.label + '.service'), '[Service]');
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
    fs.writeFileSync(path.join(unitDir, s.label + '.service'), '[Service]');
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
    fs.writeFileSync(path.join(unitDir, s.label + '.service'), '[Service]');
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
});
