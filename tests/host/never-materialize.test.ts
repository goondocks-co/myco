/**
 * Team Host — the never-materialize invariant (Task 1.0).
 *
 * An attached project is served by a remote host; NO local Grove state may
 * ever exist for it on a member machine. This test drives all four paths that
 * could otherwise materialize a local Grove for an attached project and proves
 * each one writes ZERO local Grove state (no registry row, no `groves/<id>/`
 * dir, no roots entry, no DB), while a NON-attached project keeps behaving
 * byte-identically to today.
 *
 * Hermetic isolation mirrors `packages/myco/src/host/registry.test.ts`: a
 * per-test tmpdir for MYCO_HOME plus a `MYCO_TEAM_HOME` env override for the
 * machine-global host registry, so the real `~/.myco*` is never touched. The
 * `sandbox-preload` fence backstops this.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';

import { DaemonLogger } from '@myco/daemon/logger.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { forEachGrove, forEachRegisteredProject } from '@myco/daemon/scope-iteration.js';
import { resolveProjectBufferDirFromRoot } from '@myco/capture/buffer-location.js';
import { activateProjectMigration } from '@myco/grove/activation.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import {
  resolveGroveDbPath,
  resolveGroveDir,
  resolveProjectBufferDir,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  ensureDefaultGrove,
  ensureGroveExistsLocally,
  ensureProjectRegistered,
  findProjectByRoot,
  listGroves,
  listRegisteredProjects,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import {
  createHostRegistryOperations,
  ProjectRegisteredLocallyError,
  type HostRecord,
} from '@myco/host/registry.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const {
  attachProject,
  getHost,
  resolveAttach,
} = createHostRegistryOperations(testPerUserLockNamespace);

let home: string;
let teamHome: string;
let savedTeamHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-nevermat-home-'));
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-nevermat-team-'));
  savedTeamHome = process.env.MYCO_TEAM_HOME;
  process.env.MYCO_TEAM_HOME = teamHome;
  clearGroveRegistryCaches();
});

afterEach(() => {
  if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
  else process.env.MYCO_TEAM_HOME = savedTeamHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(teamHome, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

function makeLogger(): DaemonLogger {
  return new DaemonLogger(path.join(home, 'logs'), { level: 'error' });
}

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 1,
    created_at: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

/** A real git checkout dir (so `isSafeProjectRoot`'s git probe passes) with an
 *  optional committed `.myco/project.toml` carrying `project.id`. */
function makeCheckout(projectId?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-nevermat-proj-'));
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  if (projectId) {
    const vaultDir = resolveProjectVaultDir(root);
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      stringify({ project: { id: projectId, name: 'demo' } }),
      'utf-8',
    );
  }
  return root;
}

/** Attach `projectId` to a fresh host serving `groveId`, and return the host. */
function attach(groveId: string, projectId: string): HostRecord {
  const host = makeHost();
  writeHostRecordFixture(host);
  attachProject(host.host_id, { grove_id: groveId, project_id: projectId }, home);
  return host;
}

/** A safe (non-home) absolute project root; need not exist on disk. */
function fakeRoot(tag: string): string {
  return path.join(os.tmpdir(), `nevermat-${tag}`);
}

/**
 * Assert that not a shred of local Grove state exists for the attached
 * project: no registry row anywhere, no `groves/<attachGroveId>/` dir, no
 * roots entry pointing at the checkout, no Grove DB file.
 */
function expectNoLocalMaterialization(input: {
  attachGroveId: string;
  attachProjectId: string;
  projectRoot: string;
}): void {
  // No registry row keyed on the project's root or id, in any local Grove.
  expect(findProjectByRoot(input.projectRoot, home)).toBeNull();
  for (const grove of listGroves(home)) {
    const ids = listRegisteredProjects(grove.id, home, { includeArchived: true })
      .map((p) => p.project_id);
    expect(ids).not.toContain(input.attachProjectId);
  }
  // No hosted-Grove dir, DB, or registry files ever materialized locally.
  expect(fs.existsSync(resolveGroveDir(input.attachGroveId, home))).toBe(false);
  expect(fs.existsSync(resolveGroveDbPath(input.attachGroveId, home))).toBe(false);
}

