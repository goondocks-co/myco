import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { insertLogEntry } from '@myco/db/queries/logs';
import { DatabaseMaintenanceManager } from '../../src/daemon/database/manager';
import { DaemonLogger } from '../../src/daemon/logger';
import { registerPowerJobs } from '../../src/daemon/power-jobs';

class FakePowerManager {
  jobs: Array<{ name: string; runIn: string[]; fn: () => Promise<void>; preventsDeepSleep?: () => boolean }> = [];
  register(job: { name: string; runIn: string[]; fn: () => Promise<void>; preventsDeepSleep?: () => boolean }) {
    this.jobs.push(job);
  }
  find(name: string) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error('job not found: ' + name);
    return job;
  }
}

describe('database-optimize power job', () => {
  let tmpDir: string;
  let dbPath: string;
  let pm: FakePowerManager;
  let databaseManager: DatabaseMaintenanceManager;
  let logger: DaemonLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pj-'));
    dbPath = path.join(tmpDir, 'myco.db');
    initDatabase(dbPath);
    createSchema(getDatabase());
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logger = new DaemonLogger(logDir);
    logger.setPersistFn((entry) => {
      insertLogEntry({
        timestamp: entry.timestamp,
        level: entry.level,
        kind: entry.kind,
        component: entry.component ?? 'database',
        message: entry.message,
        data: entry.data ? JSON.stringify(entry.data) : null,
        session_id: null,
      });
    });
    databaseManager = new DatabaseMaintenanceManager(dbPath, tmpDir, logger);
    pm = new FakePowerManager();
  });

  afterEach(() => {
    logger.close();
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildDeps(overrides: Record<string, unknown> = {}) {
    return {
      embeddingManager: { reconcile: async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 }) } as never,
      registry: { listActive: () => [], sessions: [] } as never,
      logger: logger as never,
      config: {
        daemon: { log_retention_days: 30 },
        backup: {},
        maintenance: { auto_optimize: true, auto_optimize_interval_hours: 24 },
        ...overrides,
      } as never,
      db: getDatabase(),
      backupDir: path.join(tmpDir, 'backups'),
      machineId: 'test-machine',
      vaultDir: tmpDir,
      databaseManager,
    };
  }

  it('registers a database-optimize job', () => {
    registerPowerJobs(pm as never, buildDeps());
    const job = pm.find('database-optimize');
    expect(job.runIn).toEqual(['idle', 'sleep']);
  });

  it('runs optimize when no prior run exists', async () => {
    const spy = vi.spyOn(databaseManager, 'optimize');
    registerPowerJobs(pm as never, buildDeps());
    await pm.find('database-optimize').fn();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('skips optimize when toggle is disabled', async () => {
    const spy = vi.spyOn(databaseManager, 'optimize');
    registerPowerJobs(
      pm as never,
      buildDeps({ maintenance: { auto_optimize: false, auto_optimize_interval_hours: 24 } }),
    );
    await pm.find('database-optimize').fn();
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips optimize when interval has not elapsed since last run', async () => {
    // First run populates log_entries
    await databaseManager.optimize();
    const spy = vi.spyOn(databaseManager, 'optimize');
    registerPowerJobs(pm as never, buildDeps());
    await pm.find('database-optimize').fn();
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs DATABASE_ERROR when optimize() throws', async () => {
    const optimizeSpy = vi.spyOn(databaseManager, 'optimize').mockRejectedValue(new Error('boom'));
    const errorSpy = vi.spyOn(logger, 'error');
    registerPowerJobs(pm as never, buildDeps());
    await pm.find('database-optimize').fn();
    expect(optimizeSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    // Verify the error log used the right kind
    const call = errorSpy.mock.calls.find((c) => c[0] === 'database.error' || c[0]?.includes?.('database.error'));
    expect(call).toBeDefined();
  });
});
