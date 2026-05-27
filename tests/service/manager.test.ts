import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { getServiceManager } from '../../packages/myco/src/service/manager';
import { LaunchdServiceManager } from '../../packages/myco/src/service/launchd';
import { SystemdUserServiceManager } from '../../packages/myco/src/service/systemd';
import { UnsupportedServiceManager } from '../../packages/myco/src/service/unsupported';
import { SERVICE_UNIT_DIR_ENV } from '../../packages/myco/src/service/paths';

const originalEnv = process.env[SERVICE_UNIT_DIR_ENV];

beforeEach(() => { delete process.env[SERVICE_UNIT_DIR_ENV]; });
afterEach(() => {
  if (originalEnv === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
  else process.env[SERVICE_UNIT_DIR_ENV] = originalEnv;
});

describe('getServiceManager', () => {
  test('returns LaunchdServiceManager on darwin', () => {
    expect(getServiceManager({ platform: 'darwin' })).toBeInstanceOf(LaunchdServiceManager);
  });

  test('returns SystemdUserServiceManager on linux', () => {
    expect(getServiceManager({ platform: 'linux' })).toBeInstanceOf(SystemdUserServiceManager);
  });

  test('returns UnsupportedServiceManager on win32', () => {
    const mgr = getServiceManager({ platform: 'win32' });
    expect(mgr).toBeInstanceOf(UnsupportedServiceManager);
    expect(mgr.supported).toBe(false);
  });

  test('darwin manager defaults agentsDir to ~/Library/LaunchAgents when MYCO_LAUNCH_AGENTS_DIR is unset', () => {
    const mgr = getServiceManager({ platform: 'darwin' }) as LaunchdServiceManager;
    expect(mgr.agentsDir).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents'));
  });

  test('darwin manager honors MYCO_LAUNCH_AGENTS_DIR override — sandbox plist never lands in real ~/Library/LaunchAgents', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-xyz/Library/LaunchAgents';
    const mgr = getServiceManager({ platform: 'darwin' }) as LaunchdServiceManager;
    expect(mgr.agentsDir).toBe('/tmp/sandbox-xyz/Library/LaunchAgents');
    expect(mgr.agentsDir).not.toBe(path.join(os.homedir(), 'Library', 'LaunchAgents'));
  });

  test('linux manager defaults unitDir to ~/.config/systemd/user when MYCO_LAUNCH_AGENTS_DIR is unset', () => {
    const mgr = getServiceManager({ platform: 'linux' }) as SystemdUserServiceManager;
    expect(mgr.unitDir).toBe(path.join(os.homedir(), '.config', 'systemd', 'user'));
  });

  test('linux manager honors MYCO_LAUNCH_AGENTS_DIR override', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-xyz/systemd/user';
    const mgr = getServiceManager({ platform: 'linux' }) as SystemdUserServiceManager;
    expect(mgr.unitDir).toBe('/tmp/sandbox-xyz/systemd/user');
  });
});
