/**
 * Tests for ensureProjectVault — the daemon-side auto-vault provisioner.
 *
 * Plan reference: 38cff0752c919ffd §6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectVault, MINIMAL_MYCO_YAML } from '@myco/vault/provision.js';
import { hasGlobalInstallMigrationCompleted, readMigrationSentinel } from '@myco/grove/global-install-migration.js';

function makeTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provision-project-'));
}

describe('ensureProjectVault', () => {
  let projectRoot: string;
  let mycoHome: string;
  let priorMycoHome: string | undefined;

  beforeEach(() => {
    projectRoot = makeTmpProject();
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provision-home-'));
    priorMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = priorMycoHome;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('creates the minimal vault when the project has none', () => {
    const result = ensureProjectVault(projectRoot);
    expect(result.created).toBe(true);
    expect(result.vaultDir).toBe(path.join(projectRoot, '.myco'));
    expect(typeof result.projectId).toBe('string');
    expect(result.projectId.length).toBeGreaterThan(0);

    // Files materialized.
    expect(fs.readFileSync(path.join(result.vaultDir, 'myco.yaml'), 'utf-8')).toBe(MINIMAL_MYCO_YAML);
    expect(fs.existsSync(path.join(result.vaultDir, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(result.vaultDir, 'project.toml'))).toBe(true);
  });

  it('pre-writes the global-install migration sentinel (born-global)', () => {
    ensureProjectVault(projectRoot);
    expect(hasGlobalInstallMigrationCompleted(projectRoot)).toBe(true);
    const sentinel = readMigrationSentinel(projectRoot);
    expect(sentinel?.schema_version).toBe(1);
    expect(sentinel?.archived_to).toBeNull();
    expect(sentinel?.pass_id).toMatch(/^born-global-/);
  });

  it('uses basename(projectRoot) as default project name', () => {
    // Move to a project root whose basename is something distinctive.
    const labeled = path.join(os.tmpdir(), `myco-named-${Math.random().toString(16).slice(2, 8)}`);
    fs.mkdirSync(labeled);
    try {
      ensureProjectVault(labeled);
      const tomlRaw = fs.readFileSync(path.join(labeled, '.myco/project.toml'), 'utf-8');
      expect(tomlRaw).toContain(`name = "${path.basename(labeled)}"`);
    } finally {
      fs.rmSync(labeled, { recursive: true, force: true });
    }
  });

  it('accepts an explicit projectName override', () => {
    ensureProjectVault(projectRoot, { projectName: 'my-override-name' });
    const tomlRaw = fs.readFileSync(path.join(projectRoot, '.myco/project.toml'), 'utf-8');
    expect(tomlRaw).toContain('name = "my-override-name"');
  });

  it('is idempotent — second call returns created=false and does not rewrite files', () => {
    const first = ensureProjectVault(projectRoot);
    const yamlMtime = fs.statSync(path.join(first.vaultDir, 'myco.yaml')).mtimeMs;
    const sentinelMtime = fs.statSync(path.join(first.vaultDir, 'migration/global-install-complete.json')).mtimeMs;

    const second = ensureProjectVault(projectRoot);
    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(fs.statSync(path.join(first.vaultDir, 'myco.yaml')).mtimeMs).toBe(yamlMtime);
    expect(fs.statSync(path.join(first.vaultDir, 'migration/global-install-complete.json')).mtimeMs).toBe(sentinelMtime);
  });
});
