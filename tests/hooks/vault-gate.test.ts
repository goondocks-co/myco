/**
 * Tests for resolveProvisionedVaultDir — the hook-side gate that
 * decides whether a hook event should proceed to the daemon, auto-
 * provisioning the project's .myco/ on first contact and triggering
 * the legacy-to-global migration when the sentinel is absent.
 *
 * Plan reference: 38cff0752c919ffd §6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProvisionedVaultDir } from '@myco/hooks/vault-gate.js';
import { hasGlobalInstallMigrationCompleted } from '@myco/grove/global-install-migration.js';

function makeTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vault-gate-project-'));
}

function makeGitProject(): string {
  const root = makeTmpProject();
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  return root;
}

describe('resolveProvisionedVaultDir', () => {
  let mycoHome: string;
  let priorMycoHome: string | undefined;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vault-gate-home-'));
    priorMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = priorMycoHome;
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('auto-provisions a fresh vault for a git project without .myco/', () => {
    const projectRoot = makeGitProject();
    try {
      const vaultDir = resolveProvisionedVaultDir(projectRoot);
      expect(vaultDir).not.toBeNull();
      expect(vaultDir).toBe(path.join(projectRoot, '.myco'));
      expect(fs.existsSync(path.join(projectRoot, '.myco/myco.yaml'))).toBe(true);
      // Born-global sentinel pre-written by the provisioner.
      expect(hasGlobalInstallMigrationCompleted(projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns the existing vault when the project already has one', () => {
    const projectRoot = makeGitProject();
    try {
      // Seed an existing vault WITH the sentinel so no migration runs.
      fs.mkdirSync(path.join(projectRoot, '.myco/migration'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.myco/myco.yaml'), 'version: 3\n');
      fs.writeFileSync(
        path.join(projectRoot, '.myco/migration/global-install-complete.json'),
        JSON.stringify({ schema_version: 1, migrated_at: 0, pass_id: 'test', archived_to: null }),
      );

      const vaultDir = resolveProvisionedVaultDir(projectRoot);
      expect(vaultDir).toBe(path.join(projectRoot, '.myco'));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns null for a directory that is not a git project', () => {
    const projectRoot = makeTmpProject();  // NOT a git repo
    try {
      const vaultDir = resolveProvisionedVaultDir(projectRoot);
      expect(vaultDir).toBeNull();
      expect(fs.existsSync(path.join(projectRoot, '.myco'))).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('triggers the one-shot migration for a legacy vault without the sentinel', () => {
    const projectRoot = makeGitProject();
    try {
      // Seed a legacy-shaped vault: myco.yaml present, sentinel ABSENT.
      fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.myco/myco.yaml'), 'version: 3\n');

      expect(hasGlobalInstallMigrationCompleted(projectRoot)).toBe(false);
      const vaultDir = resolveProvisionedVaultDir(projectRoot);
      expect(vaultDir).toBe(path.join(projectRoot, '.myco'));
      // The lazy migration wrote the sentinel.
      expect(hasGlobalInstallMigrationCompleted(projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('logs a provision-failed trace instead of dropping silently', () => {
    const projectRoot = makeGitProject();
    try {
      // Make `.myco` a FILE so ensureProjectVault's mkdir/write throws.
      fs.writeFileSync(path.join(projectRoot, '.myco'), 'not a dir');
      const writes: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      // @ts-expect-error test shim over stderr.write
      process.stderr.write = (chunk: string) => { writes.push(String(chunk)); return true; };
      let vaultDir: string | null = null;
      try {
        vaultDir = resolveProvisionedVaultDir(projectRoot);
      } finally {
        process.stderr.write = orig;
      }
      expect(vaultDir).toBeNull();
      expect(writes.join('')).toContain('provision-failed');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('traces a non-git skip only when MYCO_AGENT_DEBUG is set', () => {
    const projectRoot = makeTmpProject(); // NOT a git repo
    const prior = process.env.MYCO_AGENT_DEBUG;
    const orig = process.stderr.write.bind(process.stderr);
    try {
      // Without debug: silent.
      let writes: string[] = [];
      delete process.env.MYCO_AGENT_DEBUG;
      // @ts-expect-error test shim over stderr.write
      process.stderr.write = (chunk: string) => { writes.push(String(chunk)); return true; };
      expect(resolveProvisionedVaultDir(projectRoot)).toBeNull();
      process.stderr.write = orig;
      expect(writes.join('')).not.toContain('non-git');

      // With debug: traced.
      writes = [];
      process.env.MYCO_AGENT_DEBUG = '1';
      // @ts-expect-error test shim over stderr.write
      process.stderr.write = (chunk: string) => { writes.push(String(chunk)); return true; };
      expect(resolveProvisionedVaultDir(projectRoot)).toBeNull();
      process.stderr.write = orig;
      expect(writes.join('')).toContain('non-git-or-unsafe-root');
    } finally {
      process.stderr.write = orig;
      if (prior === undefined) delete process.env.MYCO_AGENT_DEBUG;
      else process.env.MYCO_AGENT_DEBUG = prior;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('is cheap on the hot path: second call after the first does not rewrite the sentinel', () => {
    const projectRoot = makeGitProject();
    try {
      resolveProvisionedVaultDir(projectRoot);
      const sentinelPath = path.join(projectRoot, '.myco/migration/global-install-complete.json');
      const mtime = fs.statSync(sentinelPath).mtimeMs;
      resolveProvisionedVaultDir(projectRoot);
      expect(fs.statSync(sentinelPath).mtimeMs).toBe(mtime);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
