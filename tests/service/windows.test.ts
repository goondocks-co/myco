import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WindowsTaskServiceManager,
  type SchtasksRunner,
  type TaskSchedulerState,
  type WindowsManagerOptions,
} from '../../packages/myco/src/service/windows';
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
  taskState: TaskSchedulerState = 'ready';
  taskStates: TaskSchedulerState[] = [];
  lastResult = '0';
  runExitCode = 0;
  xmlQueryExitCode = 0;
  deleteLeavesTask = false;
  taskCommand: string | null = null;
  taskArguments: string | null = null;
  exitOverrides: Map<string, { stdout: string; exitCode: number }> = new Map();
  async queryState(label: string): Promise<TaskSchedulerState> {
    this.calls.push(['/state', label]);
    if (!this.taskExists) return 'absent';
    return this.taskStates.shift() ?? this.taskState;
  }
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    this.calls.push(args);
    if (args[0] === '/query') {
      if (!this.taskExists) return { stdout: 'ERROR: cannot find', exitCode: 1 };
      if (args.includes('/xml')) {
        if (this.xmlQueryExitCode !== 0) {
          return { stdout: 'Task Scheduler provider unavailable', exitCode: this.xmlQueryExitCode };
        }
        const command = this.taskCommand ?? '';
        const argumentsXml = this.taskArguments === null
          ? ''
          : `<Arguments>${this.taskArguments}</Arguments>`;
        return {
          stdout: `<Task><Actions><Exec><Command>${command}</Command>${argumentsXml}</Exec></Actions></Task>`,
          exitCode: 0,
        };
      }
      if (args.includes('/v')) {
        return { stdout: `TaskName: ${args[2]}\r\nLast Result: ${this.lastResult}\r\n`, exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    }
    const override = this.exitOverrides.get(args[0]);
    if (override) return override;
    if (args[0] === '/create') {
      this.taskExists = true;
      const taskRun = args[args.indexOf('/tr') + 1] ?? '';
      const separator = taskRun.indexOf(' ');
      this.taskCommand = separator === -1 ? taskRun : taskRun.slice(0, separator);
      this.taskArguments = separator === -1 ? null : taskRun.slice(separator + 1);
    }
    if (args[0] === '/delete' && !this.deleteLeavesTask) this.taskExists = false;
    if (args[0] === '/run' && this.runExitCode !== 0) {
      return { stdout: 'ERROR: The system cannot find the path specified.', exitCode: this.runExitCode };
    }
    return { stdout: '', exitCode: 0 };
  }
}

function makeUnitManager(opts: WindowsManagerOptions): WindowsTaskServiceManager {
  return new WindowsTaskServiceManager({
    withExternalMcpContainment: async (continuation) => await continuation(),
    ...opts,
  });
}

