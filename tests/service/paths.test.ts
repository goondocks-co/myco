import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import {
  isSandboxedServiceUnitDir,
  resolveServiceUnitDir,
  SERVICE_UNIT_DIR_ENV,
} from '../../packages/myco/src/service/paths';

const originalEnv = process.env[SERVICE_UNIT_DIR_ENV];

beforeEach(() => { delete process.env[SERVICE_UNIT_DIR_ENV]; });
afterEach(() => {
  if (originalEnv === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
  else process.env[SERVICE_UNIT_DIR_ENV] = originalEnv;
});

describe('resolveServiceUnitDir', () => {
  test('macOS default is ~/Library/LaunchAgents', () => {
    expect(resolveServiceUnitDir({ platform: 'darwin', env: {}, homeDir: '/Users/test' }))
      .toBe('/Users/test/Library/LaunchAgents');
  });

  test('Linux default is ~/.config/systemd/user', () => {
    expect(resolveServiceUnitDir({ platform: 'linux', env: {}, homeDir: '/home/test' }))
      .toBe('/home/test/.config/systemd/user');
  });

  test('MYCO_LAUNCH_AGENTS_DIR override wins on macOS', () => {
    expect(resolveServiceUnitDir({
      platform: 'darwin',
      env: { [SERVICE_UNIT_DIR_ENV]: '/tmp/sandbox/LaunchAgents' },
      homeDir: '/Users/test',
    })).toBe('/tmp/sandbox/LaunchAgents');
  });

  test('MYCO_LAUNCH_AGENTS_DIR override wins on Linux', () => {
    expect(resolveServiceUnitDir({
      platform: 'linux',
      env: { [SERVICE_UNIT_DIR_ENV]: '/tmp/sandbox/systemd' },
      homeDir: '/home/test',
    })).toBe('/tmp/sandbox/systemd');
  });

  test('whitespace-only override is ignored', () => {
    expect(resolveServiceUnitDir({
      platform: 'darwin',
      env: { [SERVICE_UNIT_DIR_ENV]: '   ' },
      homeDir: '/Users/test',
    })).toBe('/Users/test/Library/LaunchAgents');
  });

  test('relative override is resolved against cwd', () => {
    const result = resolveServiceUnitDir({
      platform: 'darwin',
      env: { [SERVICE_UNIT_DIR_ENV]: 'relative/LaunchAgents' },
      homeDir: '/Users/test',
    });
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith('relative/LaunchAgents')).toBe(true);
  });

  test('when env unset, defaults to real ~/Library/LaunchAgents on darwin', () => {
    delete process.env[SERVICE_UNIT_DIR_ENV];
    if (process.platform === 'darwin') {
      expect(resolveServiceUnitDir())
        .toBe(path.join(os.homedir(), 'Library', 'LaunchAgents'));
    }
  });
});

describe('isSandboxedServiceUnitDir', () => {
  test('false when env is unset', () => {
    expect(isSandboxedServiceUnitDir({ env: {} })).toBe(false);
  });

  test('true when env is set to a sandbox path', () => {
    expect(isSandboxedServiceUnitDir({
      env: { [SERVICE_UNIT_DIR_ENV]: '/tmp/sandbox/LaunchAgents' },
    })).toBe(true);
  });

  test('false when env is whitespace-only', () => {
    expect(isSandboxedServiceUnitDir({
      env: { [SERVICE_UNIT_DIR_ENV]: '   ' },
    })).toBe(false);
  });
});
