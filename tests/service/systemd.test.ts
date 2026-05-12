import { describe, expect, test, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemdUserServiceManager, type SystemctlRunner } from '../../packages/myco/src/service/systemd';
import type { ServiceSpec } from '../../packages/myco/src/service/types';

class FakeRunner implements SystemctlRunner {
  calls: string[][] = [];
  showResponse = '';
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    this.calls.push(args);
    if (args[0] === 'show') return { stdout: this.showResponse, exitCode: 0 };
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

  test('install writes <label>.service, daemon-reloads, enables, starts', async () => {
    const s = spec(home);
    await mgr.install(s);
    const unitPath = path.join(unitDir, `${s.label}.service`);
    expect(fs.existsSync(unitPath)).toBe(true);
    expect(runner.calls[0]).toEqual(['--user', 'daemon-reload']);
    expect(runner.calls[1]).toEqual(['--user', 'enable', `${s.label}.service`]);
    expect(runner.calls[2]).toEqual(['--user', 'start', `${s.label}.service`]);
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
      ['--user', 'stop', `${s.label}.service`],
      ['--user', 'disable', `${s.label}.service`],
      ['--user', 'daemon-reload'],
    ]);
    expect(fs.existsSync(path.join(unitDir, `${s.label}.service`))).toBe(false);
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

  test('platformName is "systemd --user"', () => {
    expect(mgr.platformName).toBe('systemd --user');
  });
});