describe('renderWindowsServiceScript', () => {
  test('bakes env (minus POSIX PATH), cwd, exec + log redirect; CRLF', () => {
    const spec = makeSpec();
    const out = renderWindowsServiceScript(spec);
    expect(out.startsWith("$ErrorActionPreference = 'Stop'")).toBe(true);
    expect(out).toContain(
      `$startInfo.EnvironmentVariables['MYCO_HOME'] = '${spec.env.MYCO_HOME}'`,
    );
    expect(out).toContain(
      "$startInfo.EnvironmentVariables['MYCO_SERVICE_VARIANT'] = 'dev'",
    );
    // Restart routing keys on the installed task (resolveRestartServiceLabel),
    // so the launcher no longer needs to export a pid-substitute marker.
    expect(out).not.toContain('MYCO_SERVICE_MANAGED');
    expect(out).not.toContain("'PATH'"); // POSIX PATH is meaningless on Windows — inherit the user's
    expect(out).toContain(`$workingDirectory = '${spec.workingDir}'`);
    expect(out).toContain(`$executable = '${spec.executable}'`);
    expect(out).toContain("$arguments = @('daemon')");
    expect(out).toContain('$process.StandardOutput.BaseStream.CopyToAsync($stdout)');
    expect(out).toContain('$process.StandardError.BaseStream.CopyToAsync($stderr)');
    expect(out).not.toContain('1>>');
    expect(out).not.toContain('2>>');
    expect(out.includes('\r\n')).toBe(true);
  });

  test('keepAlive renders a crash-restart supervision loop (launchd KeepAlive equivalent)', () => {
    const out = renderWindowsServiceScript(makeSpec({ keepAlive: true }));
    expect(out).toContain('while ($true)');
    expect(out).toContain('if ($exitCode -eq 0) { exit 0 }');
    expect(out).toContain('$restarts += 1');
    expect(out).toContain('if ($restarts -ge 10) { exit $exitCode }');
    expect(out).toContain('Start-Sleep -Seconds 10');
  });

  test('non-keepAlive runs the daemon once, no supervision loop', () => {
    const out = renderWindowsServiceScript(makeSpec({ keepAlive: false }));
    expect(out).not.toContain('while ($true)');
    expect(out).toContain('$exitCode = Invoke-MycoProcess');
  });

  test('rejects arguments that cannot be passed without command-line quoting', () => {
    expect(() => renderWindowsServiceScript(makeSpec({ args: ['daemon', 'spaced value'] })))
      .toThrow(/unsupported command-line quoting/i);
  });
});

