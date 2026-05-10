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
  let previousHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-groves-crud-'));
    mycoHome = path.join(testDir, 'home');
    previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    fs.mkdirSync(mycoHome, { recursive: true });
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
      const response = await call(createCreateGroveHandler(), { body: { name: 'Client Work' } });
      expect(response.status).toBe(201);
      const body = response.body as { id: string; name: string; slug: string; mode: string };
      expect(body.name).toBe('Client Work');
      expect(body.slug).toBe('client-work');
      expect(body.mode).toBe('local');
      expect(loadGroveRecord(body.id)).not.toBeNull();
    });

    it('rejects missing name with 400 name_required', async () => {
      const response = await call(createCreateGroveHandler(), { body: {} });
      expect(response.status).toBe(400);
      const body = response.body as { error: { code: string } };
      expect(body.error.code).toBe('name_required');
    });

    it('rejects empty/whitespace name with 400 name_required', async () => {
      const response = await call(createCreateGroveHandler(), { body: { name: '   ' } });
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('name_required');
    });

    it('returns 500 on duplicate name (slug collision)', async () => {
      createGrove('Duplicate');
      const response = await call(createCreateGroveHandler(), { body: { name: 'Duplicate' } });
      expect(response.status).toBe(500);
      expect((response.body as { error: { code: string } }).error.code).toBe('create_failed');
    });
  });

  describe('PATCH /api/groves/:id', () => {
    it('renames a Grove and returns the updated record', async () => {
      const grove = createGrove('Original');
      const response = await call(createRenameGroveHandler(), {
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
      const response = await call(createRenameGroveHandler(), {
        body: {},
        params: { id: grove.id },
      });
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('name_required');
    });

    it('returns 404 for unknown Grove id', async () => {
      const response = await call(createRenameGroveHandler(), {
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
      const response = await call(createDeleteGroveHandler(), { params: { id: grove.id } });
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
      const response = await call(createDeleteGroveHandler(), { params: { id: grove.id } });
      expect(response.status).toBe(409);
      const body = response.body as { error: { code: string }; project_count: number };
      expect(body.error.code).toBe('grove_not_empty');
      expect(body.project_count).toBe(1);
      expect(loadGroveRecord(grove.id)).not.toBeNull();
    });

    it('returns 404 for unknown Grove id', async () => {
      const response = await call(createDeleteGroveHandler(), {
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

      const response = await call(createMoveProjectHandler(), {
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
      const response = await call(createMoveProjectHandler(), {
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
      const response = await call(createMoveProjectHandler(), {
        params: { id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', projectId },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('target_grove_not_found');
    });

    it('returns 404 when project is not registered anywhere', async () => {
      const target = createGrove('Target');
      const response = await call(createMoveProjectHandler(), {
        params: { id: target.id, projectId: createProjectId() },
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('project_not_found');
    });
  });
});
