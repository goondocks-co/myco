import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase, closeDatabase, getDatabase, withDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { insertLogEntry } from '@myco/db/queries/logs';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { registerPowerJobs, type PowerJobDeps } from '@myco/daemon/power-jobs.js';
import { writeStagedSkill, stagingRoot } from '@myco/agent/tools/skill-staging.js';
import { GroveRuntimeCache, type EmbeddingRuntimeFactory } from '@myco/daemon/grove-runtime-cache.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { loadGroveConfig, saveGroveConfig } from '@myco/config/loader.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

// ---------------------------------------------------------------------------
// Test fixture: bring up a real Myco home with one Grove and an open DB
// ---------------------------------------------------------------------------

interface GroveFixture {
  workDir: string;
  mycoHome: string;
  grove: GroveRecord;
  databasePath: string;
  cache: GroveRuntimeCache;
  logger: DaemonLogger;
  embeddingMock: { totalPendingCount: () => number; reconcile: ReturnType<typeof vi.fn>; reconcileSlice: ReturnType<typeof vi.fn> };
  factory: EmbeddingRuntimeFactory;
  cleanup: () => void;
}

function setupGrove(opts: { pendingCount?: number } = {}): GroveFixture {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pj-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const previousMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();

  const logger = new DaemonLogger(path.join(workDir, 'logs'), { level: 'info' });
  // Persist log entries to the scoped DB so DatabaseMaintenanceManager's
  // info logs (LOG_KINDS.DATABASE_OPTIMIZE / DATABASE_INTEGRITY_CHECK) end
  // up in the per-Grove log_entries table that the interval gates read.
  logger.setPersistFn((entry) => {
    const { timestamp, level, kind, component, message, data, session_id } = entry;
    insertLogEntry({
      timestamp,
      level,
      kind,
      component: component ?? 'database',
      message,
      data: data ? JSON.stringify(data) : null,
      session_id: (session_id as string | undefined) ?? null,
    });
  });

  const grove = createGrove('Solo', mycoHome);
  ensureGroveDatabase(grove.id, mycoHome);
  const databasePath = resolveGroveDbPath(grove.id, mycoHome);

  // Open as the boot DB so getDatabase() works for callers that reach in
  // without a withDatabase scope (e.g. the legacy log-retention deleteOldLogs).
  initDatabase(databasePath);
  createSchema(getDatabase());

  const cache = new GroveRuntimeCache();
  const embeddingMock = {
    totalPendingCount: () => opts.pendingCount ?? 0,
    reconcile: vi.fn(async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 })),
    reconcileSlice: vi.fn(async () => ({ processed: 0, remaining: 0 })),
  };
  const factory: EmbeddingRuntimeFactory = (db, dbPath) => ({
    // The embedding runtime cache only cares that the factory returns a
    // (vectorStore, embeddingManager) pair. Both are opaque holders for
    // tests; we never hit the real vector store.
    vectorStore: { close() {} } as never,
    embeddingManager: embeddingMock as never,
  });

  // Force the cache to associate the shared embeddingMock with this Grove
  // so subsequent .getEmbeddingRuntime calls (from the hold probe,
  // embedding-reconcile fan-out) all resolve to it.
  cache.getEmbeddingRuntime(databasePath, factory);

  return {
    workDir,
    mycoHome,
    grove,
    databasePath,
    cache,
    logger,
    embeddingMock,
    factory,
    cleanup: () => {
      cache.closeAll();
      logger.close();
      try { closeDatabase(); } catch { /* noop */ }
      if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousMycoHome;
      clearGroveRegistryCaches();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

interface FakeJob {
  name: string;
  runIn: string[];
  kind: string;
  priority?: string;
  drain?: { slice: number; softDeadlineMs?: number };
  hold?: { pending: () => number; allowDeepSleepHold?: boolean };
  fn: (ctx?: unknown) => Promise<unknown>;
}

class FakeJobRunner {
  jobs: FakeJob[] = [];
  register(job: FakeJob) {
    this.jobs.push(job);
  }
  replaceGroup(prefix: string, jobs: FakeJob[]) {
    this.jobs = this.jobs.filter((j) => !j.name.startsWith(prefix));
    this.jobs.push(...jobs);
  }
  find(name: string) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error('job not found: ' + name);
    return job;
  }
}

// Mirror JobRunner.providesHold's per-job decision: a job holds deep sleep
// only when its hold spec opts in (allowDeepSleepHold !== false) and its
// pending probe reports work. A failing probe never holds.
function jobHoldsDeepSleep(job: FakeJob): boolean {
  if (!job.hold) return false;
  if ((job.hold.allowDeepSleepHold ?? true) === false) return false;
  try {
    return job.hold.pending() > 0;
  } catch {
    return false;
  }
}

function buildDeps(fx: GroveFixture, overrides: Partial<Record<string, unknown>> = {}): PowerJobDeps {
  const liveConfig = {
    current: {
      daemon: { log_retention_days: 30, stale_session_threshold_ms: 60 * 60 * 1000 },
      backup: { retention: { keep_daily: 14, keep_weekly: 8 } },
      maintenance: {
        auto_optimize: true,
        auto_optimize_interval_hours: 24,
        auto_integrity_check: true,
        auto_integrity_check_interval_hours: 168,
      },
      cortex: {
        instructions: { inject_on_session_start: true },
        canopy: {
          refresh: { background_enabled: false, background_period_minutes: 60 },
          exclude: { default_patterns: [], patterns: [] },
        },
      },
      embedding: { run_in_deep_sleep: true },
      ...(overrides.config as Record<string, unknown> ?? {}),
    },
  };
  return {
    registry: { sessions: new Set<string>() } as never,
    logger: fx.logger,
    liveConfig: liveConfig as never,
    machineId: 'test-machine',
    daemonVaultDir: fx.workDir,
    cache: fx.cache,
    embeddingRuntimeFactory: fx.factory,
    mycoHome: fx.mycoHome,
    daemonStateDir: path.join(fx.mycoHome, 'service'),
  };
}

// ---------------------------------------------------------------------------
// database-optimize
// ---------------------------------------------------------------------------
describe('database-optimize power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('registers a database-optimize job', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('database-optimize');
    expect(job.runIn).toEqual(['idle', 'sleep']);
  });

  it('writes a database.optimize log row when no prior run exists', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('database-optimize').fn();
    const row = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM log_entries WHERE kind = ?`,
      ).get(LOG_KINDS.DATABASE_OPTIMIZE) as { n: number },
    );
    expect(row.n).toBeGreaterThan(0);
  });

  it('skips optimize when toggle is disabled', async () => {
    registerPowerJobs(
      pm as never,
      buildDeps(fx, {
        config: {
          daemon: { log_retention_days: 30, stale_session_threshold_ms: 60 * 60 * 1000 },
          backup: { retention: { keep_daily: 14, keep_weekly: 8 } },
          maintenance: {
            auto_optimize: false,
            auto_optimize_interval_hours: 24,
            auto_integrity_check: true,
            auto_integrity_check_interval_hours: 168,
          },
          cortex: { instructions: { inject_on_session_start: true } },
          embedding: { run_in_deep_sleep: true },
        },
      }),
    );
    await pm.find('database-optimize').fn();
    const row = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM log_entries WHERE kind = ?`,
      ).get(LOG_KINDS.DATABASE_OPTIMIZE) as { n: number },
    );
    expect(row.n).toBe(0);
  });

  it('skips optimize when interval has not elapsed since last run', async () => {
    // Seed a recent optimize log so the gate trips on the second invocation.
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      insertLogEntry({
        timestamp: new Date().toISOString(),
        level: 'info',
        kind: LOG_KINDS.DATABASE_OPTIMIZE,
        component: 'database',
        message: 'seeded',
        data: null,
        session_id: null,
      });
    });
    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('database-optimize').fn();
    // Still exactly one row — the job did not append a new one.
    const row = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM log_entries WHERE kind = ?`,
      ).get(LOG_KINDS.DATABASE_OPTIMIZE) as { n: number },
    );
    expect(row.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// staging-gc — fans out across every registered project's vault
// ---------------------------------------------------------------------------

describe('registerPowerJobs — staging-gc', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('registers a staging-gc job that runs in idle and sleep states', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const gc = pm.find('staging-gc');
    expect(gc.runIn).toContain('idle');
    expect(gc.runIn).toContain('sleep');
  });

  it('is a no-op when no projects are registered', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const gc = pm.find('staging-gc');
    await expect(gc.fn()).resolves.toBeUndefined();
  });

  it('removes stale staging entries from a registered project vault', async () => {
    const projectRoot = path.join(fx.workDir, 'projects', 'p1');
    const projectVaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(projectVaultDir, { recursive: true });
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + '11223344556677889900aabbccddeeff',
      projectName: 'p1',
      projectRoot,
    }, fx.mycoHome);

    registerPowerJobs(pm as never, buildDeps(fx));
    const gc = pm.find('staging-gc');

    writeStagedSkill(projectVaultDir, 'cand-fresh', 'fresh content');
    writeStagedSkill(projectVaultDir, 'cand-stale', 'old content');
    const stalePath = path.resolve(stagingRoot(projectVaultDir), 'cand-stale');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stalePath, twoDaysAgo, twoDaysAgo);

    await gc.fn();

    expect(fs.existsSync(path.resolve(stagingRoot(projectVaultDir), 'cand-fresh'))).toBe(true);
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it('sweeps every registered project in every Grove', async () => {
    const projectRootA = path.join(fx.workDir, 'projects', 'a');
    const projectRootB = path.join(fx.workDir, 'projects', 'b');
    const vaultA = resolveProjectVaultDir(projectRootA);
    const vaultB = resolveProjectVaultDir(projectRootB);
    fs.mkdirSync(vaultA, { recursive: true });
    fs.mkdirSync(vaultB, { recursive: true });
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'aaaa111122223333aaaa111122223333',
      projectName: 'a',
      projectRoot: projectRootA,
    }, fx.mycoHome);
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'bbbb111122223333bbbb111122223333',
      projectName: 'b',
      projectRoot: projectRootB,
    }, fx.mycoHome);

    registerPowerJobs(pm as never, buildDeps(fx));
    const gc = pm.find('staging-gc');

    writeStagedSkill(vaultA, 'a-stale', 'old');
    writeStagedSkill(vaultB, 'b-stale', 'old');
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.resolve(stagingRoot(vaultA), 'a-stale'), oldTime, oldTime);
    fs.utimesSync(path.resolve(stagingRoot(vaultB), 'b-stale'), oldTime, oldTime);

    await gc.fn();

    expect(fs.existsSync(path.resolve(stagingRoot(vaultA), 'a-stale'))).toBe(false);
    expect(fs.existsSync(path.resolve(stagingRoot(vaultB), 'b-stale'))).toBe(false);
  });
});

describe('release-provenance power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('registers a release-provenance-reconcile job that runs in active/idle/sleep', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('release-provenance-reconcile');
    expect(job.runIn).toEqual(['active', 'idle', 'sleep']);
  });
});

// ---------------------------------------------------------------------------
// embedding-reconcile — runs in active/idle/sleep, fans out per Grove
// ---------------------------------------------------------------------------

describe('embedding-reconcile power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('runs in active, idle, and sleep states', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('embedding-reconcile');
    expect(job.runIn).toEqual(['active', 'idle', 'sleep']);
  });

  it('hold holds deep sleep when toggle is on and any Grove has pending work', () => {
    fx.cleanup();
    fx = setupGrove({ pendingCount: 5 });
    pm = new FakeJobRunner();
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('embedding-reconcile');
    expect(jobHoldsDeepSleep(job)).toBe(true);
  });

  it('hold does not hold deep sleep when toggle is on but every Grove queue is empty', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('embedding-reconcile');
    expect(jobHoldsDeepSleep(job)).toBe(false);
  });

  it('hold ignores pending work in Groves served by a different daemon', () => {
    const devGrove = createGrove('Dogfood', fx.mycoHome, { servedBy: 'service-dev' });
    ensureGroveDatabase(devGrove.id, fx.mycoHome);
    const devDatabasePath = resolveGroveDbPath(devGrove.id, fx.mycoHome);

    const managers = new Map<string, { totalPendingCount: () => number; reconcile: ReturnType<typeof vi.fn>; reconcileSlice: ReturnType<typeof vi.fn> }>([
      [fx.databasePath, { totalPendingCount: () => 0, reconcile: vi.fn(async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 })), reconcileSlice: vi.fn(async () => ({ processed: 0, remaining: 0 })) }],
      [devDatabasePath, { totalPendingCount: () => 5, reconcile: vi.fn(async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 })), reconcileSlice: vi.fn(async () => ({ processed: 0, remaining: 0 })) }],
    ]);
    const factory: EmbeddingRuntimeFactory = (_db, dbPath) => ({
      vectorStore: { close() {} } as never,
      embeddingManager: managers.get(dbPath)! as never,
    });
    fx.cache.getEmbeddingRuntime(devDatabasePath, factory);

    const deps = buildDeps(fx);
    deps.embeddingRuntimeFactory = factory;
    registerPowerJobs(pm as never, deps);

    const job = pm.find('embedding-reconcile');
    expect(jobHoldsDeepSleep(job)).toBe(false);
  });

  it('hold does not hold deep sleep when toggle is off, even with pending work', () => {
    fx.cleanup();
    fx = setupGrove({ pendingCount: 50 });
    pm = new FakeJobRunner();
    registerPowerJobs(pm as never, buildDeps(fx, {
      config: {
        daemon: { log_retention_days: 30, stale_session_threshold_ms: 60 * 60 * 1000 },
        backup: {},
        maintenance: {
          auto_optimize: false,
          auto_optimize_interval_hours: 24,
          auto_integrity_check: true,
          auto_integrity_check_interval_hours: 168,
        },
        cortex: { instructions: { inject_on_session_start: true } },
        embedding: { run_in_deep_sleep: false },
      },
    }));
    const job = pm.find('embedding-reconcile');
    expect(jobHoldsDeepSleep(job)).toBe(false);
  });

  it('reconcile body invokes reconcileSlice on the per-Grove embedding manager', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const ctx = { sliceBudget: { maxItems: 50, softDeadlineMs: 2000 } };
    await pm.find('embedding-reconcile').fn(ctx);
    expect(fx.embeddingMock.reconcileSlice).toHaveBeenCalledTimes(1);
    expect(fx.embeddingMock.reconcileSlice).toHaveBeenCalledWith({ maxItems: 50, softDeadlineMs: 2000 });
  });
});

// ---------------------------------------------------------------------------
// log-retention
// ---------------------------------------------------------------------------

describe('log-retention power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('reads log_retention_days from liveConfig on each run', async () => {
    const deps = buildDeps(fx);
    // Force retention=7 at registration; we'll flip to 30 before running.
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      daemon: { ...deps.liveConfig.current.daemon, log_retention_days: 7 },
    };
    registerPowerJobs(pm as never, deps);

    // Seed a 14-day-old entry in the Grove DB.
    const FOURTEEN_DAYS_AGO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      insertLogEntry({
        timestamp: FOURTEEN_DAYS_AGO,
        level: 'info',
        kind: 'test',
        component: 'test',
        message: 'old-entry',
        data: null,
        session_id: null,
      });
    });

    // Flip to 30 days BEFORE running — entry should survive.
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      daemon: { ...deps.liveConfig.current.daemon, log_retention_days: 30 },
    };

    await pm.find('log-retention').fn();

    const surviving = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT message FROM log_entries WHERE message = 'old-entry'`,
      ).get() as { message: string } | undefined,
    );
    expect(surviving?.message).toBe('old-entry');
  });

  it('deletes entries older than the configured retention window', async () => {
    const deps = buildDeps(fx);
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      daemon: { ...deps.liveConfig.current.daemon, log_retention_days: 7 },
    };
    registerPowerJobs(pm as never, deps);

    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      insertLogEntry({
        timestamp: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        level: 'info',
        kind: 'test',
        component: 'test',
        message: 'old-entry',
        data: null,
        session_id: null,
      });
    });

    await pm.find('log-retention').fn();

    const surviving = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM log_entries WHERE message = 'old-entry'`,
      ).get() as { n: number },
    );
    expect(surviving.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// auto-backup — relocates to <groveHome>/backups
// ---------------------------------------------------------------------------

describe('auto-backup power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('writes <machineId>__<ts>.sql under <groveHome>/backups by default', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('auto-backup').fn();
    const dir = path.join(fx.mycoHome, 'groves', fx.grove.id, 'backups');
    const files = fs.readdirSync(dir).filter((f) => /^test-machine__[0-9]+\.sql$/.test(f));
    expect(files.length).toBe(1);
  });

  it('writes under <backup.dir>/<groveSlug>/ when backup.dir is set', async () => {
    const customRoot = path.join(fx.workDir, 'custom-backups');
    // backup.dir is a Grove-tier setting; write it to the Grove's config
    // (where the backup domain reads it), not the boot-time liveConfig.
    const cfg = loadGroveConfig(fx.grove.id, fx.mycoHome);
    saveGroveConfig(
      fx.grove.id,
      { ...cfg, backup: { ...cfg.backup, dir: customRoot } },
      fx.mycoHome,
    );
    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('auto-backup').fn();
    const dir = path.join(customRoot, fx.grove.slug);
    const files = fs.readdirSync(dir).filter((f) => /^test-machine__[0-9]+\.sql$/.test(f));
    expect(files.length).toBe(1);
  });

  // Locks in the bug fix at db89073d: the auto-backup job must check the
  // age of the most recent <machineId>__<ts>.sql for this machine and skip
  // when it is younger than `backup.auto_interval_hours`. Without the
  // gate, every idle/sleep tick burns a retention slot. Mirrors the
  // `database-optimize` "skips when interval has not elapsed" pattern.
  it('skips backup when interval has not elapsed since last run', async () => {
    const deps = buildDeps(fx);
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      backup: {
        retention: { keep_daily: 14, keep_weekly: 8 },
        auto_interval_hours: 24,
      },
    };
    registerPowerJobs(pm as never, deps);

    // First invocation creates a fresh backup file.
    await pm.find('auto-backup').fn();
    const dir = path.join(fx.mycoHome, 'groves', fx.grove.id, 'backups');
    const matcher = /^test-machine__[0-9]+\.sql$/;
    const firstFiles = fs.readdirSync(dir).filter((f) => matcher.test(f));
    expect(firstFiles.length).toBe(1);

    // Second invocation within auto_interval_hours must be a no-op:
    // no new backup file should appear.
    await pm.find('auto-backup').fn();
    const secondFiles = fs.readdirSync(dir).filter((f) => matcher.test(f));
    expect(secondFiles.length).toBe(1);
    expect(secondFiles[0]).toBe(firstFiles[0]);
  });
});

// ---------------------------------------------------------------------------
// database-integrity-check — slow weekly sweep, gated by interval
// ---------------------------------------------------------------------------

describe('database-integrity-check power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('runs in sleep state only', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('database-integrity-check');
    expect(job.runIn).toEqual(['sleep']);
  });

  it('writes an integrity_check log row when no prior run exists', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('database-integrity-check').fn();
    const row = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM log_entries
          WHERE kind IN (?, ?)`,
      ).get(LOG_KINDS.DATABASE_INTEGRITY_CHECK, LOG_KINDS.DATABASE_INTEGRITY_ISSUES) as { n: number },
    );
    expect(row.n).toBeGreaterThan(0);
  });

  it('skips when toggle is disabled', async () => {
    const deps = buildDeps(fx);
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      maintenance: {
        ...deps.liveConfig.current.maintenance,
        auto_integrity_check: false,
      },
    };
    registerPowerJobs(pm as never, deps);
    await pm.find('database-integrity-check').fn();
    const row = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM log_entries
          WHERE kind IN (?, ?)`,
      ).get(LOG_KINDS.DATABASE_INTEGRITY_CHECK, LOG_KINDS.DATABASE_INTEGRITY_ISSUES) as { n: number },
    );
    expect(row.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-Grove fan-out — each registered Grove gets its own backup file
// ---------------------------------------------------------------------------

describe('Grove-DB fan-out — auto-backup', () => {
  let fx: GroveFixture;
  let secondGrove: GroveRecord;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    secondGrove = createGrove('Second', fx.mycoHome);
    ensureGroveDatabase(secondGrove.id, fx.mycoHome);
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('writes one timestamped backup per Grove under each Grove\'s backups/ dir', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('auto-backup').fn();
    const firstDir = path.join(fx.mycoHome, 'groves', fx.grove.id, 'backups');
    const secondDir = path.join(fx.mycoHome, 'groves', secondGrove.id, 'backups');
    const matcher = /^test-machine__[0-9]+\.sql$/;
    expect(fs.readdirSync(firstDir).filter((f) => matcher.test(f)).length).toBe(1);
    expect(fs.readdirSync(secondDir).filter((f) => matcher.test(f)).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// session-maintenance — per-Grove project lookup for vault cleanup
// ---------------------------------------------------------------------------

describe('canopy-background-scan power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('registers a canopy-background-scan job that runs in active/idle/sleep', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('canopy-background-scan');
    expect(job.runIn).toEqual(['active', 'idle', 'sleep']);
  });

  it('dispatches per-project runners for every registered project when enabled', async () => {
    const projectRootA = path.join(fx.workDir, 'projects', 'a');
    const projectRootB = path.join(fx.workDir, 'projects', 'b');
    fs.mkdirSync(resolveProjectVaultDir(projectRootA), { recursive: true });
    fs.mkdirSync(resolveProjectVaultDir(projectRootB), { recursive: true });
    // Minimal myco.yaml so loadMergedConfig succeeds — the canopy scan is
    // fail-closed (skips on unreadable config), like canopy-inject.
    fs.writeFileSync(path.join(resolveProjectVaultDir(projectRootA), 'myco.yaml'), 'version: 3\n');
    fs.writeFileSync(path.join(resolveProjectVaultDir(projectRootB), 'myco.yaml'), 'version: 3\n');
    fs.writeFileSync(path.join(projectRootA, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(projectRootB, 'b.ts'), 'export const b = 1;\n');
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'aaaa111122223333aaaa111122223333',
      projectName: 'a',
      projectRoot: projectRootA,
    }, fx.mycoHome);
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'bbbb111122223333bbbb111122223333',
      projectName: 'b',
      projectRoot: projectRootB,
    }, fx.mycoHome);

    const deps = buildDeps(fx);
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      cortex: {
        ...(deps.liveConfig.current as { cortex: Record<string, unknown> }).cortex,
        canopy: {
          refresh: { background_enabled: true, background_period_minutes: 1 },
          exclude: { default_patterns: [], patterns: [] },
        },
      },
    };
    registerPowerJobs(pm as never, deps);

    await pm.find('canopy-background-scan').fn();

    // Each registered project should have at least one canopy entry after
    // the dispatch ran its delta scan against the project root.
    const counts = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT project_id, COUNT(*) AS n FROM canopy_entries GROUP BY project_id`,
      ).all() as Array<{ project_id: string; n: number }>,
    );
    expect(counts.length).toBe(2);
    for (const row of counts) {
      expect(row.n).toBeGreaterThan(0);
    }
  });

  it('skips dispatch when background is disabled', async () => {
    const projectRoot = path.join(fx.workDir, 'projects', 'a');
    fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'a.ts'), 'export const a = 1;\n');
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'aaaa111122223333aaaa111122223333',
      projectName: 'a',
      projectRoot,
    }, fx.mycoHome);

    const deps = buildDeps(fx);
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      cortex: {
        ...(deps.liveConfig.current as { cortex: Record<string, unknown> }).cortex,
        canopy: {
          refresh: { background_enabled: false, background_period_minutes: 60 },
          exclude: { default_patterns: [], patterns: [] },
        },
      },
    };
    registerPowerJobs(pm as never, deps);

    await pm.find('canopy-background-scan').fn();

    const count = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM canopy_entries`,
      ).get() as { n: number },
    );
    expect(count.n).toBe(0);
  });

  it('skips per-project scan when project cortex.canopy.enabled is false', async () => {
    const projectRoot = path.join(fx.workDir, 'projects', 'a');
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(
      path.join(vaultDir, 'myco.yaml'),
      'version: 3\ncortex:\n  canopy:\n    enabled: false\n',
    );
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'aaaa111122223333aaaa111122223333',
      projectName: 'a',
      projectRoot,
    }, fx.mycoHome);

    const deps = buildDeps(fx);
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      cortex: {
        ...(deps.liveConfig.current as { cortex: Record<string, unknown> }).cortex,
        canopy: {
          refresh: { background_enabled: true, background_period_minutes: 1 },
          exclude: { default_patterns: [], patterns: [] },
        },
      },
    };
    registerPowerJobs(pm as never, deps);

    await pm.find('canopy-background-scan').fn();

    const count = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM canopy_entries`,
      ).get() as { n: number },
    );
    expect(count.n).toBe(0);
  });
});