describe('Team Host never-materialize invariant', () => {
  describe('attached project → zero local Grove materialization', () => {
    it('ensureProjectRegistered returns the attach tenancy without registering locally', () => {
      // A member machine that also has a local default Grove — the very thing
      // an attached project must NOT be registered into.
      const defaultGrove = ensureDefaultGrove(home);
      const attachGroveId = createGroveId();
      const attachProjectId = createProjectId();
      const projectRoot = makeCheckout(attachProjectId);
      attach(attachGroveId, attachProjectId);

      const resolved = ensureProjectRegistered(projectRoot, home, testPerUserLockNamespace);

      // Tenancy comes straight from the attach ref — not a locally-minted row.
      expect(resolved).not.toBeNull();
      expect(resolved!.grove.id).toBe(attachGroveId);
      expect(resolved!.project.project_id).toBe(attachProjectId);

      // The local default Grove was never written to.
      expect(listRegisteredProjects(defaultGrove.id, home, { includeArchived: true })).toEqual([]);
      expectNoLocalMaterialization({ attachGroveId, attachProjectId, projectRoot });

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('resolveProjectBufferDirFromRoot resolves the DB-free attach buffer dir without registering', () => {
      const defaultGrove = ensureDefaultGrove(home);
      const attachGroveId = createGroveId();
      const attachProjectId = createProjectId();
      const projectRoot = makeCheckout(attachProjectId);
      attach(attachGroveId, attachProjectId);

      const location = resolveProjectBufferDirFromRoot(
        projectRoot,
        home,
        testPerUserLockNamespace,
      );

      expect(location).not.toBeNull();
      expect(location!.groveId).toBe(attachGroveId);
      expect(location!.projectId).toBe(attachProjectId);
      // The buffer dir is keyed on the attach ref's ids via the DB-free
      // resolver — the path is computed but nothing is materialized.
      expect(location!.bufferDir).toBe(resolveProjectBufferDir(attachGroveId, attachProjectId, home));

      expect(listRegisteredProjects(defaultGrove.id, home, { includeArchived: true })).toEqual([]);
      expectNoLocalMaterialization({ attachGroveId, attachProjectId, projectRoot });

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('forEachGrove skips a leaked local Grove whose id is an attach target', async () => {
      // A local default Grove that MUST be visited.
      const defaultGrove = createGrove('Default', home);
      ensureGroveDatabase(defaultGrove.id, home);

      // Simulate local state having leaked for a hosted Grove: a local Grove
      // dir whose id matches an attach target. Defense-in-depth must skip it.
      const attachGroveId = createGroveId();
      const attachProjectId = createProjectId();
      const leaked = ensureGroveExistsLocally(
        attachGroveId,
        { name: 'Leaked Hosted', slug: 'leaked-hosted' },
        home,
      );
      ensureGroveDatabase(leaked.id, home);
      attach(attachGroveId, attachProjectId);

      const cache = new GroveRuntimeCache();
      const visited: string[] = [];
      const summary = await forEachGrove(
        cache,
        makeLogger(),
        ({ grove }) => { visited.push(grove.id); },
        { mycoHome: home, lockNamespace: testPerUserLockNamespace },
      );
      cache.closeAll();

      expect(visited).toContain(defaultGrove.id);
      expect(visited).not.toContain(attachGroveId);
      expect(summary.attempted).toBe(1);
      expect(summary.skipped).toBe(1);
    });

    it('activateProjectMigration refuses an attached project, naming the host', () => {
      const defaultGrove = ensureDefaultGrove(home);
      const attachGroveId = createGroveId();
      const attachProjectId = createProjectId();
      const projectRoot = makeCheckout(attachProjectId);
      const host = attach(attachGroveId, attachProjectId);

      expect(() => activateProjectMigration({
        projectRoot,
        mycoHome: home,
        lockNamespace: testPerUserLockNamespace,
      }))
        .toThrow(new RegExp(`served by host ${host.label}`));

      expect(listRegisteredProjects(defaultGrove.id, home, { includeArchived: true })).toEqual([]);
      expectNoLocalMaterialization({ attachGroveId, attachProjectId, projectRoot });

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });
  });

  describe('no attach record → behavior is byte-identical to today', () => {
    it('ensureProjectRegistered registers the project into the local default Grove', () => {
      const defaultGrove = ensureDefaultGrove(home);
      const projectRoot = makeCheckout();

      const resolved = ensureProjectRegistered(projectRoot, home, testPerUserLockNamespace);

      expect(resolved).not.toBeNull();
      expect(resolved!.grove.id).toBe(defaultGrove.id);
      const rows = listRegisteredProjects(defaultGrove.id, home);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.root).toBe(path.resolve(projectRoot));
      expect(findProjectByRoot(projectRoot, home)?.grove.id).toBe(defaultGrove.id);

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('resolveProjectBufferDirFromRoot resolves the local Grove buffer dir and registers', () => {
      const defaultGrove = ensureDefaultGrove(home);
      const projectRoot = makeCheckout();

      const location = resolveProjectBufferDirFromRoot(
        projectRoot,
        home,
        testPerUserLockNamespace,
      );

      expect(location).not.toBeNull();
      expect(location!.groveId).toBe(defaultGrove.id);
      const registered = findProjectByRoot(projectRoot, home);
      expect(registered).not.toBeNull();
      expect(location!.projectId).toBe(registered!.project.project_id);
      expect(location!.bufferDir).toBe(
        resolveProjectBufferDir(defaultGrove.id, registered!.project.project_id, home),
      );

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('forEachGrove visits every local Grove with nothing skipped', async () => {
      const a = createGrove('Alpha', home);
      ensureGroveDatabase(a.id, home);
      const b = createGrove('Bravo', home);
      ensureGroveDatabase(b.id, home);

      const cache = new GroveRuntimeCache();
      const visited: string[] = [];
      const summary = await forEachGrove(
        cache,
        makeLogger(),
        ({ grove }) => { visited.push(grove.id); },
        { mycoHome: home, lockNamespace: testPerUserLockNamespace },
      );
      cache.closeAll();

      expect(visited.sort()).toEqual([a.id, b.id].sort());
      expect(summary.attempted).toBe(2);
      expect(summary.skipped).toBe(0);
    });

    it('activateProjectMigration passes the attach gate (fails later on the missing legacy DB)', () => {
      ensureDefaultGrove(home);
      const projectRoot = makeCheckout(createProjectId());

      // Not attached → the gate is transparent; activation proceeds until it
      // hits the real first-run precondition (no legacy source DB present).
      expect(() => activateProjectMigration({
        projectRoot,
        mycoHome: home,
        lockNamespace: testPerUserLockNamespace,
      }))
        .toThrow(/Legacy project database not found/);

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });
  });

  describe('local→attached transition (the stale-local-row leak shape)', () => {
    it('forEachRegisteredProject skips an attach-target project whose stale row sits in the local default Grove', async () => {
      const defaultGrove = createGrove('Default', home);
      ensureGroveDatabase(defaultGrove.id, home);

      const attachGroveId = createGroveId();       // the host's Grove — never local
      const attachedProjectId = createProjectId(); // registered locally AND attached
      const siblingProjectId = createProjectId();  // local-only neighbour that must still run

      registerProjectInGrove(defaultGrove.id, {
        projectId: attachedProjectId,
        projectName: 'attached',
        projectRoot: fakeRoot(`attached-${attachedProjectId}`),
      }, home);
      registerProjectInGrove(defaultGrove.id, {
        projectId: siblingProjectId,
        projectName: 'sibling',
        projectRoot: fakeRoot(`sibling-${siblingProjectId}`),
      }, home);

      // Seed the attach ref directly. attachProject refuses
      // exactly this creation (the local-row guard below), so we reproduce the
      // residual state that guard prevents to prove scope iteration also
      // refuses it — the stale row lives in the DEFAULT Grove (G_local), not
      // the attach-target Grove (G_host), so only the project-level filter
      // catches it; the grove-level skip does not.
      writeHostRecordFixture({ ...makeHost(), projects: [{ grove_id: attachGroveId, project_id: attachedProjectId }] });

      const cache = new GroveRuntimeCache();
      const visited: string[] = [];
      const summary = await forEachRegisteredProject(
        cache,
        makeLogger(),
        ({ projectId }) => { visited.push(projectId); },
        {
          mycoHome: home,
          machineId: 'machine-test',
          lockNamespace: testPerUserLockNamespace,
        },
      );
      cache.closeAll();

      expect(visited).toEqual([siblingProjectId]);
      expect(summary.attempted).toBe(1);
    });

    it('attachProject refuses to create an attach record while a local Grove row exists, writing nothing', () => {
      const defaultGrove = createGrove('Default', home);
      const projectId = createProjectId();
      registerProjectInGrove(defaultGrove.id, {
        projectId,
        projectName: 'local',
        projectRoot: fakeRoot(`localrow-${projectId}`),
      }, home);

      const host = makeHost();
      writeHostRecordFixture(host);

      expect(() => attachProject(host.host_id, { grove_id: createGroveId(), project_id: projectId }, home))
        .toThrow(ProjectRegisteredLocallyError);

      // The guard wrote nothing: no attach record exists for the project.
      expect(resolveAttach(projectId)).toBeNull();
      expect(getHost(host.host_id)?.projects).toEqual([]);
    });
  });
});
