import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { updateGroveConfig } from '@myco/config/loader.js';
import {
  createArchiveProjectHandler,
  createCreateGroveHandler,
  createDeleteGroveHandler,
  createDeleteProjectHandler,
  createMoveProjectHandler,
  createRenameGroveHandler,
  createSetDefaultGroveHandler,
  createUnarchiveProjectHandler,
  listGroveSummaries,
} from '@myco/daemon/api/groves.js';
import { initTeamContext, resetTeamContext } from '@myco/team/context.js';
import { createProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveGroveDir, resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  listGroves,
  listRegisteredProjects,
  loadGroveRecord,
  registerProjectInGrove,
} from '@myco/grove/registry.js';

describe('Grove CRUD API', () => {
  let testDir: string;
  let mycoHome: string;
  let serviceDir: string;
  let serviceDevDir: string;
  let previousHome: string | undefined;
  let previousBackupsDir: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-groves-crud-'));
    mycoHome = path.join(testDir, 'home');
    previousHome = process.env.MYCO_HOME;
    previousBackupsDir = process.env.MYCO_BACKUPS_DIR;
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_BACKUPS_DIR = path.join(testDir, 'backups');
    fs.mkdirSync(mycoHome, { recursive: true });
    serviceDir = path.join(mycoHome, 'service');
    serviceDevDir = path.join(mycoHome, 'service-dev');
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.mkdirSync(serviceDevDir, { recursive: true });
    clearGroveRegistryCaches();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    if (previousBackupsDir === undefined) delete process.env.MYCO_BACKUPS_DIR;
    else process.env.MYCO_BACKUPS_DIR = previousBackupsDir;
    resetTeamContext();
    fs.rmSync(testDir, { recursive: true, force: true });
    clearGroveRegistryCaches();
  });

  function call(handler: ReturnType<typeof createCreateGroveHandler>, init: {
    body?: unknown;
    params?: Record<string, string>;
  }): Promise<{ status?: number; body: unknown }> {
    return handler({
      body: init.body,
      query: {},
      params: init.params ?? {},
      pathname: '',
    });
  }

  describe('POST /api/groves', () => {
    it('creates a Grove with 201 + serialized record', async () => {
      const response = await call(createCreateGroveHandler(serviceDir), { body: { name: 'Client Work' } });
      expect(response.status).toBe(201);
      const body = response.body as { id: string; name: string; slug: string; mode: string };
      expect(body.name).toBe('Client Work');
      expect(body.slug).toBe('client-work');
      expect(body.mode).toBe('local');
      expect(loadGroveRecord(body.id)).not.toBeNull();
    });

    it('rejects missing name with 400 name_required', async () => {
      const response = await call(createCreateGroveHandler(serviceDir), { body: {} });
      expect(response.status).toBe(400);
      const body = response.body as { error: { code: string } };
      expect(body.error.code).toBe('name_required');
    });

    it('rejects empty/whitespace name with 400 name_required', async () => {
      const response = await call(createCreateGroveHandler(serviceDir), { body: { name: '   ' } });
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('name_required');
    });

    it('returns 500 on duplicate name (slug collision)', async () => {
      createGrove('Duplicate');
      const response = await call(createCreateGroveHandler(serviceDir), { body: { name: 'Duplicate' } });
      expect(response.status).toBe(500);
      expect((response.body as { error: { code: string } }).error.code).toBe('create_failed');
    });
  });

  describe('PATCH /api/groves/:id', () => {
    it('renames a Grove and returns the updated record', async () => {
      const grove = createGrove('Original');
      const response = await call(createRenameGroveHandler(serviceDir), {
        body: { name: 'Renamed' },
        params: { id: grove.id },
      });
      expect(response.status).toBeUndefined();
      const body = response.body as { id: string; name: string; slug: string };
      expect(body.id).toBe(grove.id);
      expect(body.name).toBe('Renamed');
      expect(body.slug).toBe('renamed');
    });

    it('returns 400 when name is missing', async () => {
      const grove = createGrove('Original');
      const response = await call(createRenameGroveHandler(serviceDir), {
        body: {},
        params: { id: grove.id },
      });
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('name_required');
    });

    it('returns 404 for unknown Grove id', async () => {
      const response = await call(createRenameGroveHandler(serviceDir), {
        body: { name: 'Whatever' },
        params: { id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('grove_not_found');
    });
  });

  describe('DELETE /api/groves/:id', () => {
    it('deletes an empty Grove and returns 204', async () => {
      const grove = createGrove('Disposable');
      const response = await call(createDeleteGroveHandler(serviceDir), { params: { id: grove.id } });
      expect(response.status).toBe(204);
      expect(loadGroveRecord(grove.id)).toBeNull();
    });

    it('returns 409 grove_not_empty when projects remain', async () => {
      const grove = createGrove('Busy');
      const projectId = createProjectId();
      registerProjectInGrove(grove.id, {
        projectId,
        projectName: 'Held',
        projectRoot: path.join(testDir, 'held'),
      });
      const response = await call(createDeleteGroveHandler(serviceDir), { params: { id: grove.id } });
      expect(response.status).toBe(409);
      const body = response.body as { error: { code: string }; project_count: number };
      expect(body.error.code).toBe('grove_not_empty');
      expect(body.project_count).toBe(1);
      expect(loadGroveRecord(grove.id)).not.toBeNull();
    });

    it('returns 409 when only archived projects remain', async () => {
      const grove = createGrove('Archived Busy');
      const projectId = createProjectId();
      registerProjectInGrove(grove.id, {
        projectId,
        projectName: 'Archived',
        projectRoot: path.join(testDir, 'archived'),
      });
      await call(createArchiveProjectHandler(serviceDir), {
        params: { id: grove.id, projectId },
      });

      const response = await call(createDeleteGroveHandler(serviceDir), { params: { id: grove.id } });

      expect(response.status).toBe(409);
      expect((response.body as { error: { code: string }; project_count: number }).project_count).toBe(1);
      expect(loadGroveRecord(grove.id)).not.toBeNull();
    });

    it('returns 404 for unknown Grove id', async () => {
      const response = await call(createDeleteGroveHandler(serviceDir), {
        params: { id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('grove_not_found');
    });
  });

  describe('POST /api/groves/:id/projects/:projectId (move)', () => {
    function ensureGroveDb(groveId: string): void {
      const dbPath = resolveGroveDbPath(groveId, mycoHome);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = openDatabase(dbPath);
      try {
        createSchema(db);
      } finally {
        db.close();
      }
    }

    it('moves a registered project between Groves and returns ok + result', async () => {
      const source = createGrove('Source');
      const target = createGrove('Target');
      ensureGroveDb(source.id);
      ensureGroveDb(target.id);

      const projectId = createProjectId();
      const projectRoot = path.join(testDir, 'project');
      fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
      registerProjectInGrove(source.id, {
        projectId,
        projectName: 'Demo',
        projectRoot,
        bindingId: 'gbind_initial',
      });

      const response = await call(createMoveProjectHandler(serviceDir), {
        params: { id: target.id, projectId },
      });
      expect(response.status).toBeUndefined();
      const body = response.body as {
        ok: boolean;
        move: { from_grove_id: string; to_grove_id: string; project_id: string };
      };
      expect(body.ok).toBe(true);
      expect(body.move.from_grove_id).toBe(source.id);
      expect(body.move.to_grove_id).toBe(target.id);
      expect(body.move.project_id).toBe(projectId);

      expect(listRegisteredProjects(source.id).map((p) => p.project_id)).not.toContain(projectId);
      expect(listRegisteredProjects(target.id).map((p) => p.project_id)).toContain(projectId);
    });

    it('returns 400 when source and target are the same Grove', async () => {
      const grove = createGrove('Solo');
      const projectId = createProjectId();
      const projectRoot = path.join(testDir, 'solo-project');
      fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
      registerProjectInGrove(grove.id, {
        projectId,
        projectName: 'Solo',
        projectRoot,
      });
      const response = await call(createMoveProjectHandler(serviceDir), {
        params: { id: grove.id, projectId },
      });
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('same_grove');
    });

    it('returns 404 when target Grove does not exist', async () => {
      const source = createGrove('Source');
      const projectId = createProjectId();
      const projectRoot = path.join(testDir, 'orphan');
      fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
      registerProjectInGrove(source.id, {
        projectId,
        projectName: 'Orphan',
        projectRoot,
      });
      const response = await call(createMoveProjectHandler(serviceDir), {
        params: { id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', projectId },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('target_grove_not_found');
    });

    it('returns 404 when project is not registered anywhere', async () => {
      const target = createGrove('Target');
      const response = await call(createMoveProjectHandler(serviceDir), {
        params: { id: target.id, projectId: createProjectId() },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('project_not_found');
    });
  });

  describe('project archive/delete lifecycle', () => {
    function ensureGroveDb(groveId: string) {
      const dbPath = resolveGroveDbPath(groveId, mycoHome);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = openDatabase(dbPath);
      try {
        createSchema(db);
        return dbPath;
      } finally {
        db.close();
      }
    }

    it('archives projects, hides them by default, and restores them', async () => {
      const grove = createGrove('Work');
      const projectId = createProjectId();
      registerProjectInGrove(grove.id, {
        projectId,
        projectName: 'Temp',
        projectRoot: path.join(testDir, 'temp'),
      });

      const archive = await call(createArchiveProjectHandler(serviceDir), {
        params: { id: grove.id, projectId },
      });
      expect(archive.status).toBeUndefined();
      expect(listGroveSummaries().groves[0]!.projects).toHaveLength(0);
      expect(listGroveSummaries({ groveIds: null }, undefined, { includeArchived: true }).groves[0]!.projects[0]!.status).toBe('archived');

      const unarchive = await call(createUnarchiveProjectHandler(serviceDir), {
        params: { id: grove.id, projectId },
      });
      expect(unarchive.status).toBeUndefined();
      expect(listGroveSummaries().groves[0]!.projects[0]!.status).toBe('active');
    });

    it('permanently deletes project rows, creates a snapshot, and journals Team Sync delete tombstones via triggers', async () => {
      const grove = createGrove('Work');
      const projectId = createProjectId();
      const siblingProjectId = createProjectId();
      const projectRoot = path.join(testDir, 'temp');
      const siblingRoot = path.join(testDir, 'sibling');
      registerProjectInGrove(grove.id, {
        projectId,
        projectName: 'Temp',
        projectRoot,
      });
      registerProjectInGrove(grove.id, {
        projectId: siblingProjectId,
        projectName: 'Sibling',
        projectRoot: siblingRoot,
      });
      // Enable team sync via Grove config — deleteProjectPermanently reconciles
      // team_sync_state from this config on its own DB handle, so the AFTER
      // DELETE triggers journal regardless of daemon tick timing.
      updateGroveConfig(grove.id, (c) => ({ ...c, team: { ...c.team, enabled: true } }));
      const dbPath = ensureGroveDb(grove.id);
      const db = openDatabase(dbPath);
      try {
        db.prepare(
          `INSERT INTO sessions (id, agent, project_root, project_id, started_at, created_at, machine_id)
           VALUES ('sess-delete', 'codex', ?, ?, 1, 1, 'machine_test')`,
        ).run(projectRoot, projectId);
        db.prepare(
          `INSERT INTO sessions (id, agent, project_root, project_id, started_at, created_at, machine_id)
           VALUES ('sess-sibling', 'codex', ?, ?, 1, 1, 'machine_test')`,
        ).run(siblingRoot, siblingProjectId);
      } finally {
        db.close();
      }
      initTeamContext('machine_test');

      const rejected = await call(createDeleteProjectHandler(serviceDir), {
        params: { id: grove.id, projectId },
        body: { confirmation_name: 'wrong' },
      });
      expect(rejected.status).toBe(400);

      const response = await call(createDeleteProjectHandler(serviceDir), {
        params: { id: grove.id, projectId },
        body: { confirmation_name: 'Temp' },
      });
      expect(response.status).toBeUndefined();
      const body = response.body as { delete: { snapshot_path: string } };
      expect(fs.existsSync(body.delete.snapshot_path)).toBe(true);
      expect(body.delete.snapshot_path.startsWith(path.join(resolveGroveDir(grove.id, mycoHome), 'backups'))).toBe(true);
      const snapshotSql = fs.readFileSync(body.delete.snapshot_path, 'utf-8');
      expect(snapshotSql).toContain('sess-delete');
      expect(snapshotSql).toContain('sess-sibling');
      expect(listRegisteredProjects(grove.id, mycoHome, { includeArchived: true }).map((p) => p.project_id)).toEqual([siblingProjectId]);

      const verifyDb = openDatabase(dbPath);
      try {
        expect((verifyDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(projectId) as { n: number }).n).toBe(0);
        expect((verifyDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(siblingProjectId) as { n: number }).n).toBe(1);
        // The sessions_team_ad trigger journals the delete for the removed
        // project's session only (the sibling's session is untouched). The
        // trigger payload carries id + machine_id (no project_id).
        const outbox = verifyDb.prepare(
          `SELECT table_name, row_id, operation FROM team_outbox`,
        ).all() as Array<{ table_name: string; row_id: string; operation: string }>;
        expect(outbox).toEqual([
          { table_name: 'sessions', row_id: 'sess-delete', operation: 'delete' },
        ]);
      } finally {
        verifyDb.close();
      }
    });

    it('does not journal delete tombstones when Grove config has team.enabled = false', async () => {
      const grove = createGrove('Silent');
      const projectId = createProjectId();
      const projectRoot = path.join(testDir, 'silent-temp');
      registerProjectInGrove(grove.id, {
        projectId,
        projectName: 'Silent',
        projectRoot,
      });
      // Leave team.enabled as default (false) — deleteProjectPermanently must
      // reconcile team_sync_state to disabled, so triggers produce no outbox rows.
      const dbPath = ensureGroveDb(grove.id);
      const db = openDatabase(dbPath);
      try {
        db.prepare(
          `INSERT INTO sessions (id, agent, project_root, project_id, started_at, created_at, machine_id)
           VALUES ('sess-silent', 'codex', ?, ?, 1, 1, 'machine_test')`,
        ).run(projectRoot, projectId);
      } finally {
        db.close();
      }
      initTeamContext('machine_test');

      await call(createDeleteProjectHandler(serviceDir), {
        params: { id: grove.id, projectId },
        body: { confirmation_name: 'Silent' },
      });

      const verifyDb = openDatabase(dbPath);
      try {
        expect((verifyDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(projectId) as { n: number }).n).toBe(0);
        const outbox = verifyDb.prepare(
          `SELECT table_name, row_id, operation FROM team_outbox`,
        ).all() as Array<{ table_name: string; row_id: string; operation: string }>;
        expect(outbox).toEqual([]);
      } finally {
        verifyDb.close();
      }
    });
  });

  describe('served_by boundary enforcement', () => {
    it('POST /api/groves stamps served_by from the calling daemon', async () => {
      const response = await call(createCreateGroveHandler(serviceDir), { body: { name: 'Prod' } });
      expect(response.status).toBe(201);
      const body = response.body as { id: string; served_by: string };
      expect(body.served_by).toBe('service');
      const record = loadGroveRecord(body.id);
      expect(record?.served_by).toBe('service');

      const devResponse = await call(createCreateGroveHandler(serviceDevDir), { body: { name: 'Dogfood' } });
      expect(devResponse.status).toBe(201);
      const devBody = devResponse.body as { id: string; served_by: string };
      expect(devBody.served_by).toBe('service-dev');
      const devRecord = loadGroveRecord(devBody.id);
      expect(devRecord?.served_by).toBe('service-dev');
    });

    it('listGroveSummaries filters out Groves served by another daemon', () => {
      createGrove('Prod');
      createGrove('Dogfood', undefined, { servedBy: 'service-dev' });

      const prodView = listGroveSummaries({ groveIds: null }, 'service');
      expect(prodView.groves.map((g) => g.name).sort()).toEqual(['Prod']);

      const devView = listGroveSummaries({ groveIds: null }, 'service-dev');
      expect(devView.groves.map((g) => g.name).sort()).toEqual(['Dogfood']);
    });

    it('PATCH returns 404 for a Grove served by a different daemon', async () => {
      const dev = createGrove('Dogfood', undefined, { servedBy: 'service-dev' });
      const response = await call(createRenameGroveHandler(serviceDir), {
        body: { name: 'Renamed' },
        params: { id: dev.id },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('grove_not_found');
      // Untouched.
      expect(loadGroveRecord(dev.id)?.name).toBe('Dogfood');
    });

    it('DELETE returns 404 for a Grove served by a different daemon', async () => {
      const dev = createGrove('Dogfood', undefined, { servedBy: 'service-dev' });
      const response = await call(createDeleteGroveHandler(serviceDir), {
        params: { id: dev.id },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('grove_not_found');
      expect(loadGroveRecord(dev.id)).not.toBeNull();
    });

    it('move returns 404 when target Grove is served by a different daemon', async () => {
      const source = createGrove('Source');
      const target = createGrove('DevTarget', undefined, { servedBy: 'service-dev' });
      const projectId = createProjectId();
      const projectRoot = path.join(testDir, 'cross-daemon-project');
      fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
      registerProjectInGrove(source.id, {
        projectId,
        projectName: 'Cross',
        projectRoot,
      });

      const response = await call(createMoveProjectHandler(serviceDir), {
        params: { id: target.id, projectId },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('target_grove_not_found');
    });

    it('move returns 404 when source Grove is served by a different daemon', async () => {
      const devSource = createGrove('DevSource', undefined, { servedBy: 'service-dev' });
      const target = createGrove('Target');
      const projectId = createProjectId();
      const projectRoot = path.join(testDir, 'dev-source-project');
      fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
      registerProjectInGrove(devSource.id, {
        projectId,
        projectName: 'Hidden',
        projectRoot,
      });

      const response = await call(createMoveProjectHandler(serviceDir), {
        params: { id: target.id, projectId },
      });
      // From this daemon's perspective, the project doesn't exist.
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('project_not_found');
    });
  });

  describe('POST /api/groves/:id/default', () => {
    it('sets the default Grove and returns the updated record', async () => {
      const first = createGrove('First');
      const second = createGrove('Second');
      // First Grove auto-promoted to default on creation; flip it.
      const response = await call(createSetDefaultGroveHandler(serviceDir), {
        params: { id: second.id },
      });
      expect(response.status).toBeUndefined();
      const body = response.body as { id: string; name: string; is_default: boolean };
      expect(body.id).toBe(second.id);
      expect(body.is_default).toBe(true);

      const summaries = listGroveSummaries({ groveIds: null }, 'service');
      const defaulted = summaries.groves.find((g) => g.id === second.id);
      const previous = summaries.groves.find((g) => g.id === first.id);
      expect(defaulted?.is_default).toBe(true);
      expect(previous?.is_default).toBe(false);
    });

    it('returns 404 for an unknown Grove id', async () => {
      const response = await call(createSetDefaultGroveHandler(serviceDir), {
        params: { id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('grove_not_found');
    });

    it('returns 404 for a Grove served by a different daemon', async () => {
      const dev = createGrove('Dogfood', undefined, { servedBy: 'service-dev' });
      const response = await call(createSetDefaultGroveHandler(serviceDir), {
        params: { id: dev.id },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('grove_not_found');
    });
  });
});
