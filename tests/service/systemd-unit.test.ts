import { describe, expect, test } from 'bun:test';
import { renderSystemdUnit } from '../../packages/myco/src/service/systemd-unit';
import type { ServiceSpec } from '../../packages/myco/src/service/types';

const baseSpec: ServiceSpec = {
  label: 'co.goondocks.myco',
  variant: 'prod',
  executable: '/home/test/.local/share/myco/bin/myco',
  args: ['daemon'],
  workingDir: '/home/test/.myco',
  env: { MYCO_HOME: '/home/test/.myco', PATH: '/usr/local/bin:/usr/bin:/bin' },
  stdoutPath: '/home/test/.myco/service/logs/daemon.out.log',
  stderrPath: '/home/test/.myco/service/logs/daemon.err.log',
  runAtLoad: true,
  keepAlive: true,
  throttleSeconds: 10,
};

describe('renderSystemdUnit', () => {
  test('includes [Unit], [Service], [Install] sections', () => {
    const unit = renderSystemdUnit(baseSpec);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
  });

  test('ExecStart quotes executable + args correctly', () => {
    const unit = renderSystemdUnit(baseSpec);
    // systemd splits ExecStart on whitespace, so every token is double-quoted
    // (a spaced install path would otherwise be torn into separate words).
    expect(unit).toContain('ExecStart="/home/test/.local/share/myco/bin/myco" "daemon"');
  });

  test('emits Environment= lines for every env var', () => {
    const unit = renderSystemdUnit(baseSpec);
    expect(unit).toContain('Environment="MYCO_HOME=/home/test/.myco"');
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
  });

  test('StandardOutput/StandardError append to log files', () => {
    const unit = renderSystemdUnit(baseSpec);
    expect(unit).toContain('StandardOutput=append:/home/test/.myco/service/logs/daemon.out.log');
    expect(unit).toContain('StandardError=append:/home/test/.myco/service/logs/daemon.err.log');
  });

  test('Restart=on-failure when keepAlive=true', () => {
    const unit = renderSystemdUnit(baseSpec);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=10');
  });

  test('Restart=no when keepAlive=false', () => {
    const unit = renderSystemdUnit({ ...baseSpec, keepAlive: false });
    expect(unit).toContain('Restart=no');
  });

  test('WantedBy=default.target when runAtLoad=true', () => {
    const unit = renderSystemdUnit(baseSpec);
    expect(unit).toContain('WantedBy=default.target');
  });

  test('raises LimitNOFILE past the systemd-default of 1024', () => {
    // Most systemd distros default user-service `LimitNOFILE` to 1024.
    // The daemon's HTTP server + SQLite handles + log streams blow past
    // that under load. The unit file must override it.
    const unit = renderSystemdUnit(baseSpec);
    const match = unit.match(/^LimitNOFILE=(\d+)/m);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(10_000);
  });
});
