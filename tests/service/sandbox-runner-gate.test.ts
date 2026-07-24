/**
 * Regression: a sandboxed install must NEVER shell out to `launchctl` /
 * `systemctl`. Earlier this produced persistent `co.goondocks.myco-dev.sandbox-<sha8>`
 * launchd registrations that survived test temp-dir cleanup and forced
 * launchd to respawn the daemon forever — six zombie daemons per test run
 * required a manual `launchctl bootout` to reap.
 *
 * The structural fix lives inside the real runners: when
 * `MYCO_LAUNCH_AGENTS_DIR` is set the install is by definition isolated
 * from the user's real session, so the runner short-circuits with a
 * sandbox-marker stdout instead of spawning. Tests that need to observe
 * the supervisor argv inject a stub `LaunchctlRunner`/`SystemctlRunner`
 * via `*ManagerOptions.runner`, so this gate does not affect them.
 *
 * The test asserts the no-op behavior directly against the exported real
 * runners; if a future refactor reverts the gate, the spawn call would
 * leak again and these assertions catch it without needing to inspect
 * launchctl's actual state.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { RealLaunchctlRunner } from '../../packages/myco/src/service/launchd';
import { RealSystemctlRunner } from '../../packages/myco/src/service/systemd';
import { RealSchtasksRunner } from '../../packages/myco/src/service/windows';
import { SERVICE_UNIT_DIR_ENV } from '../../packages/myco/src/service/paths';

const originalEnv = process.env[SERVICE_UNIT_DIR_ENV];

beforeEach(() => { process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-agents-dir'; });
afterEach(() => {
  if (originalEnv === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
  else process.env[SERVICE_UNIT_DIR_ENV] = originalEnv;
});

describe('Real runners refuse to shell out when sandbox env var is set', () => {
  test('RealLaunchctlRunner skips `launchctl bootstrap` and returns a sandbox marker', async () => {
    const runner = new RealLaunchctlRunner();
    const result = await runner.run(['bootstrap', 'gui/501', '/tmp/x.plist']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\[sandbox\] skipped launchctl bootstrap /);
  });

  test('RealLaunchctlRunner skips `launchctl bootout` too', async () => {
    const runner = new RealLaunchctlRunner();
    const result = await runner.run(['bootout', 'gui/501/co.goondocks.myco.sandbox-deadbeef']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\[sandbox\] skipped launchctl bootout /);
  });

  test('RealSystemctlRunner skips `systemctl daemon-reload` in sandbox mode', async () => {
    const runner = new RealSystemctlRunner();
    const result = await runner.run(['--user', 'daemon-reload']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\[sandbox\] skipped systemctl /);
  });

  test('sandbox supervisor reads report the intentionally unregistered service as absent', async () => {
    const launchd = await new RealLaunchctlRunner().run(['print', 'gui/501/co.goondocks.myco']);
    const systemd = await new RealSystemctlRunner().run(['--user', 'show', 'co.goondocks.myco.service']);
    const windows = await new RealSchtasksRunner().run(['/query', '/tn', 'co.goondocks.myco']);
    const windowsState = await new RealSchtasksRunner().queryState('co.goondocks.myco');

    expect(launchd.exitCode).not.toBe(0);
    expect(systemd.exitCode).not.toBe(0);
    expect(windows.exitCode).not.toBe(0);
    expect(windowsState).toBe('absent');
  });

  test('RealSchtasksRunner distinguishes a successful empty enumeration from provider failure', async () => {
    class TestRunner extends RealSchtasksRunner {
      command: string | undefined;
      constructor(private readonly result: { stdout: string; exitCode: number }) { super(); }
      protected override async runPowerShell(args: string[]): Promise<{ stdout: string; exitCode: number }> {
        this.command = args.at(-1);
        return this.result;
      }
    }
    delete process.env[SERVICE_UNIT_DIR_ENV];
    try {
      const emptyRunner = new TestRunner({ stdout: '-1\r\n', exitCode: 0 });
      await expect(emptyRunner.queryState('co.goondocks.myco'))
        .resolves.toBe('absent');
      expect(emptyRunner.command).toContain("}\nelseif");
      expect(emptyRunner.command).not.toContain('}; elseif');
      await expect(new TestRunner({ stdout: 'CIM provider unavailable', exitCode: 1 }).queryState('co.goondocks.myco'))
        .rejects.toThrow(/Get-ScheduledTask.*failed.*exit 1/i);
    } finally {
      process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-agents-dir';
    }
  });
});

describe('Real runners DO shell out when not in sandbox mode', () => {
  beforeEach(() => { delete process.env[SERVICE_UNIT_DIR_ENV]; });

  test('RealLaunchctlRunner with no sandbox env spawns launchctl (returns whatever launchctl says)', async () => {
    // We can't predict the exit code on every CI host, so just assert
    // we did NOT take the sandbox-skip path. The marker is the contract.
    if (process.platform !== 'darwin') return;
    const runner = new RealLaunchctlRunner();
    const result = await runner.run(['version']);
    expect(result.stdout).not.toMatch(/^\[sandbox\] skipped /);
  });
});
