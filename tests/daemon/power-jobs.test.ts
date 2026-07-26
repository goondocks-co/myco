import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase, closeDatabase, getDatabase, withDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { insertLogEntry } from '@myco/db/queries/logs';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { registerPowerJobs, type PowerJobDeps } from '@myco/daemon/power-jobs.js';
import { writeStagedSkill, stagingRoot } from '@myco/agent/tools/skill-staging.js';
import { GroveRuntimeCache, type EmbeddingRuntimeFactory } from '@myco/daemon/grove-runtime-cache.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { loadGroveConfig, loadMachineConfig, saveGroveConfig, saveMachineConfig } from '@myco/config/loader.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { CONTENT_CLAIM_RETENTION_MS, ROUTED_EVENT_DEDUP_RETENTION_MS } from '@myco/constants.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { resolveRoutedTranscriptPath, resolveRoutedTranscriptsDir } from '@myco/grove/paths.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

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
      embedding: { prevent_deep_sleep: true },
      notifications: {
        enabled: true,
        system_notifications: false,
        default_mode: 'summary',
        retention_days: 30,
        domains: {},
      },
      ...(overrides.config as Record<string, unknown> ?? {}),
    },
  };
  return {
    registry: { sessions: new Set<string>() } as never,
    logger: fx.logger,
    liveConfig: liveConfig as never,
    machineId: 'test-machine',
    transcriptMiner: (overrides.transcriptMiner as PowerJobDeps['transcriptMiner'])
      ?? { reconcileAndAttributeResponses: () => ({}) },
    daemonVaultDir: fx.workDir,
    cache: fx.cache,
    embeddingRuntimeFactory: fx.factory,
    mycoHome: fx.mycoHome,
    daemonStateDir: path.join(fx.mycoHome, 'service'),
    lockNamespace: testPerUserLockNamespace,
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
          embedding: { prevent_deep_sleep: true },
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

  it('resolves config via projectTierOptional and completes without error for a project with no working tree', async () => {
    // Team Host shape: the project row is real, but its working tree was
    // checked out on a member machine — this path never existed here.
    const projectRoot = path.join(fx.workDir, 'never-created', 'hosted');
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'cccc111122223333cccc111122223333',
      projectName: 'hosted',
      projectRoot,
    }, fx.mycoHome);

    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('release-provenance-reconcile');
    const errorSpy = vi.spyOn(fx.logger, 'error');

    // Before the projectTierOptional fix this threw "myco.yaml not found",
    // which forEachRegisteredProject's per-project catch turns into a
    // "Project iteration body failed" error log.
    await expect(job.fn()).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(projectRoot)).toBe(false);
  });
});

describe('registerPowerJobs — managed-files-reconcile', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  it('registers a managed-files-reconcile job that runs in active/idle/sleep', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('managed-files-reconcile');
    expect(job.runIn).toEqual(['active', 'idle', 'sleep']);
  });

  it('skips reconciliation and never creates the working tree for a project with no local root', async () => {
    // The host never writes a member's working tree (B1) — and there is no
    // tree here to write to regardless. Before the treeAvailable gate this
    // threw ENOENT trying to write AGENTS.md into a nonexistent directory.
    const projectRoot = path.join(fx.workDir, 'never-created', 'hosted');
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'dddd111122223333dddd111122223333',
      projectName: 'hosted',
      projectRoot,
    }, fx.mycoHome);

    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('managed-files-reconcile');
    const errorSpy = vi.spyOn(fx.logger, 'error');

    await expect(job.fn()).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(projectRoot)).toBe(false);
  });

  it('does not skip a project whose working tree exists', async () => {
    const projectRoot = path.join(fx.workDir, 'projects', 'local');
    const projectVaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(projectVaultDir, { recursive: true });
    fs.writeFileSync(path.join(projectVaultDir, 'myco.yaml'), 'version: 3\n');
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'eeee111122223333eeee111122223333',
      projectName: 'local',
      projectRoot,
    }, fx.mycoHome);

    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('managed-files-reconcile');
    const errorSpy = vi.spyOn(fx.logger, 'error');

    await expect(job.fn()).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
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

  it('hold counts pending work in all Groves in the same home', () => {
    // Home is the boundary; all Groves in the home are probed.
    const secondGrove = createGrove('Dogfood', fx.mycoHome);
    ensureGroveDatabase(secondGrove.id, fx.mycoHome);
    const secondDatabasePath = resolveGroveDbPath(secondGrove.id, fx.mycoHome);

    const managers = new Map<string, { totalPendingCount: () => number; reconcile: ReturnType<typeof vi.fn>; reconcileSlice: ReturnType<typeof vi.fn> }>([
      [fx.databasePath, { totalPendingCount: () => 0, reconcile: vi.fn(async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 })), reconcileSlice: vi.fn(async () => ({ processed: 0, remaining: 0 })) }],
      [secondDatabasePath, { totalPendingCount: () => 5, reconcile: vi.fn(async () => ({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 0 })), reconcileSlice: vi.fn(async () => ({ processed: 0, remaining: 0 })) }],
    ]);
    const factory: EmbeddingRuntimeFactory = (_db, dbPath) => ({
      vectorStore: { close() {} } as never,
      embeddingManager: managers.get(dbPath)! as never,
    });
    fx.cache.getEmbeddingRuntime(secondDatabasePath, factory);

    const deps = buildDeps(fx);
    deps.embeddingRuntimeFactory = factory;
    registerPowerJobs(pm as never, deps);

    const job = pm.find('embedding-reconcile');
    expect(jobHoldsDeepSleep(job)).toBe(true);
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
        embedding: { prevent_deep_sleep: false },
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

