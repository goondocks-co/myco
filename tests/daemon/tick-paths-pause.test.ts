/**
 * Tick-driven sweeps must honor the per-project pause primitive.
 *
 * Three call sites fan out across registered projects with project-DB
 * writes:
 * - STAGING_GC PowerJob (`power-jobs.ts`).
 * - Canopy `dispatchBackground` PowerJob (`power-jobs.ts`).
 * - Initial Canopy populate fan-out at startup (`main.ts`).
 *
 * Each must skip a project under an active pause so the lock-holder
 * (move/vacuum) keeps its exclusive view. The scheduler path is covered
 * separately in `scheduler-pause.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase, closeDatabase, getDatabase, withDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { registerPowerJobs, type PowerJobDeps } from '@myco/daemon/power-jobs.js';
import { runInitialCanopyPopulateAcrossProjects } from '@myco/daemon/main.js';
import { writeStagedSkill, stagingRoot } from '@myco/agent/tools/skill-staging.js';
import { GroveRuntimeCache, type EmbeddingRuntimeFactory } from '@myco/daemon/grove-runtime-cache.js';
import {
  createGrove,
  pauseProject,
  registerProjectInGrove,
  clearGroveRegistryCaches,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import type { CanopyJobsRegistry } from '@myco/daemon/jobs/canopy-scan.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  workDir: string;
  mycoHome: string;
  grove: GroveRecord;
  databasePath: string;
  cache: GroveRuntimeCache;
  logger: DaemonLogger;
  factory: EmbeddingRuntimeFactory;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tick-pause-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const previousMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();

  const logger = new DaemonLogger(path.join(workDir, 'logs'), { level: 'info' });
  const grove = createGrove('Solo', mycoHome);
  ensureGroveDatabase(grove.id, mycoHome);
  const databasePath = resolveGroveDbPath(grove.id, mycoHome);
  initDatabase(databasePath);
  createSchema(getDatabase());

  const cache = new GroveRuntimeCache();
  const factory: EmbeddingRuntimeFactory = () => ({
    vectorStore: { close() {} } as never,
    embeddingManager: { totalPendingCount: () => 0, reconcile: vi.fn() } as never,
  });
  cache.getEmbeddingRuntime(databasePath, factory);

  return {
    workDir,
    mycoHome,
    grove,
    databasePath,
    cache,
    logger,
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

class FakePowerManager {
  jobs: Array<{
    name: string;
    runIn: string[];
    fn: () => Promise<void>;
    preventsDeepSleep?: () => boolean;
  }> = [];
  register(job: { name: string; runIn: string[]; fn: () => Promise<void>; preventsDeepSleep?: () => boolean }) {
    this.jobs.push(job);
  }
  find(name: string) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error('job not found: ' + name);
    return job;
  }
}

function buildDeps(fx: Fixture, configOverrides: Record<string, unknown> = {}): PowerJobDeps {
  const liveConfig = {
    current: {
      daemon: { log_retention_days: 30, stale_session_threshold_ms: 60 * 60 * 1000 },
      backup: { retention: { keep_daily: 14, keep_weekly: 8 } },
      maintenance: {
        auto_optimize: false,
        auto_optimize_interval_hours: 24,
        auto_integrity_check: false,
        auto_integrity_check_interval_hours: 168,
      },
      cortex: {
        instructions: { inject_on_session_start: true },
        canopy: {
          refresh: { background_enabled: true, background_period_minutes: 1 },
          exclude: { default_patterns: [], patterns: [] },
        },
      },
      embedding: { run_in_deep_sleep: true },
      ...configOverrides,
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
  };
}

const PROJECT_PAUSED = 'proj_' + 'aaaa111122223333aaaa111122223333';
const PROJECT_LIVE = 'proj_' + 'bbbb111122223333bbbb111122223333';

function setupTwoProjects(fx: Fixture): { vaultPaused: string; vaultLive: string } {
  const rootPaused = path.join(fx.workDir, 'projects', 'paused');
  const rootLive = path.join(fx.workDir, 'projects', 'live');
  const vaultPaused = resolveProjectVaultDir(rootPaused);
  const vaultLive = resolveProjectVaultDir(rootLive);
  fs.mkdirSync(vaultPaused, { recursive: true });
  fs.mkdirSync(vaultLive, { recursive: true });
  fs.writeFileSync(path.join(rootPaused, 'p.ts'), 'export const p = 1;\n');
  fs.writeFileSync(path.join(rootLive, 'l.ts'), 'export const l = 1;\n');
  registerProjectInGrove(fx.grove.id, {
    projectId: PROJECT_PAUSED,
    projectName: 'paused',
    projectRoot: rootPaused,
  }, fx.mycoHome);
  registerProjectInGrove(fx.grove.id, {
    projectId: PROJECT_LIVE,
    projectName: 'live',
    projectRoot: rootLive,
  }, fx.mycoHome);
  return { vaultPaused, vaultLive };
}

// ---------------------------------------------------------------------------
// STAGING_GC
// ---------------------------------------------------------------------------

describe('STAGING_GC honors the project pause primitive', () => {
  let fx: Fixture;
  let pm: FakePowerManager;

  beforeEach(() => { fx = setupFixture(); pm = new FakePowerManager(); });
  afterEach(() => fx.cleanup());

  it('skips a paused project and processes the unpaused one', async () => {
    const { vaultPaused, vaultLive } = setupTwoProjects(fx);

    // Stage a stale skill in both projects so a sweep would clean them.
    writeStagedSkill(vaultPaused, 'p-stale', 'old');
    writeStagedSkill(vaultLive, 'l-stale', 'old');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.resolve(stagingRoot(vaultPaused), 'p-stale'), old, old);
    fs.utimesSync(path.resolve(stagingRoot(vaultLive), 'l-stale'), old, old);

    pauseProject(fx.grove.id, PROJECT_PAUSED, 'grove-move', 'op-1', fx.mycoHome);

    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('staging-gc').fn();

    expect(fs.existsSync(path.resolve(stagingRoot(vaultPaused), 'p-stale'))).toBe(true);
    expect(fs.existsSync(path.resolve(stagingRoot(vaultLive), 'l-stale'))).toBe(false);
  });

  it('processes both projects when neither is paused', async () => {
    const { vaultPaused, vaultLive } = setupTwoProjects(fx);

    writeStagedSkill(vaultPaused, 'p-stale', 'old');
    writeStagedSkill(vaultLive, 'l-stale', 'old');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.resolve(stagingRoot(vaultPaused), 'p-stale'), old, old);
    fs.utimesSync(path.resolve(stagingRoot(vaultLive), 'l-stale'), old, old);

    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('staging-gc').fn();

    expect(fs.existsSync(path.resolve(stagingRoot(vaultPaused), 'p-stale'))).toBe(false);
    expect(fs.existsSync(path.resolve(stagingRoot(vaultLive), 'l-stale'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canopy-background-scan
// ---------------------------------------------------------------------------

describe('canopy-background-scan honors the project pause primitive', () => {
  let fx: Fixture;
  let pm: FakePowerManager;

  beforeEach(() => { fx = setupFixture(); pm = new FakePowerManager(); });
  afterEach(() => fx.cleanup());

  function countCanopyEntriesByProject(): Map<string, number> {
    return withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
      const rows = getDatabase().prepare(
        `SELECT project_id, COUNT(*) AS n FROM canopy_entries GROUP BY project_id`,
      ).all() as Array<{ project_id: string; n: number }>;
      return new Map(rows.map((r) => [r.project_id, r.n]));
    });
  }

  it('skips a paused project on the dispatch tick', async () => {
    setupTwoProjects(fx);
    pauseProject(fx.grove.id, PROJECT_PAUSED, 'grove-move', 'op-1', fx.mycoHome);

    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('canopy-background-scan').fn();

    const counts = countCanopyEntriesByProject();
    expect(counts.get(PROJECT_PAUSED) ?? 0).toBe(0);
    expect((counts.get(PROJECT_LIVE) ?? 0) > 0).toBe(true);
  });

  it('processes both projects when neither is paused', async () => {
    setupTwoProjects(fx);

    registerPowerJobs(pm as never, buildDeps(fx));
    await pm.find('canopy-background-scan').fn();

    const counts = countCanopyEntriesByProject();
    expect((counts.get(PROJECT_PAUSED) ?? 0) > 0).toBe(true);
    expect((counts.get(PROJECT_LIVE) ?? 0) > 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Initial canopy populate (startup fan-out)
// ---------------------------------------------------------------------------

describe('runInitialCanopyPopulateAcrossProjects honors the project pause primitive', () => {
  let fx: Fixture;

  beforeEach(() => { fx = setupFixture(); });
  afterEach(() => fx.cleanup());

  function fakeRegistry(visited: string[]): CanopyJobsRegistry {
    return {
      initialPopulate: async ({ projectId }: { projectId: string }) => {
        visited.push(projectId);
      },
    } as unknown as CanopyJobsRegistry;
  }

  function makeLiveConfig() {
    return {
      current: {
        agent: { cold_project_threshold_days: 0 },
      },
    } as never;
  }

  it('skips a paused project at startup populate', async () => {
    setupTwoProjects(fx);
    pauseProject(fx.grove.id, PROJECT_PAUSED, 'grove-move', 'op-1', fx.mycoHome);

    const visited: string[] = [];
    await runInitialCanopyPopulateAcrossProjects(
      fx.cache,
      fx.logger,
      'test-machine',
      fakeRegistry(visited),
      makeLiveConfig(),
    );

    expect(visited).toContain(PROJECT_LIVE);
    expect(visited).not.toContain(PROJECT_PAUSED);
  });

  it('populates both projects at startup when neither is paused', async () => {
    setupTwoProjects(fx);

    const visited: string[] = [];
    await runInitialCanopyPopulateAcrossProjects(
      fx.cache,
      fx.logger,
      'test-machine',
      fakeRegistry(visited),
      makeLiveConfig(),
    );

    expect(new Set(visited)).toEqual(new Set([PROJECT_PAUSED, PROJECT_LIVE]));
  });
});
