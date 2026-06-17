import { describe, it, expect } from 'bun:test';
import { managedBinDir, managedBinaryPath, writeInstallMarker, readInstallMarker } from '@myco/install/managed-binary';

describe('managed-binary', () => {
  it('resolves per-OS managed paths', () => {
    expect(managedBinaryPath('/home/u', 'linux')).toBe('/home/u/.myco/bin/myco');
    expect(managedBinaryPath('C:/Users/u', 'win32')).toMatch(/Myco[\\/]+bin[\\/]+myco\.exe$/);
  });
  it('round-trips the marker', () => {
    const dir = `/tmp/mb-${process.pid}`;
    writeInstallMarker(dir, { channel: 'stable', source: 'npm', bin: `${dir}/bin/myco` });
    expect(readInstallMarker(dir)?.source).toBe('npm');
  });
});
