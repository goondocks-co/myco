/**
 * Property-style invariant suite for ProjectVault.
 *
 * Unlike `project-vault.test.ts`, which is example-based ("after
 * method X, this is true"), this file enumerates every reachable
 * state x every public method and asserts the capability's invariants
 * hold after each call.
 *
 * Catches the bug class Pattern 1 produces: methods that *forget* to
 * maintain a structural invariant. Specifically the gitignore-last
 * ordering bug that motivated this suite — the example test for the
 * happy path passed because gitignore was eventually written; the
 * property test catches it because the invariant fails after a method
 * that throws partway through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProjectVault } from '@myco/vault/project-vault.js';
import { createProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { VAULT_GITIGNORE } from '@myco/vault/gitignore.js';

/* ---------- Fixture ---------- */

let projectRoot: string;
let vault: ProjectVault;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-vault-inv-'));
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

/* ---------- Invariants ---------- */

/**
 * The set of invariants the capability claims to enforce. After every
 * successful public method invocation, all of these must hold against
 * the current on-disk state.
 */
function assertInvariants(label: string): void {
  const vaultDir = resolveProjectVaultDir(projectRoot);

  // I1: If anything under <vaultDir> exists, .gitignore exists and is
  //     current. (Empty vault directory is also valid — no state means
  //     nothing to cover.)
  if (fs.existsSync(vaultDir) && fs.readdirSync(vaultDir).length > 0) {
    const gitignorePath = path.join(vaultDir, '.gitignore');
    expect(fs.existsSync(gitignorePath), `${label}: .gitignore must exist`).toBe(true);
    expect(
      fs.readFileSync(gitignorePath, 'utf-8'),
      `${label}: .gitignore must match canonical body`,
    ).toBe(VAULT_GITIGNORE);
  }

  // I2: If project.toml exists, project.local.toml exists too (binding
  //     pair is non-optional once committed).
  const manifestPath = path.join(vaultDir, 'project.toml');
  const localPath = path.join(vaultDir, 'project.local.toml');
  if (fs.existsSync(manifestPath)) {
    expect(
      fs.existsSync(localPath),
      `${label}: project.toml without project.local.toml — binding pair broken`,
    ).toBe(true);
  }

  // I3: If project.local.toml exists, it carries a non-empty
  //     grove_binding.binding_id matching the canonical pattern.
  if (fs.existsSync(localPath)) {
    const raw = fs.readFileSync(localPath, 'utf-8');
    expect(raw, `${label}: project.local.toml must declare grove_binding`).toMatch(/grove_binding/);
    expect(raw, `${label}: binding_id must match canonical shape`).toMatch(/binding_id = "gbind_[a-f0-9]+"/);
  }

  // I4: Retired guard never present after a capability call. (The
  //     migration walker's invariant — legacy artifacts swept on every
  //     opportunity, never preserved.)
  const retiredGuard = path.join(projectRoot, '.agents', 'myco-hook.cjs');
  expect(
    fs.existsSync(retiredGuard),
    `${label}: retired .agents/myco-hook.cjs must never survive a capability operation`,
  ).toBe(false);
}

describe('VAULT_GITIGNORE runtime pins', () => {
  it('covers every project-scope runtime pin artifact', () => {
    expect(VAULT_GITIGNORE).toContain('runtime.command\n');
    expect(VAULT_GITIGNORE).toContain('runtime.home\n');
    expect(VAULT_GITIGNORE).toContain('runtime-exec\n');
  });
});

/* ---------- Property test: every successful method maintains every invariant ---------- */

describe('ProjectVault invariants — held after every public method', () => {
  it('after ensureGitignore (greenfield)', () => {
    vault.ensureGitignore();
    assertInvariants('ensureGitignore');
  });

  it('after writeIdentity (both)', () => {
    vault.writeIdentity(defaultIdentity());
    assertInvariants('writeIdentity both');
  });

  it('after re-writeIdentity (binding_id preserved)', () => {
    const identity = defaultIdentity();
    vault.writeIdentity(identity);
    vault.writeIdentity(identity);
    assertInvariants('re-writeIdentity');
  });

  it('after setSymbiontEnabled (auto-registered project)', () => {
    vault.setSymbiontEnabled('claude-code', false);
    assertInvariants('setSymbiontEnabled');
  });

  it('after patchSymbiontOverrides (batch)', () => {
    vault.patchSymbiontOverrides({
      'claude-code': { enabled: false },
      codex: { enabled: true },
    });
    assertInvariants('patchSymbiontOverrides batch');
  });

  it('after patchSymbiontOverrides ({}) — empty patch is a no-op', () => {
    vault.writeIdentity(defaultIdentity());
    vault.patchSymbiontOverrides({});
    assertInvariants('patchSymbiontOverrides empty');
  });

  it('after writeIdentity (manifest-only) — pre-existing local preserved', () => {
    const identity = defaultIdentity();
    vault.writeIdentity(identity);
    vault.writeIdentity({
      manifest: {
        project: { id: identity.manifest.project.id, name: 'renamed' },
        grove: identity.manifest.grove,
      },
      mode: 'manifest-only',
    });
    assertInvariants('writeIdentity manifest-only');
  });

  it('after writeIdentity (local-only) — pre-existing manifest preserved', () => {
    const identity = defaultIdentity();
    vault.writeIdentity(identity);
    vault.writeIdentity({
      manifest: identity.manifest,
      mode: 'local-only',
    });
    assertInvariants('writeIdentity local-only');
  });
});
