import { describe, expect, test } from 'bun:test';
import { getServiceManager } from '../../packages/myco/src/service/manager';
import { LaunchdServiceManager } from '../../packages/myco/src/service/launchd';
import { SystemdUserServiceManager } from '../../packages/myco/src/service/systemd';
import { UnsupportedServiceManager } from '../../packages/myco/src/service/unsupported';

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
});
