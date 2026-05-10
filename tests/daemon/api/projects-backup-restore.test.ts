import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  createProjectBackupHandler,
  createProjectRestoreHandler,
} from '@myco/daemon/api/projects.js';
import { createProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';

let testDir: string;
let mycoHome: string;
let backupsRoot: string;
let previousHome: string | undefined;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-projects-api-'));
  mycoHome = path.join(testDir, 'home');
  backupsRoot = path.join(testDir, 'backups');
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

function ensureGroveSchema(groveId: string): void {
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
  } finally {
    db.close();
  }
}

function seedProjectRow(groveId: string, projectId: string, projectRoot: string): void {
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  const db = openDatabase(dbPath);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('claude-code', 'Claude Code', 'built-in', 1, 100);
    db.prepare(
      `INSERT INTO sessions (
        id, agent, project_root, branch, started_at, status, created_at,
        embedded, machine_id, project_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `sess-${projectId}`,
      'claude-code',
      projectRoot,
      'main',
      200,
      'completed',
      200,
      1,
      'test-machine',
      projectId,
    );
  } finally {
    db.close();
  }
}

function seededProject(): {
  grove: ReturnType<typeof createGrove>;
  projectId: string;
  projectRoot: string;
} {
  const grove = createGrove('Backup Subject');
  ensureGroveSchema(grove.id);
  const projectId = createProjectId();
  const projectRoot = path.join(testDir, 'project');
  fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
  registerProjectInGrove(grove.id, {
    projectId,
    projectName: 'Backup Subject',
    projectRoot,
  });
  seedProjectRow(grove.id, projectId, projectRoot);
  return { grove, projectId, projectRoot };
}

function call(handler: ReturnType<typeof createProjectBackupHandler>, init: {
  body?: unknown;
  params: Record<string, string>;
}): Promise<{ status?: number; body: unknown }> {
  return handler({
    body: init.body,
    query: {},
    params: init.params,
    pathname: '',
  });
}

describe('POST /api/projects/:projectId/backup', () => {
  it('creates a snapshot and returns its path + size', async () => {
    const { projectId, grove } = seededProject();

    const response = await call(
      createProjectBackupHandler({ backupsRoot, mycoHome }),
      { params: { projectId } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as {
      ok: boolean;
      snapshot_path: string;
      size_bytes: number;
      grove_id: string;
      project_id: string;
    };
    expect(body.ok).toBe(true);
    expect(fs.existsSync(body.snapshot_path)).toBe(true);
    expect(body.size_bytes).toBeGreaterThan(0);
    expect(body.grove_id).toBe(grove.id);
    expect(body.project_id).toBe(projectId);
  });

  it('returns 404 for an unregistered project', async () => {
    const response = await call(
      createProjectBackupHandler({ backupsRoot, mycoHome }),
      { params: { projectId: createProjectId() } },
    );
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('project_not_found');
  });
});

describe('POST /api/projects/:projectId/restore', () => {
  it('restores a project-scoped snapshot', async () => {
    const { projectId } = seededProject();
    const backup = await call(
      createProjectBackupHandler({ backupsRoot, mycoHome }),
      { params: { projectId } },
    );
    const snapshotPath = (backup.body as { snapshot_path: string }).snapshot_path;

    // Wipe the row so restore has work to do.
    const dbPath = resolveGroveDbPath(
      ((await call(
        createProjectBackupHandler({ backupsRoot, mycoHome }),
        { params: { projectId } },
      )).body as { grove_id: string }).grove_id,
      mycoHome,
    );
    const db = openDatabase(dbPath);
    try {
      db.prepare('DELETE FROM sessions WHERE project_id = ?').run(projectId);
    } finally {
      db.close();
    }

    const response = await call(
      createProjectRestoreHandler({ mycoHome }),
      { params: { projectId }, body: { snapshot_path: snapshotPath } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { ok: boolean; total_restored: number };
    expect(body.ok).toBe(true);
    expect(body.total_restored).toBeGreaterThan(0);
  });

  it('returns 400 when snapshot_path is missing', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createProjectRestoreHandler({ mycoHome }),
      { params: { projectId }, body: {} },
    );
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe('snapshot_path_required');
  });

  it('returns 404 when snapshot file does not exist', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createProjectRestoreHandler({ mycoHome }),
      {
        params: { projectId },
        body: { snapshot_path: path.join(testDir, 'no-such-snapshot.sql') },
      },
    );
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('snapshot_not_found');
  });

  it('returns 400 when snapshot scope targets a different project', async () => {
    const { projectId: projectA } = seededProject();
    const backup = await call(
      createProjectBackupHandler({ backupsRoot, mycoHome }),
      { params: { projectId: projectA } },
    );
    const snapshotPath = (backup.body as { snapshot_path: string }).snapshot_path;

    // Register a second project (different id) and aim the restore at it.
    const otherGrove = createGrove('Other');
    ensureGroveSchema(otherGrove.id);
    const projectB = createProjectId();
    const otherRoot = path.join(testDir, 'other');
    fs.mkdirSync(resolveProjectVaultDir(otherRoot), { recursive: true });
    registerProjectInGrove(otherGrove.id, {
      projectId: projectB,
      projectName: 'Other',
      projectRoot: otherRoot,
    });

    const response = await call(
      createProjectRestoreHandler({ mycoHome }),
      { params: { projectId: projectB }, body: { snapshot_path: snapshotPath } },
    );
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe('snapshot_project_mismatch');
  });

  it('returns 400 when snapshot is all-projects scope (rejected)', async () => {
    const { grove, projectId } = seededProject();

    // Manually craft an all-projects snapshot via createBackup with default scope.
    const { createBackup } = await import('@myco/daemon/backup.js');
    const dbPath = resolveGroveDbPath(grove.id, mycoHome);
    const db = openDatabase(dbPath);
    let snapshotPath: string;
    try {
      snapshotPath = createBackup(db, path.join(backupsRoot, 'wide'), 'test-machine');
    } finally {
      db.close();
    }

    const response = await call(
      createProjectRestoreHandler({ mycoHome }),
      { params: { projectId }, body: { snapshot_path: snapshotPath } },
    );
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe('snapshot_project_mismatch');
  });

  it('returns 404 when target project is not registered', async () => {
    const { projectId } = seededProject();
    const backup = await call(
      createProjectBackupHandler({ backupsRoot, mycoHome }),
      { params: { projectId } },
    );
    const snapshotPath = (backup.body as { snapshot_path: string }).snapshot_path;

    const response = await call(
      createProjectRestoreHandler({ mycoHome }),
      {
        params: { projectId: createProjectId() },
        body: { snapshot_path: snapshotPath },
      },
    );
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('project_not_found');
  });
});
