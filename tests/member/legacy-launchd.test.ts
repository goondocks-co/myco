import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LaunchdServiceManager, type LaunchctlRunner } from '../../packages/myco/src/member/legacy-service/launchd';

class FakeRunner implements LaunchctlRunner {
  calls: string[][] = [];
  printResponse = '';
  printExitCode = 0;
  printResponses: Array<{ stdout: string; exitCode: number }> = [];
  exitAfterBootout = true;
  /** Map from first arg ("kickstart", "kill", ...) to forced exit code+stdout. */
  exitOverrides: Map<string, { stdout: string; exitCode: number }> = new Map();
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    this.calls.push(args);
    if (args[0] === 'print') {
      return this.printResponses.shift()
        ?? { stdout: this.printResponse, exitCode: this.printExitCode };
    }
    const override = this.exitOverrides.get(args[0]);
    if (override) return override;
    if (args[0] === 'bootout' && this.exitAfterBootout && this.printResponses.length === 0) {
      this.printExitCode = 1;
      this.printResponse = 'Could not find service';
    }
    return { stdout: '', exitCode: 0 };
  }
}

function tmpHome(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-launchd-')); }

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

describe('LaunchdServiceManager', () => {
  let runner: FakeRunner;
  let home: string;
  let agentsDir: string;
  let mgr: LaunchdServiceManager;

  beforeEach(() => {
    runner = new FakeRunner();
    home = tmpHome();
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-agents-'));
    mgr = new LaunchdServiceManager({ runner, agentsDir, uid: 501 });
  });

  test('a scoped uninstall preserves stale sibling services', async () => {
    const owned = spec(home);
    const sibling = { ...spec(home), label: 'co.goondocks.myco-other', executable: '/missing/other/myco' };
    const scoped = new LaunchdServiceManager({ runner, agentsDir, uid: 501,  });
    fs.writeFileSync(path.join(agentsDir, owned.label + '.plist'), '<plist/>');
    const siblingPath = path.join(agentsDir, `${sibling.label}.plist`);
    const siblingContent = '<plist>foreign sibling</plist>';
    fs.writeFileSync(siblingPath, siblingContent);
    await scoped.uninstall(owned.label);
    expect(fs.existsSync(path.join(agentsDir, `${owned.label}.plist`))).toBe(false);
    expect(fs.readFileSync(siblingPath, 'utf8')).toBe(siblingContent);
    expect(runner.calls.some((args) => args.some((arg) => arg.includes(sibling.label)))).toBe(false);
  });

  test('uninstall removes an unloaded login unit when no GUI domain exists', async () => {
    const owned = spec(home);
    fs.writeFileSync(path.join(agentsDir, owned.label + '.plist'), '<plist/>');
    runner.printExitCode = 125;
    runner.printResponse = 'Could not print domain: 125: Domain does not support specified action';
    await mgr.uninstall(owned.label);
    expect(fs.existsSync(path.join(agentsDir, `${owned.label}.plist`))).toBe(false);
    expect(runner.calls.some((args) => args[0] === 'bootout')).toBe(false);
  });

  test('uninstall runs bootout and removes the plist', async () => {
    const s = spec(home);
    fs.writeFileSync(path.join(agentsDir, s.label + '.plist'), '<plist/>');
    const plistPath = path.join(agentsDir, `${s.label}.plist`);
    runner.calls.length = 0;
    await mgr.uninstall(s.label);
    expect(runner.calls).toEqual([
      ['print', `gui/501/${s.label}`],
      ['bootout', `gui/501/${s.label}`],
      ['print', `gui/501/${s.label}`],
    ]);
    expect(fs.existsSync(plistPath)).toBe(false);
  });

  test('uninstall rejects a failed bootout and preserves the plist', async () => {
    const s = spec(home);
    fs.writeFileSync(path.join(agentsDir, s.label + '.plist'), '<plist/>');
    const plistPath = path.join(agentsDir, `${s.label}.plist`);
    runner.calls.length = 0;
    runner.exitOverrides.set('bootout', { stdout: 'Boot-out failed: 5: Input/output error', exitCode: 5 });

    await expect(mgr.uninstall(s.label)).rejects.toThrow(/launchctl bootout.*failed.*exit 5/i);

    expect(fs.existsSync(plistPath)).toBe(true);
    expect(runner.calls.some((call) => call[0] === 'print')).toBe(true);
  });

  test('uninstall polls launchd until a delayed job exit is confirmed', async () => {
    const s = spec(home);
    fs.writeFileSync(path.join(agentsDir, s.label + '.plist'), '<plist/>');
    runner.calls.length = 0;
    runner.exitAfterBootout = false;
    runner.printResponses = [
      { stdout: 'pid = 4321\n', exitCode: 0 },
      { stdout: 'pid = 4321\n', exitCode: 0 },
      { stdout: 'Could not find service\n', exitCode: 1 },
    ];
    mgr = new LaunchdServiceManager({ runner, agentsDir, uid: 501, sleep: async () => {} });

    await mgr.uninstall(s.label);

    expect(runner.calls.filter((call) => call[0] === 'print')).toHaveLength(3);
    expect(fs.existsSync(path.join(agentsDir, `${s.label}.plist`))).toBe(false);
  });

  test('uninstall stops a live launchd job even when its plist is already absent', async () => {
    const label = 'co.goondocks.myco.orphaned';
    runner.printResponses = [
      { stdout: 'pid = 4321\n', exitCode: 0 },
      { stdout: 'Could not find service\n', exitCode: 1 },
    ];

    await mgr.uninstall(label);

    expect(runner.calls).toEqual([
      ['print', `gui/501/${label}`],
      ['bootout', `gui/501/${label}`],
      ['print', `gui/501/${label}`],
    ]);
  });

  test('uninstall is idempotent when the plist and launchd job are already absent', async () => {
    const label = 'co.goondocks.myco.absent';
    runner.printExitCode = 1;
    runner.printResponse = 'Could not find service';

    await mgr.uninstall(label);

    expect(runner.calls).toEqual([['print', `gui/501/${label}`]]);
  });

  test('uninstall rejects an inconclusive launchd query failure', async () => {
    const label = 'co.goondocks.myco.unknown';
    runner.printExitCode = 5;
    runner.printResponse = 'Input/output error';

    await expect(mgr.uninstall(label)).rejects.toThrow(/launchctl print.*failed.*exit 5/i);
  });

  test('uninstall times out while launchd still reports the job and preserves the plist', async () => {
    const s = spec(home);
    fs.writeFileSync(path.join(agentsDir, s.label + '.plist'), '<plist/>');
    const plistPath = path.join(agentsDir, `${s.label}.plist`);
    runner.calls.length = 0;
    runner.exitAfterBootout = false;
    runner.printResponse = 'pid = 4321\n';
    runner.printExitCode = 0;
    mgr = new LaunchdServiceManager({ runner, agentsDir, uid: 501, sleep: async () => {} });

    await expect(mgr.uninstall(s.label)).rejects.toThrow(/timed out.*launchd.*exit/i);

    expect(runner.calls.filter((call) => call[0] === 'print').length).toBeGreaterThan(1);
    expect(fs.existsSync(plistPath)).toBe(true);
  });
});
