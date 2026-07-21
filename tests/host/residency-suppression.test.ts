/**
 * Residency suppression (Phase F) — the load-bearing "divert, never drop"
 * invariant. While a transition is in flight, hook capture must resolve to the
 * journal's destination tenancy (so a mid-window event lands in the right
 * buffer and ships post-flip), and the binding-repair re-register must be
 * suppressed (so the parked local row is not re-minted).
 *
 * Hermetic: per-test MYCO_HOME (Grove registry) + MYCO_TEAM_HOME (journal).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';

import { clearProjectManifestCache, saveProjectManifest } from '@myco/config/project-manifest.js';
import { activationMarkerPath, type ActivationMarker } from '@myco/grove/activation.js';
import { createGroveBindingId, createGroveId, createProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir, resolveProjectBufferDir } from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  ensureProjectRegistered,
  listGroves,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { findRegisteredProjectById } from '@myco/grove/registry-resolve.js';
import { resolveProjectGroveBinding } from '@myco/grove/binding.js';
import { resolveProjectBufferDirFromRoot } from '@myco/capture/buffer-location.js';
import { startResidencyJournal } from '@myco/host/residency-journal.js';

let home: string;
let teamHome: string;
let savedTeamHome: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-supp-home-'));
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-supp-team-'));
  savedTeamHome = process.env.MYCO_TEAM_HOME;
  savedHome = process.env.MYCO_HOME;
  process.env.MYCO_TEAM_HOME = teamHome;
  process.env.MYCO_HOME = home;
  clearGroveRegistryCaches();
  clearProjectManifestCache();
});

afterEach(() => {
  if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
  else process.env.MYCO_TEAM_HOME = savedTeamHome;
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(teamHome, { recursive: true, force: true });
  clearGroveRegistryCaches();
  clearProjectManifestCache();
});

/** A checkout whose committed manifest names `projectId` (the divert key). */
function makeCheckout(projectId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-supp-proj-'));
  const vaultDir = resolveProjectVaultDir(root);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify({ project: { id: projectId, name: 'demo' } }), 'utf-8');
  clearProjectManifestCache();
  return root;
}

describe('residency suppression — ensureProjectRegistered diverts', () => {
  test('with a live journal, ensureProjectRegistered returns the divert tenancy and mints NO local Grove row', () => {
    const source = createGrove('Source', home);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(source.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    clearGroveRegistryCaches();

    // Before any journal: resolves to the local source Grove.
    expect(ensureProjectRegistered(root, home)?.grove.id).toBe(source.id);

    const divertGroveId = createGroveId(); // the host's served Grove — never a local Grove here
    startResidencyJournal({
      direction: 'attach',
      phase: 'parking',
      host_id: 'host_x',
      project_id: projectId,
      divert_grove_id: divertGroveId,
      source_grove_id: source.id,
      project_name: 'demo',
      root,
      backup_ref: null,
      cursors: {},
    });

    const resolved = ensureProjectRegistered(root, home);
    expect(resolved?.grove.id).toBe(divertGroveId);
    expect(resolved?.project.project_id).toBe(projectId);

    // The divert Grove was never materialized as a local Grove.
    expect(listGroves(home).map((g) => g.id)).not.toContain(divertGroveId);
  });

  test('the capture buffer dir resolves under the divert Grove during the window (a mid-window hook fire is not lost)', () => {
    const source = createGrove('Source', home);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(source.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    clearGroveRegistryCaches();

    const divertGroveId = createGroveId();
    startResidencyJournal({
      direction: 'attach',
      phase: 'parking',
      host_id: 'host_x',
      project_id: projectId,
      divert_grove_id: divertGroveId,
      source_grove_id: source.id,
      project_name: 'demo',
      root,
      backup_ref: null,
      cursors: {},
    });

    const location = resolveProjectBufferDirFromRoot(root, home);
    expect(location?.groveId).toBe(divertGroveId);
    expect(location?.projectId).toBe(projectId);
    expect(location?.bufferDir).toBe(resolveProjectBufferDir(divertGroveId, projectId, home));
  });
});

describe('residency suppression — binding repair', () => {
  /** Bind a checkout to `grove` (manifest + activation marker) but leave the
   *  registry row missing — the exact parked shape the drain leaves mid-move. */
  function makeParkedBinding(grove: { id: string; slug: string }): { vaultDir: string; projectId: string; bindingId: string } {
    const projectId = createProjectId();
    const bindingId = createGroveBindingId();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-supp-bind-'));
    const vaultDir = resolveProjectVaultDir(root);
    fs.mkdirSync(vaultDir, { recursive: true });
    saveProjectManifest(vaultDir, {
      project: { id: projectId, name: 'demo' },
      grove: { id: grove.id, slug: grove.slug, binding_id: bindingId, mode: 'local' },
    });
    const marker: Partial<ActivationMarker> = {
      status: 'activated',
      migration_id: 'mig_x',
      project_root: root,
      project_id: projectId,
      project_name: 'demo',
      grove_id: grove.id,
      grove_slug: grove.slug,
      grove_binding_id: bindingId,
    };
    fs.mkdirSync(path.dirname(activationMarkerPath(vaultDir)), { recursive: true });
    fs.writeFileSync(activationMarkerPath(vaultDir), JSON.stringify(marker), 'utf-8');
    clearProjectManifestCache();
    return { vaultDir, projectId, bindingId };
  }

  test('with NO journal, repair re-registers the missing row (control)', () => {
    const grove = createGrove('Source', home);
    const { vaultDir, projectId } = makeParkedBinding(grove);
    expect(findRegisteredProjectById(projectId, home)).toBeNull();

    resolveProjectGroveBinding(vaultDir, { repair: true, mycoHome: home });

    expect(findRegisteredProjectById(projectId, home)).not.toBeNull();
  });

  test('with a live journal, repair does NOT re-register (the parked row stays parked)', () => {
    const grove = createGrove('Source', home);
    const { vaultDir, projectId } = makeParkedBinding(grove);
    startResidencyJournal({
      direction: 'attach',
      phase: 'pushing',
      host_id: 'host_x',
      project_id: projectId,
      divert_grove_id: createGroveId(),
      source_grove_id: grove.id,
      project_name: 'demo',
      root: path.dirname(vaultDir),
      backup_ref: '/b.sql',
      cursors: {},
    });

    resolveProjectGroveBinding(vaultDir, { repair: true, mycoHome: home });

    expect(findRegisteredProjectById(projectId, home)).toBeNull();
  });
});
