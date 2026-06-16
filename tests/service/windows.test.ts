import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WindowsTaskServiceManager, type SchtasksRunner } from '../../packages/myco/src/service/windows';
import { renderWindowsServiceScript } from '../../packages/myco/src/service/windows-task';
import type { ServiceSpec } from '../../packages/myco/src/service/types';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSpec(over: Partial<ServiceSpec> = {}): ServiceSpec {
  const home = tmp('myco-winsvc-');
  return {
    label: 'co.goondocks.myco-dev',
    variant: 'dev',
    executable: 'C:\\Users\\t\\myco-dev\\packages\\myco-windows-x64\\bin\\myco.exe',
    args: ['daemon'],
    workingDir: home,
    env: { MYCO_HOME: home, MYCO_SERVICE_VARIANT: 'dev', PATH: '/usr/local/bin:/usr/bin:/bin' },
    stdoutPath: path.join(home, 'logs', 'daemon.out.log'),
    stderrPath: path.join(home, 'logs', 'daemon.err.log'),
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
    ...over,
  };
}

/** Stub schtasks: records argv, fakes /query existence + /v status. */
class StubRunner implements SchtasksRunner {
  calls: string[][] = [];
  taskExists = false;
  taskStatus = 'Ready';
  lastResult = '0';
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    this.calls.push(args);
    if (args[0] === '/query') {
      if (!this.taskExists) return { stdout: 'ERROR: cannot find', exitCode: 1 };
      if (args.includes('/v')) {
        return { stdout: `TaskName: ${args[2]}\r\nStatus: ${this.taskStatus}\r\nLast Result: ${this.lastResult}\r\n`, exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    }
    if (args[0] === '/create') this.taskExists = true;
    if (args[0] === '/delete') this.taskExists = false;
    return { stdout: '', exitCode: 0 };
  }
}

describe('renderWindowsServiceScript', () => {
  test('bakes env (minus POSIX PATH), cd, exec + log redirect; CRLF', () => {
    const spec = makeSpec();
    const out = renderWindowsServiceScript(spec);
    expect(out.startsWith('@echo off')).toBe(true);
    expect(out).toContain(`set "MYCO_HOME=${spec.env.MYCO_HOME}"`);
    expect(out).toContain('set "MYCO_SERVICE_VARIANT=dev"');
    expect(out).not.toContain('set "PATH='); // POSIX PATH is meaningless on Windows — inherit the user's
    expect(out).toContain(`cd /d "${spec.workingDir}"`);
    expect(out).toContain(`"${spec.executable}" daemon >> "${spec.stdoutPath}" 2>> "${spec.stderrPath}"`);
    expect(out.includes('\r\n')).toBe(true);
  });

  test('keepAlive renders a crash-restart supervision loop (launchd KeepAlive equivalent)', () => {
    const out = renderWindowsServiceScript(makeSpec({ keepAlive: true }));
    expect(out).toContain(':myco_run');
    expect(out).toContain('if %errorlevel% equ 0 goto myco_done'); // clean exit stops
    expect(out).toContain('goto myco_run');                        // crash retries
    expect(out).toContain('if %MYCO_RESTARTS% geq 10 goto myco_done'); // bounded — no hot loop
    expect(out).toMatch(/ping -n \d+ 127\.0\.0\.1 > nul/);         // backoff sleep
  });

  test('non-keepAlive runs the daemon once, no supervision loop', () => {
    const out = renderWindowsServiceScript(makeSpec({ keepAlive: false }));
    expect(out).not.toContain(':myco_run');
    expect(out).toContain('daemon >>');
  });
});

describe('WindowsTaskServiceManager', () => {
  test('supported + platformName', () => {
    const mgr = new WindowsTaskServiceManager({ runner: new StubRunner(), scriptDir: tmp('myco-wt-') });
    expect(mgr.supported).toBe(true);
    expect(mgr.platformName).toContain('Task Scheduler');
  });

  test('install writes launcher .cmd + creates an onlogon task; idempotent on re-run', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const spec = makeSpec();

    const r1 = await mgr.install(spec);
    expect(r1.changed).toBe(true);
    expect(r1.supervisorReloaded).toBe(true);
    expect(fs.existsSync(path.join(scriptDir, `${spec.label}.cmd`))).toBe(true);

    const create = runner.calls.find((c) => c[0] === '/create');
    expect(create).toBeDefined();
    expect(create).toEqual(expect.arrayContaining(['/tn', spec.label, '/sc', 'onlogon', '/rl', 'limited', '/f']));

    // Unchanged spec + existing task -> no rewrite.
    const r2 = await mgr.install(spec);
    expect(r2.changed).toBe(false);
  });

  test('quotes the /tr action so a spaced script dir does not split at logon (P2)', async () => {
    // A default service dir under a spaced user profile
    // (`C:\Users\First Last\.myco\service\…cmd`) must not split the schtasks
    // action at the space — Task Scheduler re-parses the stored action string.
    const scriptDir = path.join(tmp('myco-wt-'), 'First Last');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const spec = makeSpec();

    await mgr.install(spec);
    const scriptPath = path.join(scriptDir, `${spec.label}.cmd`);
    expect(scriptPath).toContain(' '); // sanity: the path really has a space
    const create = runner.calls.find((c) => c[0] === '/create')!;
    const trValue = create[create.indexOf('/tr') + 1];
    expect(trValue).toBe(`"${scriptPath}"`);
  });

  test('isInstalled reflects schtasks /query exit code', async () => {
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    expect(await mgr.isInstalled('co.goondocks.myco')).toBe(false);
    runner.taskExists = true;
    expect(await mgr.isInstalled('co.goondocks.myco')).toBe(true);
  });

  test('status parses Running + Last Result', async () => {
    const runner = new StubRunner();
    runner.taskExists = true; runner.taskStatus = 'Running'; runner.lastResult = '0';
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    const st = await mgr.status('co.goondocks.myco-dev');
    expect(st.installed).toBe(true);
    expect(st.running).toBe(true);
    expect(st.lastExitCode).toBe(0);
  });

  test('status maps the SCHED_S_TASK_RUNNING sentinel (0x41301) to null, not a fake exit code', async () => {
    const runner = new StubRunner();
    runner.taskExists = true; runner.taskStatus = 'Running'; runner.lastResult = '267009';
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    const st = await mgr.status('co.goondocks.myco-dev');
    expect(st.running).toBe(true);
    expect(st.lastExitCode).toBeNull();
  });

  test('status returns not-installed when /query fails', async () => {
    const runner = new StubRunner(); // taskExists=false
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    const st = await mgr.status('co.goondocks.myco');
    expect(st.installed).toBe(false);
    expect(st.running).toBe(false);
  });

  test('restartShellCommand is a literal schtasks /run', () => {
    const mgr = new WindowsTaskServiceManager({ runner: new StubRunner(), scriptDir: tmp('myco-wt-') });
    expect(mgr.restartShellCommand('co.goondocks.myco')).toBe('schtasks /run /tn "co.goondocks.myco"');
  });

  test('uninstall ends + deletes the task and removes the launcher', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const spec = makeSpec();
    await mgr.install(spec);
    await mgr.uninstall(spec.label);
    expect(runner.calls.some((c) => c[0] === '/end')).toBe(true);
    expect(runner.calls.some((c) => c[0] === '/delete')).toBe(true);
    expect(fs.existsSync(path.join(scriptDir, `${spec.label}.cmd`))).toBe(false);
  });
});

describe('getServiceManager(win32)', () => {
  test('returns a supported Windows manager', async () => {
    const { getServiceManager } = await import('../../packages/myco/src/service/manager');
    const mgr = getServiceManager({ platform: 'win32' });
    expect(mgr.supported).toBe(true);
    expect(mgr.platformName).toContain('Task Scheduler');
  });
});
