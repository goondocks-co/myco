import { describe, expect, test } from 'bun:test';
import { UnsupportedServiceManager } from '../../packages/myco/src/service/unsupported';

describe('UnsupportedServiceManager', () => {
  test('supported=false', () => {
    const mgr = new UnsupportedServiceManager('win32');
    expect(mgr.supported).toBe(false);
    expect(mgr.platformName).toBe('unsupported (win32)');
  });

  test('all operations throw a clear "not yet supported" error', async () => {
    const mgr = new UnsupportedServiceManager('win32');
    await expect(mgr.install({} as any)).rejects.toThrow(/not.*supported.*win32/i);
    await expect(mgr.uninstall('x')).rejects.toThrow(/not.*supported.*win32/i);
    await expect(mgr.start('x')).rejects.toThrow(/not.*supported.*win32/i);
    await expect(mgr.stop('x')).rejects.toThrow(/not.*supported.*win32/i);
    await expect(mgr.restart('x')).rejects.toThrow(/not.*supported.*win32/i);
  });

  test('status returns a sentinel — does not throw', async () => {
    const mgr = new UnsupportedServiceManager('win32');
    const st = await mgr.status('x');
    expect(st.installed).toBe(false);
    expect(st.running).toBe(false);
  });
});
