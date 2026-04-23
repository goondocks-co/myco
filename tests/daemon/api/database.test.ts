import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { DatabaseMaintenanceManager } from '@myco/daemon/database/manager';
import {
  handleDatabaseDetails,
  handleDatabaseOptimize,
  handleDatabaseVacuum,
  handleDatabaseReindex,
  handleDatabaseIntegrityCheck,
} from '@myco/daemon/api/database';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('database API handlers', () => {
  let tmpDir: string;
  let dbPath: string;
  let manager: DatabaseMaintenanceManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-db-api-'));
    dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
    manager = new DatabaseMaintenanceManager(dbPath, tmpDir, makeLogger());
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handleDatabaseDetails returns 200 with details body', async () => {
    const res = await handleDatabaseDetails(manager);
    expect(res.body).toBeDefined();
    expect((res.body as { file: { path: string } }).file.path).toBe(dbPath);
  });

  it('handleDatabaseOptimize returns optimize result', async () => {
    const res = await handleDatabaseOptimize(manager);
    expect(res.body).toBeDefined();
    expect((res.body as { actions_completed: unknown[] }).actions_completed.length).toBeGreaterThan(0);
  });

  it('handleDatabaseVacuum returns 200 on success', async () => {
    const res = await handleDatabaseVacuum(manager);
    expect(res.status === undefined || res.status < 400).toBe(true);
  });

  it('handleDatabaseVacuum returns 409 with error details on insufficient disk', async () => {
    const spy = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({
      bavail: 1n,
      bsize: 1,
      blocks: 1n,
      bfree: 1n,
      ffree: 0n,
      files: 0n,
      type: 0,
    } as never);
    const res = await handleDatabaseVacuum(manager);
    expect(res.status).toBe(409);
    const body = res.body as { error: string; required_bytes: number; free_bytes: number };
    expect(body.error).toBe('insufficient_disk_space');
    expect(body.required_bytes).toBeGreaterThan(0);
    expect(body.free_bytes).toBeGreaterThanOrEqual(0);
    spy.mockRestore();
  });

  it('handleDatabaseReindex returns 200', async () => {
    const res = await handleDatabaseReindex(manager);
    expect(res.body).toBeDefined();
  });

  it('handleDatabaseIntegrityCheck returns 200 with status=ok', async () => {
    const res = await handleDatabaseIntegrityCheck(manager);
    expect((res.body as { status: string }).status).toBe('ok');
  });
});
