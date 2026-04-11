import { describe, it, expect } from 'vitest';
import { generateRestartScript, generateUpdateScript } from '@myco/daemon/update-installer.js';

describe('generateRestartScript()', () => {
  const baseParams = {
    projectRoot: '/home/user/project',
    vaultDir: '/home/user/project/.myco',
    fromVersion: '0.17.0',
    toVersion: '0.17.1',
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

  it('uses MYCO_CMD env var with fallback', () => {
    const script = generateRestartScript({ ...baseParams, runLocalUpdate: false });
    expect(script).toContain('${MYCO_CMD:-myco}');
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
  it('generates a valid update script (existing behavior sanity check)', () => {
    const script = generateUpdateScript({
      targetVersion: '1.0.0',
      projectRoot: '/project',
      vaultDir: '/project/.myco',
    });
    expect(script).toContain('npm install -g');
    expect(script).toContain('update --project');
  });
});
