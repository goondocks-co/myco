import { describe, it, expect } from 'bun:test';
import { generateRestartScript, generateUpdateScript } from '@myco/daemon/update-installer.js';

describe('generateRestartScript()', () => {
  const baseParams = {
    projectRoot: '/home/user/project',
    vaultDir: '/home/user/project/.myco',
    fromVersion: '0.17.0',
    toVersion: '0.17.1',
    mycoBinary: 'myco',
    daemonPort: 20915,
  };

  it('includes myco update --all-projects when runLocalUpdate is true', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: true });
    expect(script).toContain('update --all-projects');
    // Restart still cd's into projectRoot so the new daemon picks up the vault.
    expect(script).toContain('/home/user/project');
  });

  it('skips myco update when runLocalUpdate is false', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: false });
    expect(script).not.toContain('update --all-projects');
    expect(script).not.toContain('update --project');
  });

  it('starts the daemon from projectRoot so resolveVaultDir finds the vault', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: false });
    expect(script).toContain('cd "/home/user/project"');
    expect(script).toContain('"$MYCO" daemon');
    // No explicit vault flag — vaults are project-local, resolved from cwd.
    expect(script).not.toContain('--vault');
  });

  it('writes restart-reason.json before starting daemon', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: true });
    expect(script).toContain('restart-reason.json');
  });

  it('bakes the myco binary literal at script generation time (prod)', () => {
    // Regression guard: the old implementation used `${MYCO_CMD:-myco}` —
    // a runtime env-var dispatch inside the shell script that relied on
    // the child process inheriting MYCO_CMD from its parent. The new
    // implementation bakes the literal at generation time, eliminating
    // the env-var dependency entirely.
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: false });
    expect(script).not.toContain('${MYCO_CMD');
    expect(script).toContain('MYCO="myco"');
  });

  it('bakes a dev-build CLI entry path when supplied', () => {
    const script = generateRestartScript({
      ...baseParams,
      runLocalUpdate: false,
      mycoBinary: '/Users/dev/.local/bin/myco-dev',
    });
    expect(script).toContain('MYCO="/Users/dev/.local/bin/myco-dev"');
    expect(script).not.toContain('${MYCO_CMD');
  });

  it('cleans up the script file', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: false });
    expect(script).toContain('rm -f "$0"');
  });

  it('bakes version strings into reason JSON from Node', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: true });
    expect(script).toContain('0.17.0');
    expect(script).toContain('0.17.1');
    expect(script).toContain('version_sync');
  });

  it('handles paths with spaces via JSON quoting', () => {
    const script = generateRestartScript({
      ...baseParams,
      projectRoot: '/home/user/my project',
      vaultDir: '/home/user/my project/.myco',
      runLocalUpdate: true,
    });
    expect(script).toContain('my project');
  });

  // Service-managed restart tail — same root cause as the /restart bug fixed
  // in commit 78a2c421. When launchd's KeepAlive (or systemd's
  // Restart=always) is going to respawn the daemon, the script must NOT
  // also spawn `myco daemon` — they'd fight for the canonical port.
  it('uses the service-restart command instead of spawning a daemon when service-managed', () => {
    const script = generateRestartScript({
      ...baseParams,
      runLocalUpdate: false,
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
    });
    expect(script).toContain('launchctl kickstart -k gui/501/co.goondocks.myco');
    expect(script).not.toContain('"$MYCO" daemon');
  });

  it('uses the systemd restart command on Linux', () => {
    const script = generateRestartScript({
      ...baseParams,
      runLocalUpdate: false,
      serviceRestartCommand: 'systemctl --user restart myco.service',
    });
    expect(script).toContain('systemctl --user restart myco.service');
    expect(script).not.toContain('"$MYCO" daemon');
  });

  it('falls back to spawning `myco daemon` when no service-restart command is supplied', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: false });
    expect(script).toContain('"$MYCO" daemon');
    expect(script).not.toContain('launchctl');
    expect(script).not.toContain('systemctl');
  });
});