describe('notification-retention power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  function seedNotification(id: string, status: string, daysAgo: number): void {
    const createdAt = Math.floor((Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000);
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      getDatabase().prepare(
        `INSERT INTO notifications (
          id, project_id, domain, type, level, title, message, mode, status, link, metadata, created_at
        ) VALUES (?, NULL, 'agents', 'agent.task.success', 'info', ?, NULL, 'summary', ?, NULL, NULL, ?)`,
      ).run(id, id, status, createdAt);
    });
  }

  function notificationCount(id: string): number {
    return withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      (getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM notifications WHERE id = ?`,
      ).get(id) as { n: number }).n,
    );
  }

  function saveMachineRetention(days: number): void {
    const config = loadMachineConfig(fx.mycoHome);
    saveMachineConfig({
      ...config,
      notifications: {
        ...config.notifications,
        retention_days: days,
      },
    }, fx.mycoHome);
  }

  it('registers as idle/sleep housekeeping', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('notification-retention');
    expect(job.runIn).toEqual(['idle', 'sleep']);
    expect(job.kind).toBe('housekeeping');
  });

  it('reads notifications.retention_days from machine config on each run', async () => {
    const deps = buildDeps(fx);
    deps.liveConfig.current = {
      ...deps.liveConfig.current,
      notifications: { ...deps.liveConfig.current.notifications, retention_days: 0 },
    };
    registerPowerJobs(pm as never, deps);

    seedNotification('fourteen-days-old', 'dismissed', 14);

    await pm.find('notification-retention').fn();

    expect(notificationCount('fourteen-days-old')).toBe(1);

    saveMachineRetention(7);

    await pm.find('notification-retention').fn();

    expect(notificationCount('fourteen-days-old')).toBe(0);
  });

  it('deletes old acknowledged notifications and preserves unread/new rows', async () => {
    const deps = buildDeps(fx);
    saveMachineRetention(7);
    registerPowerJobs(pm as never, deps);

    seedNotification('old-read', 'read', 14);
    seedNotification('old-dismissed', 'dismissed', 14);
    seedNotification('old-unread', 'unread', 14);
    seedNotification('new-read', 'read', 1);

    await pm.find('notification-retention').fn();

    expect(notificationCount('old-read')).toBe(0);
    expect(notificationCount('old-dismissed')).toBe(0);
    expect(notificationCount('old-unread')).toBe(1);
    expect(notificationCount('new-read')).toBe(1);
  });
});

describe('content-claim-expiry power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  function seedClaim(id: string, state: 'active' | 'released' | 'published' | 'expired', expiresAt: number): void {
    const now = Math.floor(Date.now() / 1000);
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      getDatabase().prepare(
        `INSERT INTO content_claims (
           id, artifact_kind, artifact_id, generation, project_id,
           claimed_by, claimed_at, expires_at, state, released_at, published_at, machine_id
         ) VALUES (?, 'skill', ?, 1, 'proj_test', 'machine-a', ?, ?, ?, NULL, NULL, 'machine-a')`,
      ).run(id, id, now, expiresAt, state);
    });
  }

  function claimState(id: string): string {
    return withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      (getDatabase().prepare(`SELECT state FROM content_claims WHERE id = ?`).get(id) as { state: string }).state,
    );
  }

  function claimExists(id: string): boolean {
    return withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      !!getDatabase().prepare(`SELECT 1 FROM content_claims WHERE id = ?`).get(id),
    );
  }

  it('registers as active/idle/sleep housekeeping', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('content-claim-expiry');
    expect(job.runIn).toEqual(['active', 'idle', 'sleep']);
    expect(job.kind).toBe('housekeeping');
  });

  it('flips an active claim past its TTL to expired, leaves an unexpired active claim alone', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const now = Math.floor(Date.now() / 1000);
    seedClaim('cclaim_expired', 'active', now - 10);
    seedClaim('cclaim_fresh', 'active', now + 10_000);

    await pm.find('content-claim-expiry').fn();

    expect(claimState('cclaim_expired')).toBe('expired');
    expect(claimState('cclaim_fresh')).toBe('active');
  });

  it('is the backstop for a row that arrives active with expires_at already past (e.g. backup-restore)', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const longPast = Math.floor(Date.now() / 1000) - 999_999;
    seedClaim('cclaim_restored', 'active', longPast);

    await pm.find('content-claim-expiry').fn();

    expect(claimState('cclaim_restored')).toBe('expired');
  });

  it('never touches an already-terminal row', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const now = Math.floor(Date.now() / 1000);
    seedClaim('cclaim_released', 'released', now - 10);

    await pm.find('content-claim-expiry').fn();

    expect(claimState('cclaim_released')).toBe('released');
  });

  it('flips an expired claim AND prunes a terminal row older than retention, keeping a younger one', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const now = Math.floor(Date.now() / 1000);
    const retentionSeconds = Math.floor(CONTENT_CLAIM_RETENTION_MS / 1000);

    seedClaim('cclaim_expiring', 'active', now - 10);
    seedClaim('cclaim_old_released', 'released', now - retentionSeconds - 3600);
    seedClaim('cclaim_young_released', 'released', now - 3600);

    await pm.find('content-claim-expiry').fn();

    expect(claimState('cclaim_expiring')).toBe('expired');
    expect(claimExists('cclaim_old_released')).toBe(false);
    expect(claimExists('cclaim_young_released')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// routed-transcript-cache-gc — consolidation Task C-1
// ---------------------------------------------------------------------------

describe('routed-transcript-cache-gc power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = path.join(fx.workDir, 'team-home');
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fx.cleanup();
  });

  function seedSession(
    id: string,
    status: 'active' | 'completed',
    machineId: string,
    opts: {
      transcriptPath?: string | null;
      startedAt?: number;
      endedAt?: number;
      /**
       * The GC's proof that the final mining pass read the transcript. Defaults
       * to 1 for a completed session — the shape a session that mined
       * successfully at close has. Pass 0 (mining failed) or null (no outcome
       * recorded, e.g. a pre-v74 row) to exercise the unproven guard.
       */
      finalMineOk?: number | null;
    } = {},
  ): void {
    const startedAt = opts.startedAt ?? Math.floor(Date.now() / 1000);
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      upsertSession({
        id,
        agent: 'claude-code',
        started_at: startedAt,
        created_at: startedAt,
        status,
        machine_id: machineId,
        // Completed rows carry ended_at in production (closeSession stamps
        // it) — the GC's quiescence guard compares tree mtimes against it.
        ended_at: opts.endedAt
          ?? (status === 'completed' ? Math.floor(Date.now() / 1000) : null),
        // Default: a stamped transcript source — the shape every routed
        // session that reached a successful Stop substitution has. The GC
        // requires it (no stamp = the completion chokepoint had no mine
        // source, tree kept forever); pass null to exercise that guard.
        transcript_path: opts.transcriptPath === undefined
          ? `/routed/materialized/${id}.jsonl`
          : opts.transcriptPath,
      });
      const minedOk = opts.finalMineOk === undefined
        ? (status === 'completed' ? 1 : null)
        : opts.finalMineOk;
      fx.cache.getDatabase(fx.databasePath)
        .prepare('UPDATE sessions SET final_mine_ok = ? WHERE id = ?')
        .run(minedOk, id);
    });
  }

  /** Materialize a fake cache dir with one dummy transcript file, mirroring
   *  what the C2 materializer would have written. Returns the session dir. */
  function materializeCacheDir(machineId: string, sessionId: string): string {
    const filePath = resolveRoutedTranscriptPath(machineId, sessionId, 'tx_dummy00000000000000000000000');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"type":"assistant"}\n');
    return path.dirname(filePath);
  }

  /** Back-date every mtime under a session cache dir (files + the dir
   *  itself) so the tree reads as append-quiescent: newest write older than
   *  the quiescence window AND predating the session's completion time. */
  function ageCacheDir(machineId: string, sessionId: string, ageMs: number): void {
    const dir = path.join(resolveRoutedTranscriptsDir(), machineId, sessionId);
    const t = new Date(Date.now() - ageMs);
    for (const name of fs.readdirSync(dir)) {
      fs.utimesSync(path.join(dir, name), t, t);
    }
    fs.utimesSync(dir, t, t);
  }

  /** 10 min: past the 5-min quiescence window with margin. */
  const QUIET_AGE_MS = 10 * 60 * 1000;

  function cacheDirExists(machineId: string, sessionId: string): boolean {
    return fs.existsSync(path.join(resolveRoutedTranscriptsDir(), machineId, sessionId));
  }

  it('registers a routed-transcript-cache-gc job that runs in idle and sleep', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('routed-transcript-cache-gc');
    expect(job.runIn).toEqual(['idle', 'sleep']);
    expect(job.kind).toBe('housekeeping');
  });

  it('is a no-op when the cache root does not exist yet', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    await expect(pm.find('routed-transcript-cache-gc').fn()).resolves.toBeUndefined();
  });

  it('prunes a fully-mined, session-terminal, append-quiescent session\'s cache tree', async () => {
    seedSession('sess-done', 'completed', 'member_aaaa1111');
    materializeCacheDir('member_aaaa1111', 'sess-done');
    ageCacheDir('member_aaaa1111', 'sess-done', QUIET_AGE_MS);
    registerPowerJobs(pm as never, buildDeps(fx));

    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_aaaa1111', 'sess-done')).toBe(false);
  });

  it('never touches an in-flight (active) session\'s cache tree', async () => {
    seedSession('sess-active', 'active', 'member_bbbb2222');
    materializeCacheDir('member_bbbb2222', 'sess-active');
    ageCacheDir('member_bbbb2222', 'sess-active', QUIET_AGE_MS); // quiet, but status refuses
    registerPowerJobs(pm as never, buildDeps(fx));

    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_bbbb2222', 'sess-active')).toBe(true);
  });

  it('leaves an orphaned cache directory alone when no session row matches anywhere', async () => {
    materializeCacheDir('member_cccc3333', 'sess-unknown');
    ageCacheDir('member_cccc3333', 'sess-unknown', QUIET_AGE_MS); // quiet, but no owning row
    registerPowerJobs(pm as never, buildDeps(fx));

    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_cccc3333', 'sess-unknown')).toBe(true);
  });

  it('never deletes on a machine_id mismatch between the row and the directory (defense in depth)', async () => {
    // A completed session row exists under this id, but for a DIFFERENT
    // machine than the directory's own path — must never be treated as the
    // directory's owner.
    seedSession('sess-mismatch', 'completed', 'member_real0000');
    materializeCacheDir('member_spoofed1', 'sess-mismatch');
    ageCacheDir('member_spoofed1', 'sess-mismatch', QUIET_AGE_MS); // quiet, but mismatch refuses
    registerPowerJobs(pm as never, buildDeps(fx));

    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_spoofed1', 'sess-mismatch')).toBe(true);
  });

  it('prunes multiple terminal trees and leaves multiple in-flight trees alone in one pass', async () => {
    seedSession('sess-done-1', 'completed', 'member_aaaa1111');
    seedSession('sess-done-2', 'completed', 'member_aaaa1111');
    seedSession('sess-active-1', 'active', 'member_aaaa1111');
    materializeCacheDir('member_aaaa1111', 'sess-done-1');
    materializeCacheDir('member_aaaa1111', 'sess-done-2');
    materializeCacheDir('member_aaaa1111', 'sess-active-1');
    ageCacheDir('member_aaaa1111', 'sess-done-1', QUIET_AGE_MS);
    ageCacheDir('member_aaaa1111', 'sess-done-2', QUIET_AGE_MS);
    ageCacheDir('member_aaaa1111', 'sess-active-1', QUIET_AGE_MS);
    registerPowerJobs(pm as never, buildDeps(fx));

    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_aaaa1111', 'sess-done-1')).toBe(false);
    expect(cacheDirExists('member_aaaa1111', 'sess-done-2')).toBe(false);
    expect(cacheDirExists('member_aaaa1111', 'sess-active-1')).toBe(true);
  });

  it('never prunes a completed session with NO stamped transcript_path (no mine source at close — tree kept)', async () => {
    // A routed session that never got a successful Stop substitution
    // (degraded-missing throughout, or no Stop at all) completes with
    // transcript_path NULL — the completion chokepoint had nothing to mine
    // against, so the tree may hold unmined bytes. The GC must keep it.
    seedSession('sess-no-stamp', 'completed', 'member_dddd4444', { transcriptPath: null });
    materializeCacheDir('member_dddd4444', 'sess-no-stamp');
    ageCacheDir('member_dddd4444', 'sess-no-stamp', QUIET_AGE_MS); // quiet — only the stamp refuses
    registerPowerJobs(pm as never, buildDeps(fx));

    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_dddd4444', 'sess-no-stamp')).toBe(true);
  });

  it('late-append TOCTOU: refuses while the tree holds writes at/after completion or fresh writes; prunes once quiet with all bytes predating completion', async () => {
    // The reviewer's worst case: session completed (and mined) an hour ago;
    // the member reconnects and the drain backstop pushes tail bytes — a
    // pure offset append that touches NO sessions row, fires no event, and
    // triggers no re-mine. The fresh write must refuse the prune.
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
    seedSession('sess-late-append', 'completed', 'member_ffff6666', { endedAt: anHourAgo });
    const dir = materializeCacheDir('member_ffff6666', 'sess-late-append');
    // The materialize write IS the late append: mtime ≈ now >= ended_at.
    registerPowerJobs(pm as never, buildDeps(fx));

    await pm.find('routed-transcript-cache-gc').fn();
    expect(cacheDirExists('member_ffff6666', 'sess-late-append')).toBe(true); // refusal while fresh

    // No re-mining machinery — the refusal alone is the guard. The tree
    // prunes only once a future pass finds it QUIET with every write
    // predating completion (here: back-dated to 2h ago, before ended_at
    // and far past the quiescence window).
    ageCacheDir('member_ffff6666', 'sess-late-append', 2 * 3600 * 1000);
    await pm.find('routed-transcript-cache-gc').fn();
    expect(cacheDirExists('member_ffff6666', 'sess-late-append')).toBe(false); // prune once quiet
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses to prune within the quiescence window even when every write predates completion', async () => {
    // Freshly-completed session: writes predate ended_at, but the newest is
    // still inside the quiescence window of now — an append could be in
    // flight (clock precision, a racing drain). Prune-only-when-quiet.
    seedSession('sess-fresh-quiet', 'completed', 'member_gggg7777');
    materializeCacheDir('member_gggg7777', 'sess-fresh-quiet');
    // 2 min old: before ended_at (now) but inside the 5-min window.
    ageCacheDir('member_gggg7777', 'sess-fresh-quiet', 2 * 60 * 1000);
    registerPowerJobs(pm as never, buildDeps(fx));

    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_gggg7777', 'sess-fresh-quiet')).toBe(true);
  });

  it('stale-sweep completion mines the unmined tail through the chokepoint, and only then may GC prune (the reviewer-caught failure case)', async () => {
    // Failure mode this pins: member crashes mid-turn → no Stop/SessionEnd →
    // the stale sweep completes the session. Pre-fix, that flip ran NO
    // mining pass, and the GC — trusting "completed implies mined" — deleted
    // the host's only transcript copy with the tail unmined. Now the sweep
    // routes through completeSessionWithMining: the miner sees the stamped
    // (host-materialized) transcript BEFORE the status flip, and only then
    // does the GC prune the tree.
    const staleStart = Math.floor(Date.now() / 1000) - 2 * 3600; // 2h ago > 60min threshold
    const materializedDir = materializeCacheDir('member_eeee5555', 'sess-crashed');
    const materializedFile = path.join(materializedDir, 'tx_dummy00000000000000000000000.jsonl');
    seedSession('sess-crashed', 'active', 'member_eeee5555', {
      transcriptPath: materializedFile,
      startedAt: staleStart,
    });
    // One OLD prompt batch: keeps the session stale (batch beyond threshold)
    // but NOT "dead" (dead = zero batches → cascade delete in the same
    // maintenance run, which is not this test's subject).
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      getDatabase().prepare(
        `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
         VALUES ('sess-crashed', 1, ?, ?, 'active')`,
      ).run(staleStart, staleStart);
    });

    const minerCalls: Array<{ sessionId: string; agent: string; transcriptPath: string }> = [];
    registerPowerJobs(pm as never, buildDeps(fx, {
      transcriptMiner: {
        reconcileAndAttributeResponses(sessionId: string, input: { agent: string; transcriptPath: string }) {
          minerCalls.push({ sessionId, ...input });
          return { readTranscript: true }; // the transcript was readable and mined
        },
      },
    }));

    // The stale sweep (session-maintenance job) completes the crashed
    // session — routing through the completion chokepoint, which mines the
    // stamped transcript first.
    await pm.find('session-maintenance').fn();
    expect(minerCalls).toEqual([{
      sessionId: 'sess-crashed',
      agent: 'claude-code',
      transcriptPath: materializedFile,
    }]);
    const status = withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      (getDatabase().prepare(`SELECT status FROM sessions WHERE id = 'sess-crashed'`).get() as { status: string }).status,
    );
    expect(status).toBe('completed');

    // Immediately after completion the tree is NOT provably quiet (its
    // newest write is within the quiescence window and at/around ended_at)
    // — the GC must refuse this pass.
    await pm.find('routed-transcript-cache-gc').fn();
    expect(cacheDirExists('member_eeee5555', 'sess-crashed')).toBe(true);

    // Once quiet — every write back-dated to before completion and past the
    // quiescence window — completed AND mined AND quiet allows the prune.
    ageCacheDir('member_eeee5555', 'sess-crashed', QUIET_AGE_MS);
    await pm.find('routed-transcript-cache-gc').fn();
    expect(cacheDirExists('member_eeee5555', 'sess-crashed')).toBe(false);
  });

  it('never prunes when the final mining pass could not read the transcript', async () => {
    // The permanent-loss path: the transcript was unreadable at close (EACCES,
    // fd exhaustion, a lock), so mining returned nothing. Status still flips to
    // completed — a session must never be stranded active — but the tree holds
    // the only copy of content that never reached the DB, so it must survive.
    materializeCacheDir('member_ffff6666', 'sess-unmined');
    seedSession('sess-unmined', 'completed', 'member_ffff6666', { finalMineOk: 0 });
    ageCacheDir('member_ffff6666', 'sess-unmined', QUIET_AGE_MS);

    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_ffff6666', 'sess-unmined')).toBe(true);
  });

  it('never prunes a completed row that predates the mining-proof column', async () => {
    // A row completed by an older binary carries no outcome at all. Unproven is
    // not provable, so the bytes stay.
    materializeCacheDir('member_ffff6666', 'sess-legacy');
    seedSession('sess-legacy', 'completed', 'member_ffff6666', { finalMineOk: null });
    ageCacheDir('member_ffff6666', 'sess-legacy', QUIET_AGE_MS);

    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('routed-transcript-cache-gc').fn();

    expect(cacheDirExists('member_ffff6666', 'sess-legacy')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// routed-event-dedup-prune — consolidation Task C-1
// ---------------------------------------------------------------------------

describe('routed-event-dedup-prune power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  function seedDedupRow(eventId: string, createdAtSeconds: number): void {
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      getDatabase().prepare(
        `INSERT INTO routed_event_dedup (event_id, machine_id, kind, prompt_batch_id, created_at)
         VALUES (?, 'machine-a', 'user_prompt', NULL, ?)`,
      ).run(eventId, createdAtSeconds);
    });
  }

  function dedupExists(eventId: string): boolean {
    return withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      !!getDatabase().prepare(`SELECT 1 FROM routed_event_dedup WHERE event_id = ?`).get(eventId),
    );
  }

  it('registers as idle/sleep housekeeping', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('routed-event-dedup-prune');
    expect(job.runIn).toEqual(['idle', 'sleep']);
    expect(job.kind).toBe('housekeeping');
  });

  it('prunes a dedup row older than the retention window, keeps a younger one', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const now = Math.floor(Date.now() / 1000);
    const retentionSeconds = Math.floor(ROUTED_EVENT_DEDUP_RETENTION_MS / 1000);

    seedDedupRow('machine-a:old-event', now - retentionSeconds - 3600);
    seedDedupRow('machine-a:young-event', now - 3600);

    await pm.find('routed-event-dedup-prune').fn();

    expect(dedupExists('machine-a:old-event')).toBe(false);
    expect(dedupExists('machine-a:young-event')).toBe(true);
  });

  it('never touches a row inside the retention window', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const now = Math.floor(Date.now() / 1000);

    seedDedupRow('machine-a:fresh-event', now - 10);

    await pm.find('routed-event-dedup-prune').fn();

    expect(dedupExists('machine-a:fresh-event')).toBe(true);
  });

  it('is a no-op when no rows are old enough to prune', async () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    await expect(pm.find('routed-event-dedup-prune').fn()).resolves.toBeUndefined();
  });
});

describe('agent-run-retention power job', () => {
  let fx: GroveFixture;
  let pm: FakeJobRunner;

  beforeEach(() => {
    fx = setupGrove();
    pm = new FakeJobRunner();
  });

  afterEach(() => fx.cleanup());

  function ensureAgent(): void {
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      registerAgent({
        id: 'agent-retention-test',
        name: 'Agent Retention Test',
        created_at: Math.floor(Date.now() / 1000),
      });
    });
  }

  function seedRun(id: string, status: string, daysAgo: number, resumable = 0): void {
    const completedAt = Math.floor((Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000);
    withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      insertRun({
        id,
        agent_id: 'agent-retention-test',
        task: 'retention-test',
        status,
        resumable,
        started_at: completedAt - 5,
        completed_at: status === 'running' || status === 'pending' ? null : completedAt,
      });
    });
  }

  function runCount(id: string): number {
    return withDatabase(fx.cache.getDatabase(fx.databasePath), () =>
      (getDatabase().prepare(
        `SELECT COUNT(*) AS n FROM agent_runs WHERE id = ?`,
      ).get(id) as { n: number }).n,
    );
  }

  function saveRunRetention(days: number): void {
    const config = loadGroveConfig(fx.grove.id, fx.mycoHome);
    saveGroveConfig(fx.grove.id, {
      ...config,
      agent: {
        ...config.agent,
        run_retention_days: days,
      },
    }, fx.mycoHome);
  }

  it('registers as idle/sleep housekeeping', () => {
    registerPowerJobs(pm as never, buildDeps(fx));
    const job = pm.find('agent-run-retention');
    expect(job.runIn).toEqual(['idle', 'sleep']);
    expect(job.kind).toBe('housekeeping');
  });

  it('reads agent.run_retention_days from Grove config on each run', async () => {
    ensureAgent();
    registerPowerJobs(pm as never, buildDeps(fx));

    seedRun('fourteen-days-old', 'completed', 14);

    await pm.find('agent-run-retention').fn();

    expect(runCount('fourteen-days-old')).toBe(1);

    saveRunRetention(7);

    await pm.find('agent-run-retention').fn();

    expect(runCount('fourteen-days-old')).toBe(0);
  });

  it('deletes old terminal non-resumable runs and preserves active or resumable rows', async () => {
    ensureAgent();
    saveRunRetention(7);
    registerPowerJobs(pm as never, buildDeps(fx));

    seedRun('old-completed', 'completed', 14);
    seedRun('old-failed', 'failed', 14);
    seedRun('old-skipped', 'skipped', 14);
    seedRun('old-resumable', 'failed', 14, 1);
    seedRun('old-running', 'running', 14);
    seedRun('new-completed', 'completed', 1);

    await pm.find('agent-run-retention').fn();

    expect(runCount('old-completed')).toBe(0);
    expect(runCount('old-failed')).toBe(0);
    expect(runCount('old-skipped')).toBe(0);
    expect(runCount('old-resumable')).toBe(1);
    expect(runCount('old-running')).toBe(1);
    expect(runCount('new-completed')).toBe(1);
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

  it('skips the scan without error for a project with no local working tree', async () => {
    // Before the treeAvailable gate, a missing project root either threw
    // ENOENT walking the tree (surfacing as a CANOPY_ERROR log every tick)
    // or, incidentally, skipped only because the (now-degraded)
    // loadMergedConfig call threw first. Either way this must be a clean,
    // silent skip — not tested by an exception path.
    const projectRoot = path.join(fx.workDir, 'never-created', 'hosted');
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'ffff111122223333ffff111122223333',
      projectName: 'hosted',
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
    const errorSpy = vi.spyOn(fx.logger, 'error');

    await expect(pm.find('canopy-background-scan').fn()).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
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
