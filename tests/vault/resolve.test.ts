import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveVaultDir } from '@myco/vault/resolve.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-resolve-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveVaultDir', () => {
  it('resolves to <git-root>/.myco when cwd is inside a git repo', () => {
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    const subdir = path.join(tmpDir, 'pkg', 'src');
    fs.mkdirSync(subdir, { recursive: true });

    const result = resolveVaultDir(subdir);

    expect(result).toBe(path.join(tmpDir, '.myco'));
  });

  it('falls back to <cwd>/.myco when cwd is not inside a git repo', () => {
    const result = resolveVaultDir(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.myco'));
  });
});