describe('generateUpdateScript()', () => {
  const baseParams = {
    packageSpecs: ['@goondocks/myco@1.0.0'],
    projectRoot: '/project',
    vaultDir: '/project/.myco',
    mycoBinary: 'myco',
    daemonPort: 20915,
    targetVersion: '1.0.0',
  };

  it('generates a valid update script (existing behavior sanity check)', () => {
    const script = generateUpdateScript(baseParams);
    expect(script).toContain('npm install -g "@goondocks/myco@1.0.0"');
    expect(script).toContain('update --all-projects');
  });

  it('bakes the myco binary literal (no MYCO_CMD env-var dispatch)', () => {
    const script = generateUpdateScript(baseParams);
    expect(script).not.toContain('${MYCO_CMD');
    expect(script).toContain('MYCO="myco"');
  });

  it('bakes a dev-build CLI entry path when supplied', () => {
    const script = generateUpdateScript({
      ...baseParams,
      mycoBinary: '/Users/dev/.local/bin/myco-dev',
    });
    expect(script).toContain('MYCO="/Users/dev/.local/bin/myco-dev"');
  });

  it('installs multiple Myco package specs in one script', () => {
    const script = generateUpdateScript({
      ...baseParams,
      packageSpecs: ['@goondocks/myco@1.0.0', '@goondocks/myco-team@0.1.1'],
    });
    expect(script).toContain('"@goondocks/myco@1.0.0" "@goondocks/myco-team@0.1.1"');
  });

  it('installs beta builds into the managed machine runtime when requested', () => {
    const script = generateUpdateScript({
      ...baseParams,
      packageSpecs: [],
      localRuntimeSpec: '@goondocks/myco@1.1.0-beta.1',
    });
    // Paths now resolve against `~/.myco/` via resolveMycoHome().
    expect(script).toContain('npm install --prefix');
    expect(script).toContain('runtime.tmp');
    expect(script).toContain('"@goondocks/myco@1.1.0-beta.1"');
    expect(script).toContain('runtime.command');
    expect(script).toMatch(/MYCO="[^"]*runtime\/node_modules\/\.bin\/myco"/);
  });

  it('removes the managed machine runtime after a successful stable revert', () => {
    const script = generateUpdateScript({
      ...baseParams,
      removeLocalRuntime: true,
    });
    expect(script).toMatch(/rm -f "[^"]*runtime\.command"/);
    expect(script).toMatch(/rm -rf "[^"]*\/runtime"/);
    expect(script).toContain('MYCO="myco"');
  });

  // Service-managed update tail. Once PR #267 made the prod daemon
  // service-managed, the post-install `cd … && myco daemon &` line raced
  // launchd's KeepAlive for the canonical port — same bug shape as the
  // /restart fix in commit 78a2c421. The script must invoke the platform
  // restart primitive instead of spawning its own daemon.
  it('uses the service-restart command instead of spawning a daemon when service-managed', () => {
    const script = generateUpdateScript({
      ...baseParams,
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
    });
    expect(script).toContain('launchctl kickstart -k gui/501/co.goondocks.myco');
    // Critical: no parallel daemon spawn.
    expect(script).not.toContain('"$MYCO" daemon');
  });

  it('uses the systemd restart command on Linux', () => {
    const script = generateUpdateScript({
      ...baseParams,
      serviceRestartCommand: 'systemctl --user restart myco.service',
    });
    expect(script).toContain('systemctl --user restart myco.service');
    expect(script).not.toContain('"$MYCO" daemon');
  });

  it('falls back to spawning `myco daemon` when no service-restart command is supplied', () => {
    const script = generateUpdateScript(baseParams);
    expect(script).toContain('"$MYCO" daemon');
    expect(script).not.toContain('launchctl');
    expect(script).not.toContain('systemctl');
  });

  it('service-restart tail still runs after the npm install completes (sequenced after update_failed branch)', () => {
    // The restart command must follow the success/failure handling block so
    // we never restart before the install attempt has finished.
    const script = generateUpdateScript({
      ...baseParams,
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
    });
    const installIdx = script.indexOf('npm install');
    const restartIdx = script.indexOf('launchctl kickstart');
    expect(installIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(installIdx);
  });

  // -------------------------------------------------------------------------
  // Readiness guard — regression coverage for the double-respawn race.
  //
  // Bug shipped to users in v0.27.11: launchctl kickstart -k unconditionally
  // SIGTERMs the running daemon, but launchd's KeepAlive may have already
  // respawned the daemon from the freshly-installed binary by the time the
  // script reaches kickstart. Result: kickstart kills a fully-healthy new
  // daemon and forces a redundant respawn cycle through launchd's throttle
  // window (~10s of dead daemon, visible as "daemon never came back" to the
  // user). Fix: probe /health for the target version BEFORE kickstart; skip
  // when already converged.
  // -------------------------------------------------------------------------

  it('emits a readiness guard that probes /health on the canonical port', () => {
    const script = generateUpdateScript({
      ...baseParams,
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
    });
    expect(script).toContain('http://127.0.0.1:20915/health');
    // grep pattern asserts the version field matches the target literal.
    expect(script).toContain('"version":"1.0.0"');
  });

  it('guard runs AFTER npm install but BEFORE the supervisor restart', () => {
    const script = generateUpdateScript({
      ...baseParams,
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
    });
    const installIdx = script.indexOf('npm install');
    const guardIdx = script.indexOf('/health');
    const restartIdx = script.indexOf('launchctl kickstart');
    expect(installIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(restartIdx);
  });

  it('guard exits 0 (skip restart) when the running daemon already reports the target version', () => {
    const script = generateUpdateScript({
      ...baseParams,
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
    });
    // The guard's match branch must clean up and exit non-fatally so the
    // wrapping `set -e` doesn't surface a "failed restart" error.
    expect(script).toMatch(/grep -q[^\n]*\n\s*echo[^\n]*\n\s*rm -f "\$0"\s*\n\s*exit 0/);
  });

  it('guard fires for the non-service-managed daemon-spawn path too', () => {
    // Even without a serviceRestartCommand, the readiness probe still
    // guards the daemon spawn — we don't want two daemons fighting for
    // the canonical port either.
    const script = generateUpdateScript(baseParams);
    expect(script).toContain('http://127.0.0.1:20915/health');
    expect(script).toContain('"version":"1.0.0"');
  });

  it('readiness guard uses the dev daemon port when supplied', () => {
    const script = generateUpdateScript({
      ...baseParams,
      daemonPort: 19344,
      targetVersion: '0.27.12',
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco-dev',
    });
    expect(script).toContain('http://127.0.0.1:19344/health');
    expect(script).toContain('"version":"0.27.12"');
  });
});

describe('generateRestartScript() readiness guard', () => {
  const baseParams = {
    projectRoot: '/home/user/project',
    vaultDir: '/home/user/project/.myco',
    fromVersion: '0.17.0',
    toVersion: '0.17.1',
    mycoBinary: 'myco',
    daemonPort: 20915,
  };

  it('emits the readiness guard with toVersion as the target', () => {
    const script = generateRestartScript({
      ...baseParams,
      runLocalUpdate: false,
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
    });
    expect(script).toContain('http://127.0.0.1:20915/health');
    expect(script).toContain('"version":"0.17.1"');
  });
});