describe('session-maintenance power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;
  let projectRoot: string;
  let projectVaultDir: string;
  const PROJECT_ID = 'proj_' + 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';

  beforeEach(() => {
    fx = setupGrove();
    projectRoot = path.join(fx.workDir, 'projects', 'p1');
    projectVaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(projectVaultDir, { recursive: true });
    registerProjectInGrove(fx.grove.id, {
      projectId: PROJECT_ID,
      projectName: 'p1',
      projectRoot,
    }, fx.mycoHome);
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('completes a stale active session in the Grove DB on the next tick', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));

    // Insert a session whose last activity is two hours ago (stale window
    // is one hour by default in buildDeps), tied to our registered project.
    // Seed matching prompt_batches rows so the post-R4.18 derived count in
    // `findDeadSessionIds` agrees that this session has captured work —
    // otherwise it'd be flagged dead and deleted right after the
    // stale-active sweep marks it completed.
    const twoHoursAgoSec = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO sessions (id, project_id, status, started_at, created_at, prompt_count, machine_id, agent)
         VALUES ('sess-stale', ?, 'active', ?, ?, 5, 'test-machine', 'claude_code')`,
      ).run(PROJECT_ID, twoHoursAgoSec, twoHoursAgoSec);
      const insertBatch = db.prepare(
        `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
         VALUES (?, ?, ?, ?, 'active')`,
      );
      for (let i = 1; i <= 5; i++) insertBatch.run('sess-stale', i, twoHoursAgoSec, twoHoursAgoSec);
    });

    await pm.find('session-maintenance').fn();

    const updated = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      getDatabase().prepare(
        `SELECT status FROM sessions WHERE id = 'sess-stale'`,
      ).get() as { status: string } | undefined,
    );
    expect(updated?.status).toBe('completed');
  });
});
