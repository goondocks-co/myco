import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  createCreateGroveHandler,
  createDeleteGroveHandler,
  createMoveProjectHandler,
  createRenameGroveHandler,
  createSetDefaultGroveHandler,
  listGroveSummaries,
} from '@myco/daemon/api/groves.js';
import { createProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
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

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-groves-crud-'));
    mycoHome = path.join(testDir, 'home');
    previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
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
