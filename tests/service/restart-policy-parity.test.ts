import { describe, expect, test } from 'bun:test';
import { renderLaunchdPlist } from '../../packages/myco/src/service/launchd-plist';
import { renderSystemdUnit } from '../../packages/myco/src/service/systemd-unit';
import { renderWindowsServiceScript } from '../../packages/myco/src/service/windows-task';
import type { ServiceSpec } from '../../packages/myco/src/service/types';

/**
 * Cross-renderer parity: every supervised platform must restart ONLY on an
 * unsuccessful exit, never on a clean exit(0). A deliberate step-aside (a
 * sibling daemon already holds the lock) exits 0; if any renderer respawns that,
 * the launchd job hot-loops (the production incident this guards against).
 *
 * This lives in one place so the three renderers can't silently drift apart
 * again — launchd was the lone outlier (bare KeepAlive=<true/>) while systemd
 * and Windows already restarted on failure only.
 */
function specWith(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    label: 'co.goondocks.myco',
    variant: 'prod',
    executable: '/Users/test/.local/bin/myco',
    args: ['daemon'],
    workingDir: '/Users/test/.myco',
    env: { MYCO_HOME: '/Users/test/.myco' },
    stdoutPath: '/Users/test/.myco/service/logs/daemon.out.log',
    stderrPath: '/Users/test/.myco/service/logs/daemon.err.log',
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
    ...overrides,
  };
}

describe('restart-policy parity (restart-on-failure only)', () => {
  test('launchd: KeepAlive is SuccessfulExit=false, not a bare <true/>', () => {
    const plist = renderLaunchdPlist(specWith());
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    // The bare form respawns even a clean exit(0) — the loop trigger.
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  test('systemd: Restart=on-failure, never always', () => {
    const unit = renderSystemdUnit(specWith());
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
  });

  test('windows: stops on clean exit(0), restarts on a non-zero code', () => {
    const script = renderWindowsServiceScript(specWith());
    expect(script).toContain('if ($exitCode -eq 0) { exit 0 }');
    expect(script).toContain('if ($restarts -ge 10) { exit $exitCode }');
    expect(script).toContain('while ($true)');
    expect(script).toContain('catch {');
    expect(script).toContain('[Console]::Error.WriteLine($_.Exception.ToString())');
    expect(script).toContain('$exitCode = 1');
  });

  test('none supervise when keepAlive=false', () => {
    const off = { keepAlive: false } as const;
    expect(renderLaunchdPlist(specWith(off))).not.toContain('<key>KeepAlive</key>');
    expect(renderSystemdUnit(specWith(off))).toContain('Restart=no');
    expect(renderWindowsServiceScript(specWith(off))).not.toContain('while ($true)');
  });
});
