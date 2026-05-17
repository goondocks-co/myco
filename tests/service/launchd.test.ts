import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LaunchdServiceManager, type LaunchctlRunner } from '../../packages/myco/src/service/launchd';
import type { ServiceSpec } from '../../packages/myco/src/service/types';

class FakeRunner implements LaunchctlRunner {
  calls: string[][] = [];
  printResponse = '';
  printExitCode = 0;
  /** Map from first arg ("kickstart", "kill", ...) to forced exit code+stdout. */
  exitOverrides: Map<string, { stdout: string; exitCode: number }> = new Map();
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    this.calls.push(args);
    if (args[0] === 'print') return { stdout: this.printResponse, exitCode: this.printExitCode };
    const override = this.exitOverrides.get(args[0]);
    if (override) return override;
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

  test('install writes plist, creates log dir, runs bootstrap+enable', async () => {
    const s = spec(home);
    await mgr.install(s);
    const plistPath = path.join(agentsDir, `${s.label}.plist`);
    expect(fs.existsSync(plistPath)).toBe(true);
    expect(fs.existsSync(path.dirname(s.stdoutPath))).toBe(true);
    expect(runner.calls[0]).toEqual(['bootstrap', 'gui/501', plistPath]);
    expect(runner.calls[1]).toEqual(['enable', `gui/501/${s.label}`]);
  });

  test('install is idempotent: re-running with identical spec is a no-op after first call', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.calls.length = 0;
    await mgr.install(s);
    expect(runner.calls).toEqual([]);
  });

  test('install detects changed spec and replaces the plist', async () => {
    const s1 = spec(home);
    await mgr.install(s1);
    runner.calls.length = 0;
    const s2 = { ...s1, args: ['daemon', '--verbose'] };
    await mgr.install(s2);
    expect(runner.calls[0]).toEqual(['bootout', `gui/501/${s1.label}`]);
    expect(runner.calls[1][0]).toBe('bootstrap');
    expect(runner.calls[2]).toEqual(['enable', `gui/501/${s1.label}`]);
  });

  test('uninstall runs bootout and removes the plist', async () => {
    const s = spec(home);
    await mgr.install(s);
    const plistPath = path.join(agentsDir, `${s.label}.plist`);
    runner.calls.length = 0;
    await mgr.uninstall(s.label);
    expect(runner.calls[0]).toEqual(['bootout', `gui/501/${s.label}`]);
    expect(fs.existsSync(plistPath)).toBe(false);
  });

  test('status reports installed=false when plist absent', async () => {
    const st = await mgr.status('co.goondocks.nonexistent');
    expect(st.installed).toBe(false);
    expect(st.running).toBe(false);
    expect(st.pid).toBe(null);
  });

  test('status parses pid and lastExitCode from launchctl print', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.printResponse = 'pid = 12345\n\tlast exit code = 0\n';
    runner.printExitCode = 0;
    const st = await mgr.status(s.label);
    expect(st.installed).toBe(true);
    expect(st.running).toBe(true);
    expect(st.pid).toBe(12345);
    expect(st.lastExitCode).toBe(0);
  });

  test('status parses EX_CONFIG (78) — the exact failure mode that broke chris machine', async () => {
    const s = spec(home);
    await mgr.install(s);
    runner.printResponse = 'state = not running\n\tlast exit code = 78\n';
    const st = await mgr.status(s.label);
    expect(st.lastExitCode).toBe(78);
    expect(st.running).toBe(false);
  });

  test('platformName is "launchd"', () => {
    expect(mgr.platformName).toBe('launchd');
    expect(mgr.supported).toBe(true);
  });

  test('restart issues `kickstart -k gui/<uid>/<label>` and succeeds on exit 0', async () => {
    await mgr.restart('co.goondocks.myco');
    expect(runner.calls).toEqual([['kickstart', '-k', 'gui/501/co.goondocks.myco']]);
  });

  test('restart throws when launchctl exits non-zero', async () => {
    runner.exitOverrides.set('kickstart', { stdout: 'Could not find specified service', exitCode: 3 });
    await expect(mgr.restart('co.goondocks.missing')).rejects.toThrow(/kickstart failed.*exit 3/i);
  });

  test('restartShellCommand returns the literal `launchctl kickstart -k gui/<uid>/<label>`', () => {
    // Baked into the detached update / restart script after the daemon exits.
    // Must include the resolved uid so the script can run without env-var
    // dependencies.
    expect(mgr.restartShellCommand('co.goondocks.myco')).toBe(
      'launchctl kickstart -k gui/501/co.goondocks.myco',
    );
    expect(mgr.restartShellCommand('co.goondocks.myco-dev')).toBe(
      'launchctl kickstart -k gui/501/co.goondocks.myco-dev',
    );
  });

  test('install writes plist atomically via tempfile + rename', async () => {
    // Regression guard: a torn write of the plist would let `launchctl
    // bootstrap` register a structurally broken service. The write path
    // must go through atomicWriteFileSync (tempfile + rename), not a
    // direct writeFileSync to the final path.
    const s = spec(home);
    const plistPath = path.join(agentsDir, `${s.label}.plist`);
    const writeSpy = spyOn(fs, 'writeFileSync');
    const renameSpy = spyOn(fs, 'renameSync');
    try {
      await mgr.install(s);
      const renamedToPlist = renameSpy.mock.calls.find(
        (call) => call[1] === plistPath,
      );
      expect(renamedToPlist).toBeDefined();
      const tmpSrc = renamedToPlist![0] as string;
      expect(tmpSrc.startsWith(`${plistPath}.tmp-`)).toBe(true);
      // The plist write itself targets the tempfile, never the final path.
      const directPlistWrite = writeSpy.mock.calls.find(
        (call) => call[0] === plistPath,
      );
      expect(directPlistWrite).toBeUndefined();
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
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
