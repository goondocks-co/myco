import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { DaemonLogger } from '@myco/daemon/logger';
import { insertLogEntry } from '@myco/db/queries/logs';
import { LOG_KINDS } from '@myco/constants/log-kinds';
import { DatabaseMaintenanceManager } from '../../../src/daemon/database/manager';
import { VacuumPrecheckError } from '../../../src/daemon/database/types';

describe('DatabaseMaintenanceManager', () => {
  let tmpDir: string;
  let dbPath: string;
  let manager: DatabaseMaintenanceManager;
  let logger: DaemonLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-db-mgr-'));
    dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);

    // Real DaemonLogger wired to SQLite via setPersistFn — mirrors the
    // production wiring in src/daemon/main.ts so that logger.info(...) calls
    // end up as rows in log_entries, which getLastDatabaseLogTimestamp reads.
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logger = new DaemonLogger(logDir);
    logger.setPersistFn((entry) => {
      const { timestamp, level, kind, component, message, ...rest } = entry;
      insertLogEntry({
        timestamp,
        level,
        kind,
        component,
        message,
        data: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
        session_id: (rest.session_id as string) ?? null,
      });
    });
    vi.spyOn(logger, 'info');

    manager = new DatabaseMaintenanceManager(getDatabase(), dbPath, tmpDir, logger);
  });

  afterEach(() => {
    logger.close();
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getDetails returns the full DatabaseDetails shape', async () => {
    const details = await manager.getDetails();
    expect(details.file.path).toBe(dbPath);
    expect(details.file.size_bytes).toBeGreaterThan(0);
    expect(details.schema.version).toBeGreaterThan(0);
    expect(details.tables.length).toBeGreaterThan(0);
    expect(details.indexes.length).toBeGreaterThan(0);
    expect(details.last_optimize_at).toBeNull();
    expect(details.last_vacuum_at).toBeNull();
    expect(details.last_integrity_check).toBeNull();
  });

  it('optimize runs all sub-actions and reports completion', async () => {
    const result = await manager.optimize();
    expect(result.actions_completed.length).toBeGreaterThan(0);
    expect(result.actions_failed).toEqual([]);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(logger.info).toHaveBeenCalled();
  });

  it('optimize updates last_optimize_at on subsequent getDetails()', async () => {
    await manager.optimize();
    const details = await manager.getDetails();
    expect(details.last_optimize_at).not.toBeNull();
  });

  it('vacuum returns size deltas and writes a log entry', async () => {
    const result = await manager.vacuum();
    expect(result.size_before).toBeGreaterThan(0);
    expect(result.size_after).toBeGreaterThan(0);
    expect(typeof result.freed_bytes).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(logger.info).toHaveBeenCalled();
  });

  it('vacuum throws VacuumPrecheckError when free disk is below 2x DB size', async () => {
    const spy = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({
      bavail: 1n,
      bsize: 1,
      blocks: 1n,
      bfree: 1n,
      ffree: 0n,
      files: 0n,
      type: 0,
    } as never);
    await expect(manager.vacuum()).rejects.toBeInstanceOf(VacuumPrecheckError);
    spy.mockRestore();
  });

  it('reindex completes and writes a log entry', async () => {
    const result = await manager.reindex();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(logger.info).toHaveBeenCalled();
  });

  it('integrityCheck returns ok for a healthy DB', async () => {
    const result = await manager.integrityCheck();
    expect(result.status).toBe('ok');
    expect(result.issues).toEqual([]);
    expect(result.fk_violations).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('getLastOptimizeAt returns null then a number after optimize()', async () => {
    expect(await manager.getLastOptimizeAt()).toBeNull();
    await manager.optimize();
    const ts = await manager.getLastOptimizeAt();
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(0);
  });

  it('getDetails reports last_integrity_check status=issues when most recent run had issues', async () => {
    // Simulate a prior integrity run that surfaced issues by inserting a fake
    // log entry directly. We use this approach instead of corrupting a real
    // DB because forcing SQLite into an inconsistent state is fragile.
    insertLogEntry({
      timestamp: new Date().toISOString(),
      level: 'info',
      kind: LOG_KINDS.DATABASE_INTEGRITY_ISSUES,
      component: 'database',
      message: 'test',
      data: null,
      session_id: null,
    });
    const details = await manager.getDetails();
    expect(details.last_integrity_check).not.toBeNull();
    expect(details.last_integrity_check!.status).toBe('issues');
  });
});
