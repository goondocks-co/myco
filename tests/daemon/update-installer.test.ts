import { describe, it, expect } from 'bun:test';
import { generateRestartScript, generateUpdateScript } from '@myco/daemon/update-installer.js';

describe('generateRestartScript()', () => {
  const baseParams = {
    projectRoot: '/home/user/project',
    vaultDir: '/home/user/project/.myco',
    fromVersion: '0.17.0',
    toVersion: '0.17.1',
    mycoBinary: 'myco',
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
});

describe('generateUpdateScript()', () => {
  const baseParams = {
    packageSpecs: ['@goondocks/myco@1.0.0'],
    projectRoot: '/project',
    vaultDir: '/project/.myco',
    mycoBinary: 'myco',
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
});
