import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { insertLogEntry } from '@myco/db/queries/logs';
import { DatabaseMaintenanceManager } from '@myco/daemon/database/manager.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { registerPowerJobs, type PowerJobDeps } from '@myco/daemon/power-jobs.js';
import { writeStagedSkill, stagingRoot } from '@myco/agent/tools/skill-staging.js';

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

// ---------------------------------------------------------------------------
// database-optimize job (covers the auto-optimize scheduling toggle added in
// main's database-maintenance-tab feature)
// ---------------------------------------------------------------------------
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
      liveConfig: {
        current: {
          daemon: { log_retention_days: 30 },
          backup: {},
          maintenance: { auto_optimize: true, auto_optimize_interval_hours: 24 },
          cortex: { instructions: { inject_on_session_start: true } },
          ...overrides,
        },
      } as never,
      db: getDatabase(),
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
    const call = errorSpy.mock.calls.find((c) => c[0] === 'database.error' || c[0]?.includes?.('database.error'));
    expect(call).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// staging-gc job (covers the skill-generate staging sweep added for the
// 2026-04-08 skill lifecycle audit)
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function buildStagingDeps(vaultDir: string): PowerJobDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    embeddingManager: { reconcile: async () => 0 } as any,
    registry: { sessions: new Set<string>() } as any,
    logger: createMockLogger() as any,
    liveConfig: {
      current: {
        daemon: { log_retention_days: 30 },
        backup: {},
        maintenance: { auto_optimize: false, auto_optimize_interval_hours: 24 },
        cortex: { instructions: { inject_on_session_start: true } },
      },
    } as any,
    db: {} as any,
    machineId: 'test-machine',
    vaultDir,
    databaseManager: {
      getLastOptimizeAt: async () => null,
      optimize: async () => undefined,
    } as any,
  };
}

describe('registerPowerJobs — staging-gc', () => {
  let tmpDir: string;
  let vaultDir: string;
  let pm: FakePowerManager;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-power-gc-')));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    pm = new FakePowerManager();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers a staging-gc job that runs in idle and sleep states', () => {
    registerPowerJobs(pm as never, buildStagingDeps(vaultDir));
    const gc = pm.find('staging-gc');
    expect(gc.runIn).toContain('idle');
    expect(gc.runIn).toContain('sleep');
  });

  it('removes stale staging entries when the job runs', async () => {
    registerPowerJobs(pm as never, buildStagingDeps(vaultDir));
    const gc = pm.find('staging-gc');

    // Fresh entry (should survive)
    writeStagedSkill(vaultDir, 'cand-fresh', 'fresh content');

    // Stale entry (should be swept)
    writeStagedSkill(vaultDir, 'cand-stale', 'old content');
    const stalePath = path.resolve(stagingRoot(vaultDir), 'cand-stale');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stalePath, twoDaysAgo, twoDaysAgo);

    await gc.fn();

    expect(fs.existsSync(path.resolve(stagingRoot(vaultDir), 'cand-fresh'))).toBe(true);
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it('is a no-op when the staging root does not exist', async () => {
    registerPowerJobs(pm as never, buildStagingDeps(vaultDir));
    const gc = pm.find('staging-gc');
    await expect(gc.fn()).resolves.toBeUndefined();
  });

  it('is a no-op when all entries are fresh', async () => {
    registerPowerJobs(pm as never, buildStagingDeps(vaultDir));
    const gc = pm.find('staging-gc');

    writeStagedSkill(vaultDir, 'cand-a', 'a');
    writeStagedSkill(vaultDir, 'cand-b', 'b');

    await gc.fn();

    expect(fs.existsSync(path.resolve(stagingRoot(vaultDir), 'cand-a'))).toBe(true);
    expect(fs.existsSync(path.resolve(stagingRoot(vaultDir), 'cand-b'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// embedding-reconcile job (covers the deep-sleep toggle wired to the
// preventsDeepSleep predicate so the queue keeps draining overnight)
// ---------------------------------------------------------------------------

describe('embedding-reconcile power job', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pj-embed-')));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildEmbeddingDeps(opts: {
    runInDeepSleep: boolean;
    pendingCount: number;
  }): { pm: FakePowerManager; embeddingMock: { totalPendingCount: () => number; reconcile: () => Promise<unknown> } } {
    const pm = new FakePowerManager();
    const embeddingMock = {
      reconcile: async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 }),
      totalPendingCount: () => opts.pendingCount,
    };
    const deps = {
      embeddingManager: embeddingMock as never,
      registry: { sessions: new Set<string>() } as never,
      logger: createMockLogger() as never,
      liveConfig: {
        current: {
          daemon: { log_retention_days: 30 },
          backup: {},
          maintenance: { auto_optimize: false, auto_optimize_interval_hours: 24 },
          cortex: { instructions: { inject_on_session_start: true } },
          embedding: { run_in_deep_sleep: opts.runInDeepSleep },
        },
      } as never,
      db: {} as never,
      machineId: 'test-machine',
      vaultDir: tmpDir,
      databaseManager: {
        getLastOptimizeAt: async () => null,
        optimize: async () => undefined,
      } as never,
    };
    registerPowerJobs(pm as never, deps);
    return { pm, embeddingMock };
  }

  it('runs in active, idle, and sleep states', () => {
    const { pm } = buildEmbeddingDeps({ runInDeepSleep: true, pendingCount: 0 });
    const job = pm.find('embedding-reconcile');
    expect(job.runIn).toEqual(['active', 'idle', 'sleep']);
  });

  it('preventsDeepSleep returns true when toggle is on and pending work remains', () => {
    const { pm } = buildEmbeddingDeps({ runInDeepSleep: true, pendingCount: 5 });
    const job = pm.find('embedding-reconcile');
    expect(job.preventsDeepSleep?.()).toBe(true);
  });

  it('preventsDeepSleep returns false when toggle is on but queue is empty', () => {
    const { pm } = buildEmbeddingDeps({ runInDeepSleep: true, pendingCount: 0 });
    const job = pm.find('embedding-reconcile');
    expect(job.preventsDeepSleep?.()).toBe(false);
  });

  it('preventsDeepSleep returns false when toggle is off, even with pending work', () => {
    const { pm } = buildEmbeddingDeps({ runInDeepSleep: false, pendingCount: 50 });
    const job = pm.find('embedding-reconcile');
    expect(job.preventsDeepSleep?.()).toBe(false);
  });

  it('preventsDeepSleep tolerates a thrown totalPendingCount call', () => {
    const pm = new FakePowerManager();
    const deps = {
      embeddingManager: {
        reconcile: async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 }),
        totalPendingCount: () => { throw new Error('db offline'); },
      } as never,
      registry: { sessions: new Set<string>() } as never,
      logger: createMockLogger() as never,
      liveConfig: {
        current: {
          daemon: { log_retention_days: 30 },
          backup: {},
          maintenance: { auto_optimize: false, auto_optimize_interval_hours: 24 },
          cortex: { instructions: { inject_on_session_start: true } },
          embedding: { run_in_deep_sleep: true },
        },
      } as never,
      db: {} as never,
      machineId: 'test-machine',
      vaultDir: tmpDir,
      databaseManager: {
        getLastOptimizeAt: async () => null,
        optimize: async () => undefined,
      } as never,
    };
    registerPowerJobs(pm as never, deps);
    const job = pm.find('embedding-reconcile');
    expect(job.preventsDeepSleep?.()).toBe(false);
  });
});

