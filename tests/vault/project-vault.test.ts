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
  ProjectIdMismatchError,
  ProjectVault,
  InvalidRuntimeCommandError,
  projectHasCommittedConfig,
} from '@myco/vault/project-vault.js';
import { createProjectId } from '@myco/grove/ids.js';
import {
  loadProjectLocalManifest,
  loadProjectManifest,
} from '@myco/config/project-manifest.js';
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

function defaultCommitOpts() {
  return {
    project: { id: createProjectId(), name: 'subject' },
    grove: {
      id: 'grove_00000000000000000000000000000001',
      slug: 'default',
      name: 'Default',
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

  it('reports committed after commitToRepo, including launcher/pin flags', () => {
    vault.commitToRepo({
      ...defaultCommitOpts(),
      writeLaunchers: true,
      runtimeCommand: '/usr/local/bin/myco-dev',
    });
    const state = vault.state();
    expect(state.kind).toBe('committed');
    if (state.kind !== 'committed') throw new Error('unreachable');
    expect(state.hasLaunchers).toBe(true);
    expect(state.hasRuntimePin).toBe(true);
  });
});

describe('Invariant: commit writes the full triple (manifest + binding + gitignore)', () => {
  it('writes project.toml + project.local.toml + .myco/.gitignore on commitToRepo', () => {
    const result = vault.commitToRepo(defaultCommitOpts());
    const vaultDir = resolveProjectVaultDir(projectRoot);
    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'project.local.toml'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, '.gitignore'))).toBe(true);
    expect(result.bindingId).toMatch(/^gbind_[a-f0-9]+$/);
  });

  it('writeIdentity also produces all three files', () => {
    const opts = defaultCommitOpts();
    vault.writeIdentity({
      manifest: {
        project: { id: opts.project.id, name: opts.project.name },
        grove: { id: opts.grove.id, slug: opts.grove.slug, name: opts.grove.name },
      },
    });
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

describe('Invariant: commit refuses to overwrite a foreign project.id', () => {
  it('throws ProjectIdMismatchError when an existing committed manifest binds a different project.id', () => {
    const opts = defaultCommitOpts();
    vault.commitToRepo(opts);
    expect(() => vault.commitToRepo({
      ...opts,
      project: { id: createProjectId(), name: opts.project.name },
    })).toThrow(ProjectIdMismatchError);
  });

  it('treats re-commit with the same project.id as idempotent', () => {
    const opts = defaultCommitOpts();
    const a = vault.commitToRepo(opts);
    const b = vault.commitToRepo(opts);
    expect(a.bindingId).toBe(b.bindingId);
  });
});

describe('Invariant: uncommit always sweeps the retired guard', () => {
  it('removes .agents/myco-hook.cjs even when remove_launchers=false', () => {
    vault.commitToRepo({ ...defaultCommitOpts(), writeLaunchers: true });
    const agentsDir = path.join(projectRoot, '.agents');
    fs.writeFileSync(path.join(agentsDir, 'myco-hook.cjs'), '// legacy\n');
    expect(fs.existsSync(path.join(agentsDir, 'myco-hook.cjs'))).toBe(true);

    const result = vault.uncommitFromRepo({ removeLaunchers: false, removeRuntimeCommand: false });
    expect(fs.existsSync(path.join(agentsDir, 'myco-hook.cjs'))).toBe(false);
    expect(result.removed).toContain(path.join('.agents', 'myco-hook.cjs'));
    // Active launchers still preserved because caller asked.
    expect(fs.existsSync(path.join(agentsDir, 'myco-run.cjs'))).toBe(true);
  });
});

describe('Invariant: binding_id is preserved across re-commit', () => {
  it('preserves the existing grove_binding.binding_id when re-committing', () => {
    const opts = defaultCommitOpts();
    const a = vault.commitToRepo(opts);
    const b = vault.commitToRepo(opts);
    expect(b.bindingId).toBe(a.bindingId);
    const local = loadProjectLocalManifest(vault.vaultDir);
    expect(local?.grove_binding?.binding_id).toBe(a.bindingId);
  });

  it('mints a fresh binding_id only when project.local.toml is absent', () => {
    const result = vault.commitToRepo(defaultCommitOpts());
    expect(result.bindingId).toMatch(/^gbind_/);
  });
});

describe('Validation gates', () => {
  it('rejects relative runtime_command', () => {
    expect(() => vault.commitToRepo({
      ...defaultCommitOpts(),
      runtimeCommand: 'myco-dev',
    })).toThrow(InvalidRuntimeCommandError);
  });

  it('writes runtime.command when path is absolute', () => {
    vault.commitToRepo({
      ...defaultCommitOpts(),
      runtimeCommand: '/usr/local/bin/myco-dev',
    });
    const pin = fs.readFileSync(path.join(projectRoot, '.myco', 'runtime.command'), 'utf-8');
    expect(pin.trim()).toBe('/usr/local/bin/myco-dev');
  });
});

describe('Module-level helper', () => {
  it('projectHasCommittedConfig matches isCommittedToRepo', () => {
    expect(projectHasCommittedConfig(projectRoot)).toBe(false);
    vault.commitToRepo(defaultCommitOpts());
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
    expect(manifest).toBeNull(); // commitToRepo wasn't called; manifest never written
  });
});
