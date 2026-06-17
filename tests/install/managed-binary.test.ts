import { describe, it, expect } from 'bun:test';
import { managedBinDir, managedBinaryPath, writeInstallMarker, readInstallMarker } from '@myco/install/managed-binary';

describe('managed-binary', () => {
  it('resolves per-OS managed paths', () => {
    expect(managedBinaryPath('/home/u', 'linux')).toBe('/home/u/.myco/bin/myco');
    expect(managedBinaryPath('C:/Users/u', 'win32')).toMatch(/Myco[\\/]+bin[\\/]+myco\.exe$/);
  });

  describe('win32 with localAppData override', () => {
    it('uses the injected localAppData when provided', () => {
      // Real %LOCALAPPDATA% differs from <home>/AppData/Local under KF redirection.
      const result = managedBinaryPath('C:/Users/u', 'win32', 'D:/CustomAppData');
      expect(result).toMatch(/D:[/\\]CustomAppData[/\\]Myco[/\\]bin[/\\]myco\.exe/);
    });

    it('falls back to <home>/AppData/Local when localAppData is absent', () => {
      const result = managedBinaryPath('C:/Users/u', 'win32');
      expect(result).toMatch(/C:[/\\]Users[/\\]u[/\\]AppData[/\\]Local[/\\]Myco[/\\]bin[/\\]myco\.exe/);
    });

    it('ignores localAppData on posix', () => {
      const result = managedBinaryPath('/home/u', 'linux', 'D:/ShouldBeIgnored');
      expect(result).toBe('/home/u/.myco/bin/myco');
    });
  });

  describe('managedBinDir with localAppData', () => {
    it('uses the injected localAppData on win32', () => {
      const result = managedBinDir('C:/Users/u', 'win32', 'C:/Users/u/AppDataRedirected/Local');
      expect(result).toMatch(/AppDataRedirected[/\\]Local[/\\]Myco[/\\]bin/);
    });

    it('ignores localAppData on posix', () => {
      const result = managedBinDir('/home/u', 'darwin', 'D:/ShouldBeIgnored');
      expect(result).toBe('/home/u/.myco/bin');
    });
  });

  it('round-trips the marker', () => {
    const dir = `/tmp/mb-${process.pid}`;
    writeInstallMarker(dir, { channel: 'stable', source: 'npm', bin: `${dir}/bin/myco` });
    expect(readInstallMarker(dir)?.source).toBe('npm');
  });
});
