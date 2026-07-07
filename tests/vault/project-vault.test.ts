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

describe('OKF private control state — .myco/okf/*', () => {
  it('write helpers materialize the gitignore (with okf/) before creating anything', () => {
    const stateDir = vault.okfStateDir();
    expect(fs.existsSync(stateDir)).toBe(true);
    const gitignore = fs.readFileSync(path.join(projectRoot, '.myco/.gitignore'), 'utf-8');
    expect(gitignore).toContain('okf/');

    const stagingDir = vault.okfStagingDir();
    expect(fs.existsSync(stagingDir)).toBe(true);
    expect(stateDir).toBe(path.join(projectRoot, '.myco/okf/state'));
    expect(stagingDir).toBe(path.join(projectRoot, '.myco/okf/staging'));
  });

  it('read helpers on a fresh project create NOTHING', () => {
    expect(vault.okfLocalBundleDir()).toBe(path.join(projectRoot, '.myco/okf/bundle'));
    expect(vault.okfLockPath()).toBe(path.join(projectRoot, '.myco/okf/state/lock'));
    expect(vault.okfManifestPath()).toBe(path.join(projectRoot, '.myco/okf/state/manifest.json'));
    expect(vault.readOkfManifest()).toBeNull();
    // Snapshot: neither .myco/okf nor .myco/.gitignore was created by reads.
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/.gitignore'))).toBe(false);
  });

  it('manifest round-trips including acknowledged_findings, probe_fingerprint, and last_run_ref', () => {
    const manifest = {
      bundle_generation: 3,
      inputs_hash: 'abc123',
      output_root: path.join(projectRoot, 'okf'),
      last_result: 'published' as const,
      generated_at: '2026-07-05T12:00:00Z',
      acknowledged_findings: [{ code: 'likely_secret', path: 'spores/decisions/d1.md' }],
      probe_fingerprint: 'fp-1',
      last_run_ref: { headSha: 'deadbeef', maxVaultUpdatedAt: 1_783_000_000 },
    };
    vault.writeOkfManifest(manifest);
    expect(vault.readOkfManifest()).toEqual(manifest);
    // Gitignore-first discipline held for the manifest write too.
    const gitignore = fs.readFileSync(path.join(projectRoot, '.myco/.gitignore'), 'utf-8');
    expect(gitignore).toContain('okf/');
  });

  it('a manifest predating last_run_ref (key entirely absent) reads clean, not corrupt', () => {
    // Mirrors a real manifest published before Task 2.4 added last_run_ref:
    // generation + probe_fingerprint + acknowledged_findings present, the
    // last_run_ref key never written at all (not even as null). Must be
    // treated as valid — rejecting it would reset bundle_generation and
    // acknowledged_findings on the project's next okf-synthesize publish.
    vault.okfStateDir();
    fs.writeFileSync(
      vault.okfManifestPath(),
      JSON.stringify({
        bundle_generation: 2,
        inputs_hash: 'abc123',
        output_root: path.join(projectRoot, 'okf'),
        last_result: 'published',
        generated_at: '2026-07-05T12:00:00Z',
        acknowledged_findings: [{ code: 'likely_secret', path: 'spores/decisions/d1.md' }],
        probe_fingerprint: 'fp-1',
        // last_run_ref intentionally omitted.
      }),
    );
    const manifest = vault.readOkfManifest();
    expect(manifest).not.toBeNull();
    expect(manifest?.bundle_generation).toBe(2);
    expect(manifest?.acknowledged_findings).toHaveLength(1);
    expect(manifest?.last_run_ref).toBeNull();
  });

  it('a manifest predating pending_findings (key entirely absent) reads clean, not corrupt', () => {
    // Same backward-compat lesson as last_run_ref (Task 7.1 added pending_findings):
    // an absent key must validate, or the guard would silently drop the whole
    // manifest and reset generation/acks on the next publish.
    vault.okfStateDir();
    fs.writeFileSync(
      vault.okfManifestPath(),
      JSON.stringify({
        bundle_generation: 2,
        inputs_hash: 'abc123',
        output_root: path.join(projectRoot, 'okf'),
        last_result: 'published',
        generated_at: '2026-07-05T12:00:00Z',
        acknowledged_findings: [],
        probe_fingerprint: 'fp-1',
        last_run_ref: null,
        // pending_findings intentionally omitted.
      }),
    );
    const manifest = vault.readOkfManifest();
    expect(manifest).not.toBeNull();
    expect(manifest?.bundle_generation).toBe(2);
    expect(manifest?.pending_findings).toBeUndefined();
  });

  it('manifest round-trips pending_findings and the publish_blocked last_result', () => {
    const manifest = {
      bundle_generation: 4,
      inputs_hash: 'h',
      output_root: path.join(projectRoot, 'okf'),
      last_result: 'publish_blocked' as const,
      generated_at: '2026-07-05T12:00:00Z',
      acknowledged_findings: [],
      pending_findings: [{ code: 'absolute_local_path', path: 'pages/leaky.md', hash: 'abcd1234' }],
      probe_fingerprint: null,
      last_run_ref: null,
    };
    vault.writeOkfManifest(manifest);
    expect(vault.readOkfManifest()).toEqual(manifest);
  });

  it('treats a shape-invalid pending_findings as corrupt (null)', () => {
    vault.okfStateDir();
    fs.writeFileSync(
      vault.okfManifestPath(),
      JSON.stringify({
        bundle_generation: 1,
        inputs_hash: null,
        output_root: '/x',
        last_result: null,
        generated_at: null,
        acknowledged_findings: [],
        probe_fingerprint: null,
        last_run_ref: null,
        pending_findings: [{ code: 'x' /* missing path */ }],
      }),
    );
    expect(vault.readOkfManifest()).toBeNull();
  });

  it('corrupt manifest returns null without throwing', () => {
    vault.okfStateDir();
    fs.writeFileSync(vault.okfManifestPath(), '{ not json');
    expect(vault.readOkfManifest()).toBeNull();
    fs.writeFileSync(vault.okfManifestPath(), '"scalar-root"');
    expect(vault.readOkfManifest()).toBeNull();
  });

  it('treats a shape-invalid manifest as corrupt (null), not a malformed object', () => {
    vault.okfStateDir();
    // Parses as JSON but violates the OkfPrivateManifest shape — a hand-edited
    // or partially-written file. The pure-read contract must return null so
    // Plan-4 consumers never see a NaN generation or an undefined findings list.
    fs.writeFileSync(vault.okfManifestPath(), JSON.stringify({ bundle_generation: 'not-a-number', extra: true }));
    expect(vault.readOkfManifest()).toBeNull();
    fs.writeFileSync(vault.okfManifestPath(), JSON.stringify({}));
    expect(vault.readOkfManifest()).toBeNull();
    // Missing acknowledged_findings array.
    fs.writeFileSync(
      vault.okfManifestPath(),
      JSON.stringify({
        bundle_generation: 1,
        inputs_hash: null,
        output_root: '/x',
        last_result: null,
        generated_at: null,
        probe_fingerprint: null,
        last_run_ref: null,
      }),
    );
    expect(vault.readOkfManifest()).toBeNull();
    // A bad last_result enum value.
    fs.writeFileSync(
      vault.okfManifestPath(),
      JSON.stringify({
        bundle_generation: 1,
        inputs_hash: null,
        output_root: '/x',
        last_result: 'exploded',
        generated_at: null,
        acknowledged_findings: [],
        probe_fingerprint: null,
        last_run_ref: null,
      }),
    );
    expect(vault.readOkfManifest()).toBeNull();
    // A shape-invalid last_run_ref (headSha wrong type, maxVaultUpdatedAt missing).
    fs.writeFileSync(
      vault.okfManifestPath(),
      JSON.stringify({
        bundle_generation: 1,
        inputs_hash: null,
        output_root: '/x',
        last_result: null,
        generated_at: null,
        acknowledged_findings: [],
        probe_fingerprint: null,
        last_run_ref: { headSha: 123 },
      }),
    );
    expect(vault.readOkfManifest()).toBeNull();
  });
});
