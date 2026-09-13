import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workerRigSpec, type WorkerRigConfig } from '../../scripts/smoke-worker-service.js';
import { renderLaunchdPlist } from '../../packages/myco/src/service/launchd-plist.js';

const config: WorkerRigConfig = {
  binary: '/Users/rig/bin/myco', mycoHome: '/Users/rig/member', root: '/Users/rig/worker',
  server: 'https://example.test', harness: 'codex', pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
  startAt: 'login',
};

describe('worker smoke rig service', () => {
  test('the actual command refuses an absent explicit membership home before running a worker', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, MYCO_SMOKE_START_AT: 'login', MYCO_SMOKE_BINARY: config.binary };
    delete env.MYCO_HOME;
    const result = spawnSync(process.execPath, ['--no-env-file', fileURLToPath(new URL('../../scripts/smoke-worker-service.ts', import.meta.url)), 'plan'], {
      env, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Set MYCO_HOME explicitly');
  });

  test('runs the selected worker with its membership home and login runtime', () => {
    const spec = workerRigSpec(config, '/Users/rig');
    expect(spec.args).toEqual(['worker', '--server', 'https://example.test', '--harness', 'codex']);
    expect(spec.env).toEqual({ HOME: '/Users/rig', MYCO_HOME: config.mycoHome, MYCO_TRAMPOLINED: '1', PATH: config.pathEnv });
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain(spec.stderrPath);
    expect(plist).not.toContain('<string>daemon</string>');
  });

  test('different Deployment or membership homes cannot replace each other', () => {
    const label = workerRigSpec(config).label;
    expect(workerRigSpec({ ...config, server: 'https://other.test' }).label).not.toBe(label);
    expect(workerRigSpec({ ...config, mycoHome: '/Users/rig/other' }).label).not.toBe(label);
  });

  test('boot mode names the invoking user and keeps the worker membership home', () => {
    const spec = workerRigSpec({ ...config, startAt: 'boot' });
    expect(spec.scope).toEqual({ startAt: 'boot', runAs: 'invoking-user' });
    expect(spec.env.MYCO_HOME).toBe(config.mycoHome);
    expect(spec.label).toBe(workerRigSpec(config).label);
  });

  test('refuses credential-bearing targets and incomplete worker selection', () => {
    expect(() => workerRigSpec({ ...config, server: 'https://member:secret@example.test' })).toThrow();
    expect(() => workerRigSpec({ ...config, server: 'https://example.test?token=secret' })).toThrow();
    expect(() => workerRigSpec({ ...config, harness: '' })).toThrow();
    expect(() => workerRigSpec({ ...config, binary: './myco' })).toThrow();
  });
});