describe('log-retention power job', () => {
  let tmpDir: string;
  let dbPath: string;
  let pm: FakePowerManager;
  let databaseManager: DatabaseMaintenanceManager;
  let logger: DaemonLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pj-retain-'));
    dbPath = path.join(tmpDir, 'myco.db');
    initDatabase(dbPath);
    createSchema(getDatabase());
    logger = new DaemonLogger(path.join(tmpDir, 'logs'));
    databaseManager = new DatabaseMaintenanceManager(dbPath, tmpDir, logger);
    pm = new FakePowerManager();
    // Seed initial myco.yaml with retention=7
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'),
      `version: 3\ndaemon:\n  log_retention_days: 7\n`);
  });

  afterEach(() => {
    logger.close();
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildDeps() {
    const liveConfig = {
      current: {
        daemon: { log_retention_days: 7 },
        backup: {},
        maintenance: { auto_optimize: false, auto_optimize_interval_hours: 24 },
        cortex: { instructions: { inject_on_session_start: true } },
      } as never,
    };
    return {
      deps: {
        embeddingManager: { reconcile: async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 }) } as never,
        registry: { listActive: () => [], sessions: [] } as never,
        logger: logger as never,
        liveConfig: liveConfig as never,
        db: getDatabase(),
        machineId: 'test-machine',
        vaultDir: tmpDir,
        databaseManager,
      },
      liveConfig,
    };
  }

  it('reads log_retention_days from liveConfig on each run', async () => {
    // Regression: the job must not capture log_retention_days at registration.
    // Mutating liveConfig.current between runs (as a reaction would) must
    // flip the retention window on the very next invocation.
    const { deps, liveConfig } = buildDeps();
    registerPowerJobs(pm as never, deps);

    const FOURTEEN_DAYS_AGO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    insertLogEntry({
      timestamp: FOURTEEN_DAYS_AGO,
      level: 'info',
      kind: 'test',
      component: 'test',
      message: 'old-entry',
      data: null,
      session_id: null,
    });

    // Simulate a Settings write that moves retention from 7 → 30 days.
    liveConfig.current = {
      ...liveConfig.current,
      daemon: { log_retention_days: 30 },
    } as never;

    await pm.find('log-retention').fn();

    const { getLogTail } = await import('@myco/db/queries/logs');
    const rows = getLogTail(50).entries;
    expect(rows.some((r) => r.message === 'old-entry')).toBe(true);
  });
});
