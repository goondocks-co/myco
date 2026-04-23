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

  it('includes myco update when runLocalUpdate is true', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: true });
    expect(script).toContain('update --project');
    expect(script).toContain('/home/user/project');
  });

  it('skips myco update when runLocalUpdate is false', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: false });
    expect(script).not.toContain('update --project');
  });

  it('always starts the daemon with --vault', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: false });
    expect(script).toContain('daemon --vault');
    expect(script).toContain('/home/user/project/.myco');
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
    expect(script).toContain('update --project');
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

  it('installs beta builds into the project-local runtime when requested', () => {
    const script = generateUpdateScript({
      ...baseParams,
      packageSpecs: [],
      localRuntimeSpec: '@goondocks/myco@1.1.0-beta.1',
    });
    expect(script).toContain('npm install --prefix "/project/.myco/runtime.tmp" "@goondocks/myco@1.1.0-beta.1"');
    expect(script).toContain('printf \'%s\\n\' "/project/.myco/runtime/node_modules/.bin/myco" > "/project/.myco/runtime.command"');
    expect(script).toContain('MYCO="/project/.myco/runtime/node_modules/.bin/myco"');
  });

  it('removes the project-local runtime after a successful stable revert', () => {
    const script = generateUpdateScript({
      ...baseParams,
      removeLocalRuntime: true,
    });
    expect(script).toContain('rm -f "/project/.myco/runtime.command"');
    expect(script).toContain('rm -rf "/project/.myco/runtime"');
    expect(script).toContain('MYCO="myco"');
  });
});
