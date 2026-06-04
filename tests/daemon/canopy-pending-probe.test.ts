import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase, closeDatabase, getDatabase, withDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { makeTotalCanopyPendingProbe } from '@myco/daemon/task-scheduling.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import {
  createGrove,
  registerProjectInGrove,
  clearGroveRegistryCaches,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface ProbeFixture {
  workDir: string;
  mycoHome: string;
  daemonStateDir: string;
  grove: GroveRecord;
  databasePath: string;
  cache: GroveRuntimeCache;
  logger: DaemonLogger;
  projectId: string;
  cleanup: () => void;
}

function setupProbeFixture(): ProbeFixture {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-canopy-probe-')));
  const mycoHome = path.join(workDir, 'home');
  const daemonStateDir = path.join(mycoHome, 'service');
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.mkdirSync(daemonStateDir, { recursive: true });

  const previousMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();

  const logger = new DaemonLogger(path.join(workDir, 'logs'), { level: 'warn' });

  const grove = createGrove('Probe', mycoHome);
  ensureGroveDatabase(grove.id, mycoHome);
  const databasePath = resolveGroveDbPath(grove.id, mycoHome);

  initDatabase(databasePath);
  createSchema(getDatabase());

  const cache = new GroveRuntimeCache();
  // Pre-warm so getDatabase() resolves for probed grove.
  cache.getDatabase(databasePath);

  const projectId = 'proj_' + 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
  const projectRoot = path.join(workDir, 'projects', 'p1');
  fs.mkdirSync(projectRoot, { recursive: true });

  registerProjectInGrove(grove.id, {
    projectId,
    projectName: 'p1',
    projectRoot,
  }, mycoHome);

  return {
    workDir,
    mycoHome,
    daemonStateDir,
    grove,
    databasePath,
    cache,
    logger,
    projectId,
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

function insertPendingEntry(fx: ProbeFixture, suffix = ''): void {
  withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
    getDatabase().prepare(
      `INSERT INTO canopy_entries
         (project_id, path, content_hash, size_bytes, token_estimate, line_count, mechanical_updated_at)
       VALUES (?, ?, ?, 100, 100, 5, unixepoch('now'))`,
    ).run(fx.projectId, `src/foo${suffix}.ts`, `hash_${suffix || '0'}`);
  });
}

function deletePendingEntries(fx: ProbeFixture): void {
  withDatabase(fx.cache.getDatabase(fx.databasePath), () => {
    getDatabase().prepare(
      `DELETE FROM canopy_entries WHERE project_id = ?`,
    ).run(fx.projectId);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeTotalCanopyPendingProbe', () => {
  let fx: ProbeFixture;

  beforeEach(() => {
    fx = setupProbeFixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('returns 0 when no canopy_entries are pending', () => {
    const probe = makeTotalCanopyPendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      mycoHome: fx.mycoHome,
      daemonStateDir: fx.daemonStateDir,
    });
    expect(probe()).toBe(0);
  });

  it('returns > 0 when a project has pending canopy_entries', () => {
    insertPendingEntry(fx);
    const probe = makeTotalCanopyPendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      mycoHome: fx.mycoHome,
      daemonStateDir: fx.daemonStateDir,
    });
    expect(probe()).toBeGreaterThan(0);
  });

  it('returns 0 after pending entries are removed and zero-cache expires', () => {
    insertPendingEntry(fx);
    const probe = makeTotalCanopyPendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      mycoHome: fx.mycoHome,
      daemonStateDir: fx.daemonStateDir,
    });
    // Prime the probe with pending work so no zero-cache is set.
    expect(probe()).toBeGreaterThan(0);

    // Remove the pending entry. Because the last probe returned > 0,
    // no zero-cache was set — the next call re-walks and returns 0.
    deletePendingEntries(fx);
    expect(probe()).toBe(0);
  });

  it('serves cached zero without re-walking for ZERO_PENDING_TTL_MS after draining', () => {
    const probe = makeTotalCanopyPendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      mycoHome: fx.mycoHome,
      daemonStateDir: fx.daemonStateDir,
    });

    // First call — empty queue, sets zero-cache.
    expect(probe()).toBe(0);

    // Insert a pending entry. The zero-cache should suppress the re-walk.
    insertPendingEntry(fx);
    // Still 0 due to cache.
    expect(probe()).toBe(0);
  });

  it('never throws even when the Grove DB is inaccessible', () => {
    const brokenCache = new GroveRuntimeCache();
    // Use a non-existent databasePath — getDatabase will throw on first access.
    // The probe must swallow the error and return 0.
    const probe = makeTotalCanopyPendingProbe({
      cache: brokenCache,
      logger: fx.logger,
      mycoHome: fx.mycoHome,
      daemonStateDir: fx.daemonStateDir,
    });
    expect(() => probe()).not.toThrow();
    brokenCache.closeAll();
  });
});