describe('WindowsTaskServiceManager', () => {
  test('supported + platformName', () => {
    const mgr = new WindowsTaskServiceManager({ runner: new StubRunner(), scriptDir: tmp('myco-wt-') });
    expect(mgr.supported).toBe(true);
    expect(mgr.platformName).toContain('Task Scheduler');
  });

  test('install writes launcher .ps1 + creates an onlogon task; idempotent on re-run', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const spec = makeSpec();

    const r1 = await mgr.install(spec);
    expect(r1.changed).toBe(true);
    expect(r1.supervisorReloaded).toBe(true);
    expect(fs.existsSync(path.join(scriptDir, `${spec.label}.ps1`))).toBe(true);

    const create = runner.calls.find((c) => c[0] === '/create');
    expect(create).toBeDefined();
    expect(create).toEqual(expect.arrayContaining(['/tn', spec.label, '/sc', 'onlogon', '/rl', 'limited', '/f']));

    // Unchanged spec + existing task -> no rewrite.
    const r2 = await mgr.install(spec);
    expect(r2.changed).toBe(false);
  });

  test('start throws when schtasks /run exits non-zero (no silent success)', async () => {
    const runner = new StubRunner();
    runner.runExitCode = 1;
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    await expect(mgr.start('co.goondocks.myco')).rejects.toThrow(/schtasks \/run.*failed.*exit 1/i);
  });

  test('passes a spaced /tr action to non-interactive PowerShell', async () => {
    const scriptDir = path.join(tmp('myco-wt-'), 'First Last');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const spec = makeSpec();

    await mgr.install(spec);
    const scriptPath = path.join(scriptDir, `${spec.label}.ps1`);
    expect(scriptPath).toContain(' '); // sanity: the path really has a space
    const create = runner.calls.find((c) => c[0] === '/create')!;
    const trValue = create[create.indexOf('/tr') + 1];
    expect(trValue).toBe(
      `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
    );
  });

  test('retires the legacy batch launcher only after task recreation succeeds', async () => {
    const scriptDir = tmp('myco-wt-');
    const legacyPath = path.join(scriptDir, 'co.goondocks.myco-dev.cmd');
    fs.writeFileSync(legacyPath, '@echo off\r\n');
    const spec = makeSpec();

    const failingRunner = new StubRunner();
    failingRunner.exitOverrides.set('/create', { stdout: 'provider failure', exitCode: 1 });
    const failingManager = new WindowsTaskServiceManager({
      runner: failingRunner,
      scriptDir,
    });
    await expect(failingManager.install(spec)).rejects.toThrow(/schtasks.*create/i);
    expect(fs.existsSync(legacyPath)).toBe(true);

    const runner = new StubRunner();
    const manager = new WindowsTaskServiceManager({ runner, scriptDir });
    await expect(manager.install(spec)).resolves.toMatchObject({ changed: true });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(path.join(scriptDir, `${spec.label}.ps1`))).toBe(true);
  });

  test('recreates a quoted task action instead of accepting a non-runnable install', async () => {
    const scriptDir = path.join(tmp('myco-wt-'), 'First Last');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const spec = makeSpec();

    await mgr.install(spec);
    const scriptPath = path.join(scriptDir, `${spec.label}.ps1`);
    runner.taskCommand = `"${scriptPath}"`;
    runner.taskArguments = null;
    runner.calls.length = 0;

    const result = await mgr.install(spec);

    expect(result.changed).toBe(true);
    const create = runner.calls.find((call) => call[0] === '/create');
    expect(create?.[create.indexOf('/tr') + 1])
      .toBe(
        `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
      );
  });

  test('does not overwrite an existing task when XML inspection fails', async () => {
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    const spec = makeSpec();

    await mgr.install(spec);
    runner.xmlQueryExitCode = 1;
    runner.calls.length = 0;

    await expect(mgr.install(spec)).rejects.toThrow(/Task Scheduler.*inspection failed/i);
    expect(runner.calls.some((call) => call[0] === '/create')).toBe(false);
  });

  test('keeps shell metacharacters literal in the PowerShell launcher path', async () => {
    const scriptDir = path.join(tmp('myco-wt-'), '%PATH% & !');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const spec = makeSpec();

    await expect(mgr.install(spec)).resolves.toMatchObject({ changed: true });
    expect(fs.existsSync(path.join(scriptDir, `${spec.label}.ps1`))).toBe(true);
    const create = runner.calls.find((call) => call[0] === '/create');
    expect(create?.[create.indexOf('/tr') + 1]).toContain(`-File "${scriptDir}`);
  });

  test('isInstalled reflects the locale-independent task state', async () => {
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    expect(await mgr.isInstalled('co.goondocks.myco')).toBe(false);
    runner.taskExists = true;
    expect(await mgr.isInstalled('co.goondocks.myco')).toBe(true);
  });

  test('status parses Running + Last Result', async () => {
    const runner = new StubRunner();
    runner.taskExists = true; runner.taskState = 'running'; runner.lastResult = '0';
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    const st = await mgr.status('co.goondocks.myco-dev');
    expect(st.installed).toBe(true);
    expect(st.running).toBe(true);
    expect(st.lastExitCode).toBe(0);
  });

  test('status maps the SCHED_S_TASK_RUNNING sentinel (0x41301) to null, not a fake exit code', async () => {
    const runner = new StubRunner();
    runner.taskExists = true; runner.taskState = 'running'; runner.lastResult = '267009';
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

  test('inspect returns the exact executable and arguments from the installed task launcher', async () => {
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir: tmp('myco-wt-') });
    const spec = makeSpec({
      executable: "C:\\Users\\O'Brien\\myco.exe",
      args: ['daemon', '--port', '28876', "owner's"],
    });
    await mgr.install(spec);

    await expect(mgr.inspect(spec.label)).resolves.toEqual({
      executable: spec.executable,
      args: spec.args,
    });
  });

  test('inspect fails closed for a malformed installed task launcher', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const label = 'co.goondocks.myco.malformed';
    const scriptPath = path.join(scriptDir, `${label}.ps1`);
    fs.writeFileSync(scriptPath, '@echo off\r\nthis is not a service command\r\n');
    runner.taskExists = true;
    runner.taskCommand = scriptPath;

    await expect(mgr.inspect(label)).resolves.toBeNull();
  });

  test('inspect returns null when a live task has no installed launcher', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const label = 'co.goondocks.myco.orphaned';
    runner.taskExists = true;
    runner.taskState = 'running';
    runner.taskCommand = path.join(scriptDir, `${label}.ps1`);

    const status = await mgr.status(label);
    expect(status).toMatchObject({ installed: true, running: true, unitPath: null });
    await expect(mgr.inspect(label)).resolves.toBeNull();
  });

  test('inspect returns null when the task action does not match the launcher path', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({ runner, scriptDir });
    const spec = makeSpec();
    await mgr.install(spec);
    runner.taskCommand = path.join(scriptDir, 'different.ps1');

    await expect(mgr.inspect(spec.label)).resolves.toBeNull();
  });

  test('restartShellCommand is a literal schtasks /run', () => {
    const mgr = new WindowsTaskServiceManager({ runner: new StubRunner(), scriptDir: tmp('myco-wt-') });
    expect(mgr.restartShellCommand('co.goondocks.myco')).toBe('schtasks /run /tn "co.goondocks.myco"');
  });

  test('uninstall ends + deletes the task and removes the launcher', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = makeUnitManager({ runner, scriptDir });
    const spec = makeSpec();
    await mgr.install(spec);
    await mgr.uninstall(spec.label);
    expect(runner.calls.some((c) => c[0] === '/end')).toBe(true);
    expect(runner.calls.some((c) => c[0] === '/delete')).toBe(true);
    expect(fs.existsSync(path.join(scriptDir, `${spec.label}.ps1`))).toBe(false);
  });

  test('uninstall never hard-ends or deletes when external containment cannot be confirmed', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({
      runner,
      scriptDir,
      resolveDaemonPort: () => null,
      withExternalMcpContainment: async () => {
        throw new Error('external containment unavailable');
      },
    });
    const spec = makeSpec();
    await mgr.install(spec);
    const scriptPath = path.join(scriptDir, `${spec.label}.ps1`);

    await expect(mgr.uninstall(spec.label)).rejects.toThrow(/containment/i);

    expect(runner.calls.some((call) => call[0] === '/end')).toBe(false);
    expect(runner.calls.some((call) => call[0] === '/delete')).toBe(false);
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test('uninstall contains an orphan daemon before accepting an absent task', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const label = 'co.goondocks.myco.orphaned';
    const scriptPath = path.join(scriptDir, `${label}.ps1`);
    fs.writeFileSync(scriptPath, '@echo off\r\n');
    const events: string[] = [];
    const mgr = new WindowsTaskServiceManager({
      runner,
      scriptDir,
      resolveDaemonPort: () => 28876,
      cooperativeShutdown: async (port) => {
        events.push(`drain:${port}`);
        return { kind: 'refused', status: 409, detail: 'containment failed' };
      },
      withExternalMcpContainment: async () => {
        events.push('contain');
        throw new Error('external containment unavailable');
      },
    });

    await expect(mgr.uninstall(label)).rejects.toThrow(/containment/i);

    expect(events).toEqual(['drain:28876', 'contain']);
    expect(runner.calls).toEqual([]);
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test('uninstall rejects a failed /end and preserves the launcher', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = makeUnitManager({ runner, scriptDir });
    const spec = makeSpec();
    await mgr.install(spec);
    const scriptPath = path.join(scriptDir, `${spec.label}.ps1`);
    runner.exitOverrides.set('/end', { stdout: 'ERROR: Access is denied.', exitCode: 1 });

    await expect(mgr.uninstall(spec.label)).rejects.toThrow(/schtasks \/end.*failed.*exit 1/i);

    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(runner.calls.some((call) => call[0] === '/delete')).toBe(false);
  });

  test('uninstall polls until a delayed task exit before deleting it', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const spec = makeSpec();
    runner.taskExists = true;
    runner.taskStates = ['running', 'running', 'ready'];
    const mgr = makeUnitManager({ runner, scriptDir, sleep: async () => {} });

    await mgr.uninstall(spec.label);

    const stateCallIndexes = runner.calls
      .map((call, index) => call[0] === '/state' ? index : -1)
      .filter((index) => index >= 0);
    const deleteIndex = runner.calls.findIndex((call) => call[0] === '/delete');
    const preDeleteStateIndexes = stateCallIndexes.filter((index) => index < deleteIndex);
    const postDeleteStateIndexes = stateCallIndexes.filter((index) => index > deleteIndex);
    expect(preDeleteStateIndexes.length).toBeGreaterThanOrEqual(3);
    expect(postDeleteStateIndexes.length).toBeGreaterThanOrEqual(1);
    expect(deleteIndex).toBeGreaterThan(preDeleteStateIndexes.at(-1)!);
    expect(deleteIndex).toBeLessThan(postDeleteStateIndexes[0]!);
  });

  test('uninstall rejects a failed /delete and preserves the launcher', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = makeUnitManager({ runner, scriptDir });
    const spec = makeSpec();
    await mgr.install(spec);
    const scriptPath = path.join(scriptDir, `${spec.label}.ps1`);
    runner.exitOverrides.set('/delete', { stdout: 'ERROR: Access is denied.', exitCode: 1 });

    await expect(mgr.uninstall(spec.label)).rejects.toThrow(/schtasks \/delete.*failed.*exit 1/i);

    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test('uninstall confirms task absence after /delete before removing the launcher', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = makeUnitManager({ runner, scriptDir, sleep: async () => {} });
    const spec = makeSpec();
    await mgr.install(spec);
    const scriptPath = path.join(scriptDir, `${spec.label}.ps1`);
    runner.deleteLeavesTask = true;

    await expect(mgr.uninstall(spec.label)).rejects.toThrow(/timed out.*Task Scheduler.*deletion/i);

    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(runner.calls.filter((call) => call[0] === '/state').length).toBeGreaterThan(1);
  });

  test('uninstall is idempotent when the task and launcher are already absent', async () => {
    const runner = new StubRunner();
    const mgr = new WindowsTaskServiceManager({
      runner,
      scriptDir: tmp('myco-wt-'),
      withExternalMcpContainment: async (terminate) => await terminate(),
    });

    await mgr.uninstall('co.goondocks.myco.absent');

    expect(runner.calls).toEqual([
      ['/state', 'co.goondocks.myco.absent'],
    ]);
  });

  test('uninstall rejects an unknown Task Scheduler state', async () => {
    const runner = new StubRunner();
    runner.taskExists = true;
    runner.taskState = 'unknown';
    const mgr = makeUnitManager({ runner, scriptDir: tmp('myco-wt-') });

    await expect(mgr.uninstall('co.goondocks.myco.unknown'))
      .rejects.toThrow(/unknown Task Scheduler state/i);
  });

  test('uninstall times out while Task Scheduler still reports the task running', async () => {
    const scriptDir = tmp('myco-wt-');
    const runner = new StubRunner();
    const mgr = makeUnitManager({ runner, scriptDir, sleep: async () => {} });
    const spec = makeSpec();
    await mgr.install(spec);
    const scriptPath = path.join(scriptDir, `${spec.label}.ps1`);
    runner.taskState = 'running';

    await expect(mgr.uninstall(spec.label)).rejects.toThrow(/timed out.*Task Scheduler.*exit/i);

    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(runner.calls.some((call) => call[0] === '/delete')).toBe(false);
  });

  // Cooperative drain (#4): `schtasks /end` is an uncatchable TerminateProcess,
  // so restart/stop must drain the daemon over HTTP FIRST or every Windows
  // restart/update orphans in-flight runs + the team-sync outbox.

  /** A runner that records schtasks calls into a shared ordered event log. */
  function recordingMgr(events: string[], opts: {
    resolveDaemonPort?: (label: string) => number | null;
    cooperativeShutdown?: (port: number) => Promise<
      import('../../packages/myco/src/service/cooperative-shutdown').CooperativeShutdownResult
    >;
    withExternalMcpContainment?: <T>(
      continuation: () => Promise<T>,
    ) => Promise<T>;
  }) {
    const runner: SchtasksRunner = {
      async run(args) { events.push('schtasks:' + args.join(' ')); return { stdout: '', exitCode: 0 }; },
      async queryState() { return 'absent'; },
    };
    return new WindowsTaskServiceManager({
      runner,
      scriptDir: tmp('myco-wt-'),
      withExternalMcpContainment: async (terminate) => {
        events.push('contain');
        return await terminate();
      },
      ...opts,
    });
  }

  test('restart() drains via cooperative shutdown BEFORE schtasks /end, then /run', async () => {
    const events: string[] = [];
    const runner: SchtasksRunner = {
      async run(args) {
        events.push('schtasks:' + args.join(' '));
        return { stdout: '', exitCode: 0 };
      },
      async queryState() {
        events.push('state');
        return events.includes('schtasks:/end /tn co.goondocks.myco-dev')
          ? 'ready'
          : 'running';
      },
    };
    const mgr = new WindowsTaskServiceManager({
      runner,
      scriptDir: tmp('myco-wt-'),
      resolveDaemonPort: () => 28876,
      cooperativeShutdown: async (port) => {
        events.push('drain:' + port);
        return { kind: 'stopped' };
      },
      withExternalMcpContainment: async (terminate) => {
        events.push('contain:start');
        await terminate();
        events.push('contain:end');
      },
    });
    await mgr.restart('co.goondocks.myco-dev');
    expect(events).toEqual([
      'drain:28876',
      'contain:start',
      'schtasks:/end /tn co.goondocks.myco-dev',
      'state',
      'contain:end',
      'schtasks:/run /tn co.goondocks.myco-dev',
    ]);
  });

  test('stop() drains before schtasks /end', async () => {
    const events: string[] = [];
    const mgr = recordingMgr(events, {
      resolveDaemonPort: () => 28876,
      cooperativeShutdown: async (port) => { events.push('drain:' + port); return { kind: 'stopped' }; },
    });
    await mgr.stop('co.goondocks.myco-dev');
    expect(events).toEqual([
      'drain:28876',
      'contain',
      'schtasks:/end /tn co.goondocks.myco-dev',
    ]);
  });

  test('restart() skips the drain when the daemon port is unknown (still ends + runs)', async () => {
    const events: string[] = [];
    let drained = false;
    const mgr = recordingMgr(events, {
      resolveDaemonPort: () => null,
      cooperativeShutdown: async () => { drained = true; return { kind: 'stopped' }; },
    });
    await mgr.restart('co.goondocks.myco');
    expect(drained).toBe(false);
    expect(events).toEqual([
      'contain',
      'schtasks:/end /tn co.goondocks.myco',
      'schtasks:/run /tn co.goondocks.myco',
    ]);
  });

  test('restart() hard-ends after out-of-process containment when cooperative drain throws', async () => {
    const events: string[] = [];
    const mgr = recordingMgr(events, {
      resolveDaemonPort: () => 1,
      cooperativeShutdown: async () => { throw new Error('drain blew up'); },
    });
    await mgr.restart('co.goondocks.myco');
    expect(events).toEqual([
      'contain',
      'schtasks:/end /tn co.goondocks.myco',
      'schtasks:/run /tn co.goondocks.myco',
    ]);
  });

  test('restart() does not hard-end after the daemon explicitly refuses shutdown', async () => {
    const events: string[] = [];
    const mgr = recordingMgr(events, {
      resolveDaemonPort: () => 28876,
      cooperativeShutdown: async (port) => {
        events.push('drain:' + port);
        return { kind: 'refused', status: 409 };
      },
      withExternalMcpContainment: async () => {
        events.push('contain');
        throw new Error('external containment unavailable');
      },
    });

    await expect(mgr.restart('co.goondocks.myco')).rejects.toThrow(/containment/i);
    expect(events).toEqual(['drain:28876', 'contain']);
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
