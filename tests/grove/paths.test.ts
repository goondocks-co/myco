import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pathsEquivalent,
  resolveGroveDbPath,
  resolveGroveDir,
  resolveGroveProjectsPath,
  resolveGroveRootsPath,
  resolveMycoHome,
  resolveProjectManifestPath,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';

const GROVE_ID = 'grove_0123456789abcdef0123456789abcdef';

describe('Grove path primitives', () => {
  it('resolves the global Myco home from MYCO_HOME when provided', () => {
    const home = resolveMycoHome({
      env: { MYCO_HOME: '~/custom-myco' } as NodeJS.ProcessEnv,
      homeDir: '/Users/tester',
    });

    expect(home).toBe(path.join('/Users/tester', 'custom-myco'));
  });

  it('resolves Grove-local data paths under the global home', () => {
    const home = '/tmp/myco-home';

    expect(resolveGroveDir(GROVE_ID, home)).toBe(`/tmp/myco-home/groves/${GROVE_ID}`);
    expect(resolveGroveDbPath(GROVE_ID, home)).toBe(`/tmp/myco-home/groves/${GROVE_ID}/myco.db`);
    expect(resolveGroveProjectsPath(GROVE_ID, home)).toBe(`/tmp/myco-home/groves/${GROVE_ID}/registry/projects.toml`);
    expect(resolveGroveRootsPath(GROVE_ID, home)).toBe(`/tmp/myco-home/groves/${GROVE_ID}/registry/roots.toml`);
  });

  it('keeps project-local manifest paths thin and project rooted', () => {
    const vaultDir = resolveProjectVaultDir('/tmp/project');

    expect(vaultDir).toBe('/tmp/project/.myco');
    expect(resolveProjectManifestPath(vaultDir)).toBe('/tmp/project/.myco/project.toml');
  });

  describe('Grove id structural validation (G3)', () => {
    it('rejects bare path segments / traversal attempts', () => {
      expect(() => resolveGroveDir('..', '/tmp/myco-home')).toThrow(/Invalid Grove-era id/);
      expect(() => resolveGroveDir('../escape', '/tmp/myco-home')).toThrow(/Invalid Grove-era id/);
      expect(() => resolveGroveDir('/etc/passwd', '/tmp/myco-home')).toThrow(/Invalid Grove-era id/);
    });

    it('rejects ids with the wrong prefix', () => {
      const wrongPrefix = 'proj_0123456789abcdef0123456789abcdef';
      expect(() => resolveGroveDir(wrongPrefix, '/tmp/myco-home')).toThrow(/Invalid Grove-era id/);
      expect(() => resolveGroveDbPath(wrongPrefix, '/tmp/myco-home')).toThrow(/Invalid Grove-era id/);
    });

    it('rejects ids with the wrong hex length', () => {
      expect(() => resolveGroveDir('grove_short', '/tmp/myco-home')).toThrow(/Invalid Grove-era id/);
      expect(() => resolveGroveDir('grove_0123', '/tmp/myco-home')).toThrow(/Invalid Grove-era id/);
    });

    it('accepts a well-formed grove_<32 hex> id across every resolver', () => {
      const home = '/tmp/myco-home';
      expect(() => resolveGroveDir(GROVE_ID, home)).not.toThrow();
      expect(() => resolveGroveDbPath(GROVE_ID, home)).not.toThrow();
      expect(() => resolveGroveProjectsPath(GROVE_ID, home)).not.toThrow();
      expect(() => resolveGroveRootsPath(GROVE_ID, home)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// pathsEquivalent — case-insensitive identity on macOS APFS via inode compare
// ---------------------------------------------------------------------------

describe('pathsEquivalent', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-paths-eq-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns true for identical resolved strings', () => {
    expect(pathsEquivalent('/tmp/a', '/tmp/a')).toBe(true);
    expect(pathsEquivalent('/tmp/./a', '/tmp/a')).toBe(true);
  });

  it('returns true for case-mismatched paths to the same file (case-insensitive FS)', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    const dir = path.join(tmpRoot, 'CaseProj');
    fs.mkdirSync(dir, { recursive: true });
    const lower = path.join(tmpRoot, 'caseproj');
    expect(pathsEquivalent(dir, lower)).toBe(true);
  });

  it('returns true across symlink chains', () => {
    const realDir = path.join(tmpRoot, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    const linkDir = path.join(tmpRoot, 'link');
    fs.symlinkSync(realDir, linkDir);
    expect(pathsEquivalent(realDir, linkDir)).toBe(true);
  });

  it('returns false for distinct files', () => {
    const a = path.join(tmpRoot, 'a');
    const b = path.join(tmpRoot, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    expect(pathsEquivalent(a, b)).toBe(false);
  });

  it('returns false when either path does not exist', () => {
    expect(pathsEquivalent(path.join(tmpRoot, 'absent-a'), path.join(tmpRoot, 'absent-b'))).toBe(false);
  });
});
