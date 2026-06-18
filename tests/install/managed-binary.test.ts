import { describe, it, expect } from 'bun:test';
import {
  managedBinDir,
  managedBinaryPath,
  versionsDir,
  versionDir,
  versionBinaryPath,
  writeInstallMarker,
  readInstallMarker,
} from '@myco/install/managed-binary';

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

  describe('versionsDir', () => {
    it('returns <bindir>/versions on linux', () => {
      expect(versionsDir('/home/u', 'linux')).toBe('/home/u/.myco/bin/versions');
    });

    it('returns <bindir>/versions on win32 (default appdata)', () => {
      const result = versionsDir('C:/Users/u', 'win32');
      expect(result).toMatch(/C:[/\\]Users[/\\]u[/\\]AppData[/\\]Local[/\\]Myco[/\\]bin[/\\]versions/);
    });

    it('honors localAppData override on win32', () => {
      const result = versionsDir('C:/Users/u', 'win32', 'D:/CustomAppData');
      expect(result).toMatch(/D:[/\\]CustomAppData[/\\]Myco[/\\]bin[/\\]versions/);
    });

    it('ignores localAppData on posix', () => {
      expect(versionsDir('/home/u', 'linux', 'D:/Ignored')).toBe('/home/u/.myco/bin/versions');
    });
  });

  describe('versionDir', () => {
    it('returns <bindir>/versions/<version> on linux', () => {
      expect(versionDir('/home/u', 'linux', '1.2.3')).toBe('/home/u/.myco/bin/versions/1.2.3');
    });

    it('returns correct path on win32', () => {
      const result = versionDir('C:/Users/u', 'win32', '1.2.3');
      expect(result).toMatch(/C:[/\\]Users[/\\]u[/\\]AppData[/\\]Local[/\\]Myco[/\\]bin[/\\]versions[/\\]1\.2\.3/);
    });

    it('honors localAppData override on win32', () => {
      const result = versionDir('C:/Users/u', 'win32', '1.2.3', 'D:/CustomAppData');
      expect(result).toMatch(/D:[/\\]CustomAppData[/\\]Myco[/\\]bin[/\\]versions[/\\]1\.2\.3/);
    });
  });

  describe('versionBinaryPath', () => {
    it('returns <bindir>/versions/<version>/myco on linux', () => {
      expect(versionBinaryPath('/home/u', 'linux', '1.2.3')).toBe(
        '/home/u/.myco/bin/versions/1.2.3/myco',
      );
    });

    it('returns <bindir>/versions/<version>/myco.exe on win32', () => {
      const result = versionBinaryPath('C:/Users/u', 'win32', '1.2.3');
      expect(result).toMatch(
        /C:[/\\]Users[/\\]u[/\\]AppData[/\\]Local[/\\]Myco[/\\]bin[/\\]versions[/\\]1\.2\.3[/\\]myco\.exe/,
      );
    });

    it('honors localAppData override on win32', () => {
      const result = versionBinaryPath('C:/Users/u', 'win32', '1.2.3', 'D:/CustomAppData');
      expect(result).toMatch(
        /D:[/\\]CustomAppData[/\\]Myco[/\\]bin[/\\]versions[/\\]1\.2\.3[/\\]myco\.exe/,
      );
    });

    it('ignores localAppData on posix', () => {
      expect(versionBinaryPath('/home/u', 'linux', '1.2.3', 'D:/Ignored')).toBe(
        '/home/u/.myco/bin/versions/1.2.3/myco',
      );
    });
  });

  it('round-trips the marker', () => {
    const dir = `/tmp/mb-${process.pid}`;
    writeInstallMarker(dir, { channel: 'stable', source: 'npm', bin: `${dir}/bin/myco` });
    expect(readInstallMarker(dir)?.source).toBe('npm');
  });
});
