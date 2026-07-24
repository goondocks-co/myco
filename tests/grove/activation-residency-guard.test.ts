/**
 * Activation never-materialize gate, residency arm (Phase F T6 / F-12 vector).
 * `myco init`/activation already refuses a SETTLED attached project; this pins
 * the parking-window arm — a residency transition in flight (no attach ref yet)
 * must also refuse, so activation can't re-mint a local Grove row mid-move.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';

import { createProjectId, createGroveId, createHostId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { clearProjectManifestCache } from '@myco/config/project-manifest.js';
import { clearGroveRegistryCaches } from '@myco/grove/registry.js';
import {
  activateProjectMigration as activateProjectMigrationWithDefaults,
} from '@myco/grove/activation.js';
import { startResidencyJournal } from '@myco/host/residency-journal.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const activateProjectMigration = (
  input: Parameters<typeof activateProjectMigrationWithDefaults>[0],
) => activateProjectMigrationWithDefaults({
  ...input,
  lockNamespace: testPerUserLockNamespace,
});

let home: string;
let teamHome: string;
let projectRoot: string;
let savedHome: string | undefined;
let savedTeamHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-act-guard-home-'));
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-act-guard-team-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-act-guard-proj-'));
  savedHome = process.env.MYCO_HOME;
  savedTeamHome = process.env.MYCO_TEAM_HOME;
  process.env.MYCO_HOME = home;
  process.env.MYCO_TEAM_HOME = teamHome;
  clearGroveRegistryCaches();
  clearProjectManifestCache();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
  if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(teamHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  clearGroveRegistryCaches();
  clearProjectManifestCache();
});

describe('activation residency-transition gate', () => {
  test('refuses to activate a local Grove migration while a residency transition is in flight', () => {
    const projectId = createProjectId();
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify({ project: { id: projectId, name: 'demo' } }), 'utf-8');
    clearProjectManifestCache();

    // A transition in flight — no attach ref yet (parking window), so the
    // existing attach refusal wouldn't catch it.
    startResidencyJournal({
      direction: 'attach', phase: 'parking', host_id: createHostId(), project_id: projectId,
      divert_grove_id: createGroveId(), source_grove_id: createGroveId(), project_name: 'demo',
      root: projectRoot, backup_ref: null, cursors: {},
    });

    expect(() => activateProjectMigration({ projectRoot, mycoHome: home }))
      .toThrow(/residency transition in flight/);
  });
});
