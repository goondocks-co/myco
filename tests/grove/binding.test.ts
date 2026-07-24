/**
 * Tests for `grove/binding.ts:resolveProjectGroveBinding` — the single
 * source of truth for "is this vault grove-bound, legacy, or in a
 * partially-broken state?" Every code path that branches on grove-vs-legacy
 * must consult the helper rather than checking one leg in isolation;
 * these tests pin down the four outcomes plus the auto-repair flow.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';
import {
  resolveProjectGroveBinding as resolveProjectGroveBindingWith,
  type ResolveProjectGroveBindingOptions,
  vaultDirForProjectRoot,
} from '@myco/grove/binding.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { activationMarkerPath } from '@myco/grove/activation.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const resolveProjectGroveBinding = (
  targetVaultDir: string,
  options: ResolveProjectGroveBindingOptions = {},
) => resolveProjectGroveBindingWith(targetVaultDir, {
  ...options,
  lockNamespace: testPerUserLockNamespace,
});

let tmpHome: string;
let projectRoot: string;
let vaultDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-binding-home-'));
  prevHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = tmpHome;
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-binding-proj-'));
  vaultDir = vaultDirForProjectRoot(projectRoot);
  fs.mkdirSync(vaultDir, { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function writeMarker(input: {
  projectId: string;
  projectName: string;
  groveId: string;
  groveSlug: string;
  bindingId: string;
}): void {
  const markerDir = path.dirname(activationMarkerPath(vaultDir));
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(activationMarkerPath(vaultDir), JSON.stringify({
    status: 'activated',
    migration_id: 'mig_test',
    project_root: projectRoot,
    project_id: input.projectId,
    project_name: input.projectName,
    grove_id: input.groveId,
    grove_slug: input.groveSlug,
    grove_binding_id: input.bindingId,
    source_db_path: path.join(vaultDir, 'myco.db'),
    target_db_path: path.join(tmpHome, 'groves', input.groveId, 'myco.db'),
    activated_at: '2026-05-09T18:14:29.065Z',
    import_result: {},
    validation: { target_counts: {}, journal_mappings: 0, journal_errors: 0, embedded_rows_pending: {}, integrity_check: 'ok' },
  }, null, 2));
}

function writeProjectToml(projectId: string, name: string, slug: string, bindingId: string): void {
  fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify({
    project: { id: projectId, name },
    grove: { mode: 'local', slug, binding_id: bindingId },
  }));
}

describe('resolveProjectGroveBinding', () => {
  it('returns "legacy" for a pre-Grove vault (no manifest, no marker)', () => {
    const result = resolveProjectGroveBinding(vaultDir);
    expect(result.kind).toBe('legacy');
  });

  it('returns "grove" when manifest, marker, and registry all align', () => {
    const grove = createGrove('Work', tmpHome);
    const projectId = 'proj_a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const bindingId = 'gbind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeProjectToml(projectId, 'unifi', grove.slug, bindingId);
    writeMarker({ projectId, projectName: 'unifi', groveId: grove.id, groveSlug: grove.slug, bindingId });
    registerProjectInGrove(grove.id, { projectId, projectName: 'unifi', projectRoot, bindingId }, tmpHome);

    const result = resolveProjectGroveBinding(vaultDir);
    expect(result.kind).toBe('grove');
    if (result.kind === 'grove') {
      expect(result.manifest.project.id).toBe(projectId);
      expect(result.marker.grove_id).toBe(grove.id);
      expect(result.registered.grove.id).toBe(grove.id);
    }
  });

  it('returns "inconsistent" when manifest binding is present but marker is missing (partial init)', () => {
    writeProjectToml('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x', 'default', 'gbind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const result = resolveProjectGroveBinding(vaultDir);
    expect(result.kind).toBe('inconsistent');
    if (result.kind === 'inconsistent') {
      expect(result.details.hasManifest).toBe(true);
      expect(result.details.hasMarker).toBe(false);
      expect(result.details.reason).toContain('activation marker');
    }
  });

  it('returns "inconsistent" when marker is present but manifest is missing (bug B)', () => {
    const grove = createGrove('Work', tmpHome);
    const projectId = 'proj_a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const bindingId = 'gbind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeMarker({ projectId, projectName: 'unifi', groveId: grove.id, groveSlug: grove.slug, bindingId });
    registerProjectInGrove(grove.id, { projectId, projectName: 'unifi', projectRoot, bindingId }, tmpHome);

    const result = resolveProjectGroveBinding(vaultDir);
    expect(result.kind).toBe('inconsistent');
    if (result.kind === 'inconsistent') {
      expect(result.details.hasManifest).toBe(false);
      expect(result.details.hasMarker).toBe(true);
      expect(result.details.hasRegistryRow).toBe(true);
      expect(result.details.reason).toContain('project.toml');
    }
  });

  it('repairs missing project.toml from the marker when repair: true', () => {
    const grove = createGrove('Work', tmpHome);
    const projectId = 'proj_a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const bindingId = 'gbind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeMarker({ projectId, projectName: 'unifi', groveId: grove.id, groveSlug: grove.slug, bindingId });
    registerProjectInGrove(grove.id, { projectId, projectName: 'unifi', projectRoot, bindingId }, tmpHome);

    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(false);

    const result = resolveProjectGroveBinding(vaultDir, { repair: true });
    expect(result.kind).toBe('grove');
    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(true);
  });

  it('repairs missing registry row from the marker when repair: true', () => {
    const grove = createGrove('Work', tmpHome);
    const projectId = 'proj_a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const bindingId = 'gbind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeProjectToml(projectId, 'unifi', grove.slug, bindingId);
    writeMarker({ projectId, projectName: 'unifi', groveId: grove.id, groveSlug: grove.slug, bindingId });
    // Note: NOT calling registerProjectInGrove — this simulates a missing registry row.

    const before = resolveProjectGroveBinding(vaultDir);
    expect(before.kind).toBe('inconsistent');

    const after = resolveProjectGroveBinding(vaultDir, { repair: true });
    expect(after.kind).toBe('grove');
  });

  it('returns "inconsistent" when project_id disagrees between manifest and marker', () => {
    const grove = createGrove('Work', tmpHome);
    const bindingId = 'gbind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeProjectToml('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x', grove.slug, bindingId);
    writeMarker({
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      projectName: 'y',
      groveId: grove.id,
      groveSlug: grove.slug,
      bindingId,
    });
    registerProjectInGrove(grove.id, { projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', projectName: 'x', projectRoot, bindingId }, tmpHome);

    const result = resolveProjectGroveBinding(vaultDir);
    expect(result.kind).toBe('inconsistent');
    if (result.kind === 'inconsistent') {
      expect(result.details.reason).toContain('disagree');
    }
  });
});
