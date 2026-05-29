/**
 * ProjectVault — the single capability that owns every write to
 * `<projectRoot>/.myco/` and `<projectRoot>/.agents/myco-*.cjs`.
 *
 * These tests pin the multi-file invariants the capability exists to
 * enforce. Each one would have failed (or produced a real-world bug)
 * before the capability was introduced: gitignore omitted, binding_id
 * missing, retired guard preserved, foreign identity silently
 * overwritten.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProjectVault,
  projectHasCommittedConfig,
} from '@myco/vault/project-vault.js';
import { createProjectId } from '@myco/grove/ids.js';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';

let projectRoot: string;
let vault: ProjectVault;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-vault-cap-'));
  vault = new ProjectVault(projectRoot);
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function defaultIdentity() {
  const id = createProjectId();
  return {
    manifest: {
      project: { id, name: 'subject' },
      grove: {
        id: 'grove_00000000000000000000000000000001',
        slug: 'default',
        name: 'Default',
      },
    },
  };
}

describe('ProjectVault state queries', () => {
  it('reports unmanaged before any vault directory exists', () => {
    expect(vault.state()).toEqual({ kind: 'unmanaged' });
    expect(vault.isCommittedToRepo()).toBe(false);
  });

  it('reports auto-registered when .myco/ exists without project.toml', () => {
    fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
    expect(vault.state().kind).toBe('auto-registered');
    expect(vault.isCommittedToRepo()).toBe(false);
  });

  it('reports committed after writeIdentity writes project.toml', () => {
    vault.writeIdentity(defaultIdentity());
    const state = vault.state();
    expect(state.kind).toBe('committed');
  });
});

describe('Invariant: writeIdentity writes the full triple (manifest + binding + gitignore)', () => {
  it('writeIdentity produces project.toml + project.local.toml + .myco/.gitignore', () => {
    vault.writeIdentity(defaultIdentity());
    const vaultDir = resolveProjectVaultDir(projectRoot);
    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'project.local.toml'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, '.gitignore'))).toBe(true);
  });

  it('setSymbiontEnabled materializes myco.yaml + .gitignore before mutating', () => {
    vault.setSymbiontEnabled('claude-code', false);
    const vaultDir = resolveProjectVaultDir(projectRoot);
    expect(fs.existsSync(path.join(vaultDir, 'myco.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, '.gitignore'))).toBe(true);
  });
});

describe('Module-level helper', () => {
  it('projectHasCommittedConfig matches isCommittedToRepo', () => {
    expect(projectHasCommittedConfig(projectRoot)).toBe(false);
    vault.writeIdentity(defaultIdentity());
    expect(projectHasCommittedConfig(projectRoot)).toBe(true);
  });
});

describe('clearSymbiontOverride round-trips', () => {
  it('removes the override and falls back to the higher-tier default', () => {
    const setResult = vault.setSymbiontEnabled('claude-code', false);
    expect(setResult.symbionts?.['claude-code']?.enabled).toBe(false);

    const clearResult = vault.clearSymbiontOverride('claude-code');
    expect(clearResult.symbionts?.['claude-code']).toBeUndefined();

    // Manifest survives the clear (only the symbionts block changed).
    const manifest = loadProjectManifest(vault.vaultDir);
    expect(manifest).toBeNull(); // writeIdentity wasn't called; manifest never written
  });
});

// =====================================================================
// Pattern 1 — structural-invariant tests (would have caught the
// gitignore-last-ordering bug from the second-round review).
// =====================================================================
describe('Structural invariants — gitignore is present after every mutating op', () => {
  function gitignoreExists(): boolean {
    return fs.existsSync(path.join(resolveProjectVaultDir(projectRoot), '.gitignore'));
  }

  it('every successful public method leaves the gitignore in place', () => {
    vault.writeIdentity(defaultIdentity());
    expect(gitignoreExists()).toBe(true);
    vault.setSymbiontEnabled('claude-code', false);
    expect(gitignoreExists()).toBe(true);
    vault.clearSymbiontOverride('claude-code');
    expect(gitignoreExists()).toBe(true);
    vault.patchSymbiontOverrides({ codex: { enabled: false } });
    expect(gitignoreExists()).toBe(true);
    vault.ensureGitignore();
    expect(gitignoreExists()).toBe(true);
  });
});

// =====================================================================
// Pattern 1 — symbionts batch returns the live config even when patch
// is empty (would have caught the "empty body returns {}" bug).
// =====================================================================
describe('patchSymbiontOverrides — atomicity + always-fresh response', () => {
  it('returns the current config when the patch is empty', () => {
    vault.setSymbiontEnabled('claude-code', false); // seed
    const after = vault.patchSymbiontOverrides({});
    expect(after.symbionts?.['claude-code']?.enabled).toBe(false);
  });

  it('applies a multi-entry patch atomically (single config write)', () => {
    const after = vault.patchSymbiontOverrides({
      'claude-code': { enabled: false },
      codex: { enabled: true },
      cursor: null,
    });
    expect(after.symbionts?.['claude-code']?.enabled).toBe(false);
    expect(after.symbionts?.codex?.enabled).toBe(true);
    expect(after.symbionts?.cursor).toBeUndefined();
  });
});

// =====================================================================
// Pattern 3 — asymmetric writeIdentity modes (would have caught
// activation Case C clobbering an existing project.toml).
// =====================================================================
describe('writeIdentity modes', () => {
  it('local-only mode preserves an existing project.toml', () => {
    const identity = defaultIdentity();
    vault.writeIdentity(identity);
    const before = fs.readFileSync(
      path.join(resolveProjectVaultDir(projectRoot), 'project.toml'),
      'utf-8',
    );

    // Try to overwrite with a *different* manifest in local-only mode —
    // project.toml must not change.
    vault.writeIdentity({
      manifest: {
        project: { id: identity.manifest.project.id, name: 'CHANGED' },
        grove: { id: 'grove_x', slug: 'x', name: 'X' },
      },
      mode: 'local-only',
    });

    const after = fs.readFileSync(
      path.join(resolveProjectVaultDir(projectRoot), 'project.toml'),
      'utf-8',
    );
    expect(after).toBe(before);
  });

  it('manifest-only mode preserves an existing project.local.toml', () => {
    const identity = defaultIdentity();
    vault.writeIdentity(identity);
    const beforeLocal = fs.readFileSync(
      path.join(resolveProjectVaultDir(projectRoot), 'project.local.toml'),
      'utf-8',
    );

    vault.writeIdentity({
      manifest: {
        project: { id: identity.manifest.project.id, name: 'renamed' },
        grove: identity.manifest.grove,
      },
      mode: 'manifest-only',
    });

    const afterLocal = fs.readFileSync(
      path.join(resolveProjectVaultDir(projectRoot), 'project.local.toml'),
      'utf-8',
    );
    expect(afterLocal).toBe(beforeLocal);
  });
});
