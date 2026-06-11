import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearGroveRegistryCaches,
  createGrove,
  ForeignGroveError,
  UnknownGroveError,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath, resolveGroveDir } from '@myco/grove/paths.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { createBackupHandlers } from '@myco/daemon/api/backup.js';
import { createGroveBackup } from '@myco/backup/service.js';
import type { RouteRequest } from '@myco/daemon/router.js';

const MACHINE = 'testmachine';

interface Env {
  workDir: string;
  mycoHome: string;
  grove: GroveRecord;
  cache: GroveRuntimeCache;
  cleanup: () => void;
}

function setup(): Env {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bh-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const prev = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  // served_by gates compare against currentDaemonVariant(); pin the
  // default 'service' variant regardless of the ambient shell.
  const prevVariant = process.env.MYCO_SERVICE_VARIANT;
  delete process.env.MYCO_SERVICE_VARIANT;
  clearGroveRegistryCaches();
  const grove = createGrove('Solo', mycoHome);
  ensureGroveDatabase(grove.id, mycoHome);
  const db = openDatabase(resolveGroveDbPath(grove.id, mycoHome));
  createSchema(db);
  db.close();
  const cache = new GroveRuntimeCache();
  return {
    workDir,
    mycoHome,
    grove,
    cache,
    cleanup: () => {
      cache.closeAll();
      if (prev === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = prev;
      if (prevVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
      else process.env.MYCO_SERVICE_VARIANT = prevVariant;
      clearGroveRegistryCaches();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function req(partial: Partial<RouteRequest>): RouteRequest {
  return {
    body: undefined,
    query: {},
    params: {},
    pathname: '/api/backups',
    headers: {},
    ...partial,
  } as RouteRequest;
}

function ctx(groveId: string): RouteRequest['requestContext'] {
  return { groveId } as RouteRequest['requestContext'];
}

describe('backup handlers — explicit Grove, fail-loud', () => {
  let env: Env;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => env.cleanup());

  it('list fails loud (400 grove_required) with no Grove in context', async () => {
    const handlers = createBackupHandlers({ cache: env.cache, machineId: MACHINE, mycoHome: env.mycoHome });
    const res = await handlers.handleListBackups(req({ requestContext: undefined }));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('grove_required');
  });

  it('preview and restore also fail loud without a Grove', async () => {
    const handlers = createBackupHandlers({ cache: env.cache, machineId: MACHINE, mycoHome: env.mycoHome });
    const preview = await handlers.handleRestorePreview(req({ body: { file_name: 'x.sql' } }));
    const restore = await handlers.handleRestore(req({ body: { file_name: 'x.sql' } }));
    expect(preview.status).toBe(400);
    expect(restore.status).toBe(400);
  });

  it('list returns the Grove’s backups when a Grove is in context', async () => {
    const db = openDatabase(resolveGroveDbPath(env.grove.id, env.mycoHome));
    try {
      createGroveBackup({ groveId: env.grove.id, db, machineId: MACHINE, mycoHome: env.mycoHome });
    } finally {
      db.close();
    }
    const handlers = createBackupHandlers({ cache: env.cache, machineId: MACHINE, mycoHome: env.mycoHome });
    const res = await handlers.handleListBackups(req({ requestContext: ctx(env.grove.id) }));
    expect(res.status ?? 200).toBe(200);
    expect((res.body as { backups: unknown[] }).backups).toHaveLength(1);
  });

  it('a different Grove in context does not see another Grove’s backups', async () => {
    const db = openDatabase(resolveGroveDbPath(env.grove.id, env.mycoHome));
    try {
      createGroveBackup({ groveId: env.grove.id, db, machineId: MACHINE, mycoHome: env.mycoHome });
    } finally {
      db.close();
    }
    const other = createGrove('Other', env.mycoHome);
    ensureGroveDatabase(other.id, env.mycoHome);
    const handlers = createBackupHandlers({ cache: env.cache, machineId: MACHINE, mycoHome: env.mycoHome });
    const res = await handlers.handleListBackups(req({ requestContext: ctx(other.id) }));
    expect((res.body as { backups: unknown[] }).backups).toHaveLength(0);
  });

  it('restore starts a background job and status reports completion', async () => {
    const db = openDatabase(resolveGroveDbPath(env.grove.id, env.mycoHome));
    let fileName: string;
    try {
      const created = createGroveBackup({ groveId: env.grove.id, db, machineId: MACHINE, mycoHome: env.mycoHome });
      fileName = path.basename(created.file_path);
    } finally {
      db.close();
    }
    const handlers = createBackupHandlers({
      cache: env.cache,
      machineId: MACHINE,
      mycoHome: env.mycoHome,
      restoreRunner: async () => ({ tables: [], total_restored: 3, total_skipped: 1 }),
    });

    const started = await handlers.handleRestore(req({ requestContext: ctx(env.grove.id), body: { file_name: fileName } }));
    expect(started.status).toBe(202);
    const jobId = (started.body as { job_id: string }).job_id;
    expect(jobId).toBeTruthy();

    let status: { status: string; result?: { total_restored: number } | null } = { status: 'running' };
    for (let i = 0; i < 50 && status.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const res = await handlers.handleRestoreStatus(req({ requestContext: ctx(env.grove.id), query: { job_id: jobId } }));
      status = res.body as typeof status;
    }
    expect(status.status).toBe('done');
    expect(status.result?.total_restored).toBe(3);
  });

  it('restore status fails loud without a Grove and 404s an unknown job', async () => {
    const handlers = createBackupHandlers({ cache: env.cache, machineId: MACHINE, mycoHome: env.mycoHome });
    const noGrove = await handlers.handleRestoreStatus(req({ requestContext: undefined, query: { job_id: 'x' } }));
    expect(noGrove.status).toBe(400);
    const unknown = await handlers.handleRestoreStatus(req({ requestContext: ctx(env.grove.id), query: { job_id: 'nope' } }));
    expect(unknown.status).toBe(404);
  });

  it('create backup succeeds for a Grove served by this daemon variant', async () => {
    const handlers = createBackupHandlers({ cache: env.cache, machineId: MACHINE, mycoHome: env.mycoHome });
    const res = await handlers.handleCreateBackup(req({
      body: { scope: { kind: 'grove', grove_id: env.grove.id } },
    }));
    expect(res.status ?? 200).toBe(200);
    const body = res.body as { summary: { ok: number; failed: number }; file_path?: string };
    expect(body.summary).toEqual({ ok: 1, failed: 0 });
    expect(body.file_path).toBeTruthy();
  });

  it('create backup refuses a foreign-served Grove before opening its DB (RC-5)', async () => {
    const foreign = createGrove('Dogfood', env.mycoHome, { servedBy: 'service-dev' });
    const handlers = createBackupHandlers({ cache: env.cache, machineId: MACHINE, mycoHome: env.mycoHome });

    let caught: unknown;
    try {
      await handlers.handleCreateBackup(req({
        body: { scope: { kind: 'grove', grove_id: foreign.id } },
      }));
    } catch (err) {
      caught = err;
    }
    // Thrown so the daemon transport maps it to 403 foreign_grove; the
    // foreign Grove's DB was never opened or created.
    expect(caught).toBeInstanceOf(ForeignGroveError);
    expect(fs.existsSync(resolveGroveDbPath(foreign.id, env.mycoHome))).toBe(false);
  });

  it('create backup refuses an unknown Grove id without creating groves/<id>/ (RC-5)', async () => {
    const unknownId = 'grove_' + 'f'.repeat(32);
    const handlers = createBackupHandlers({ cache: env.cache, machineId: MACHINE, mycoHome: env.mycoHome });

    let caught: unknown;
    try {
      await handlers.handleCreateBackup(req({
        body: { scope: { kind: 'grove', grove_id: unknownId } },
      }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownGroveError);
    expect(fs.existsSync(resolveGroveDir(unknownId, env.mycoHome))).toBe(false);
  });
});
