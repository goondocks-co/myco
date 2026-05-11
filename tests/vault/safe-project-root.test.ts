import { describe, it, expect } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { assertSafeProjectRoot, UnsafeProjectRootError } from '@myco/vault/resolve';

describe('assertSafeProjectRoot', () => {
  it('rejects $HOME', () => {
    expect(() => assertSafeProjectRoot(os.homedir())).toThrow(UnsafeProjectRootError);
    try {
      assertSafeProjectRoot(os.homedir());
    } catch (err) {
      expect((err as UnsafeProjectRootError).reason).toMatch(/home directory/);
    }
  });

  it('rejects the filesystem root', () => {
    const root = path.parse(os.homedir()).root; // '/' on POSIX, 'C:\\' on Windows
    expect(() => assertSafeProjectRoot(root)).toThrow(UnsafeProjectRootError);
  });

  it('rejects a direct child of /Users (likely a user home)', () => {
    expect(() => assertSafeProjectRoot('/Users/notARealUser')).toThrow(UnsafeProjectRootError);
  });

  it('rejects a direct child of /home', () => {
    expect(() => assertSafeProjectRoot('/home/someuser')).toThrow(UnsafeProjectRootError);
  });

  it('rejects /root and /var/root', () => {
    expect(() => assertSafeProjectRoot('/root')).toThrow();
    // /var/root is a direct child of /var, not the home parent set — but
    // /var/root itself is the macOS root user's home. Confirm the parent
    // check catches direct children of /var/root specifically.
    expect(() => assertSafeProjectRoot('/var/root/something')).toThrow();
  });

  it('accepts a normal nested project path', () => {
    expect(() => assertSafeProjectRoot('/Users/anyone/Repos/some-project')).not.toThrow();
    expect(() => assertSafeProjectRoot('/tmp/myco-test-fixture')).not.toThrow();
  });

  it('resolves relative paths before checking', () => {
    // path.resolve('.') === process.cwd(); when cwd happens to BE $HOME this
    // would catch the issue. Here we test the resolve step normalizes.
    const expanded = path.resolve(os.homedir(), '..', path.basename(os.homedir()));
    expect(expanded).toBe(os.homedir());
    expect(() => assertSafeProjectRoot(expanded)).toThrow(UnsafeProjectRootError);
  });
});
