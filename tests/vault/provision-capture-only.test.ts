import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ensureProjectVault } from '../../packages/myco/src/vault/provision';

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe('ensureProjectVault capture-only default', () => {
  it('writes local.yaml with the four capability master gates off', () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    ensureProjectVault(dir);
    const localPath = join(dir, '.myco', 'local.yaml');
    expect(existsSync(localPath)).toBe(true);
    const local = parse(readFileSync(localPath, 'utf-8')) as any;
    expect(local.cortex.enabled).toBe(false);
    expect(local.cortex.canopy.enabled).toBe(false);
    expect(local.skills.enabled).toBe(false);
    expect(local.vault_evolution.enabled).toBe(false);
  });

  it('is idempotent — second call leaves local.yaml unchanged', () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    ensureProjectVault(dir);
    const localPath = join(dir, '.myco', 'local.yaml');
    const firstContent = readFileSync(localPath, 'utf-8');
    const firstMtime = require('node:fs').statSync(localPath).mtimeMs;

    ensureProjectVault(dir);
    const secondContent = readFileSync(localPath, 'utf-8');
    expect(secondContent).toBe(firstContent);
    // mtime unchanged — saveLocalConfig uses write-if-changed semantics
    expect(require('node:fs').statSync(localPath).mtimeMs).toBe(firstMtime);
  });
});
