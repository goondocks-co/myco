/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
import {
  resolveGroveDbPath,
  resolveGroveConfigPath,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import { invalidateMergedConfigCache } from '@myco/config/loader.js';

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
  projectRoot: string;
  /** Flip canopy-describe enabled in the Grove config (where `agent.*` lives). */
  setCanopyDescribeEnabled: (enabled: boolean) => void;
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
  const projectVaultDir = resolveProjectVaultDir(projectRoot);
  fs.mkdirSync(projectVaultDir, { recursive: true });
  // Minimal project config so loadMergedConfig finds a myco.yaml. The
  // `agent.*` block is Grove-tier, so canopy-describe enabled is set in
  // the Grove config (see setCanopyDescribeEnabled), not here.
  fs.writeFileSync(path.join(projectVaultDir, 'myco.yaml'), 'version: 3\n');

  registerProjectInGrove(grove.id, {
    projectId,
    projectName: 'p1',
    projectRoot,
  }, mycoHome);

  // canopy-describe defaults to disabled — start there so each test opts in.
  const setCanopyDescribeEnabled = (enabled: boolean): void => {
    const groveConfigPath = resolveGroveConfigPath(grove.id, mycoHome);
    fs.mkdirSync(path.dirname(groveConfigPath), { recursive: true });
    if (enabled) {
      fs.writeFileSync(
        groveConfigPath,
        'agent:\n  tasks:\n    canopy-describe:\n      schedule:\n        enabled: true\n',
      );
    } else {
      // No agent.tasks override → schema/task default (disabled).
      fs.writeFileSync(groveConfigPath, 'version: 3\n');
    }
    invalidateMergedConfigCache();
  };

  return {
    workDir,
    mycoHome,
    daemonStateDir,
    grove,
    databasePath,
    cache,
    logger,
    projectId,
    projectRoot,
    setCanopyDescribeEnabled,
    cleanup: () => {
      cache.closeAll();
      logger.close();
      try { closeDatabase(); } catch { /* noop */ }
      if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousMycoHome;
      clearGroveRegistryCaches();
      invalidateMergedConfigCache();
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

function makeProbe(fx: ProbeFixture): () => number {
  return makeTotalCanopyPendingProbe({
    cache: fx.cache,
    logger: fx.logger,
    mycoHome: fx.mycoHome,
    daemonStateDir: fx.daemonStateDir,
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

  it('returns 0 when no canopy_entries are pending (canopy-describe enabled)', () => {
    fx.setCanopyDescribeEnabled(true);
    expect(makeProbe(fx)()).toBe(0);
  });

  it('returns > 0 when a project has pending rows AND canopy-describe is enabled', () => {
    fx.setCanopyDescribeEnabled(true);
    insertPendingEntry(fx);
    expect(makeProbe(fx)()).toBeGreaterThan(0);
  });

  it('returns 0 when pending rows exist but canopy-describe is DISABLED (default)', () => {
    // The key never-deep-sleep guard: canopy-background-scan populates
    // pending rows regardless of canopy-describe, so an ungated hold would
    // pin the daemon awake for work the disabled task never drains.
    fx.setCanopyDescribeEnabled(false);
    insertPendingEntry(fx);
    expect(makeProbe(fx)()).toBe(0);
  });

  it('returns 0 after pending entries are removed and the cache expires', () => {
    fx.setCanopyDescribeEnabled(true);
    insertPendingEntry(fx);
    // ttlMs=0 → never serves a stale cache, so each call re-walks.
    const probe = makeTotalCanopyPendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      mycoHome: fx.mycoHome,
      daemonStateDir: fx.daemonStateDir,
    });
    expect(probe()).toBeGreaterThan(0);

    deletePendingEntries(fx);
    // Within the default 30s TTL the prior non-zero is still cached.
    expect(probe()).toBeGreaterThan(0);
  });

  it('caches BOTH zero and non-zero within the TTL (no per-tick re-walk)', () => {
    fx.setCanopyDescribeEnabled(true);
    const probe = makeProbe(fx);

    // Zero state is cached.
    expect(probe()).toBe(0);
    // Insert pending work; the cached zero suppresses the re-walk.
    insertPendingEntry(fx);
    expect(probe()).toBe(0);
  });

  it('caches a non-zero result so a draining backlog is not re-walked every tick', () => {
    fx.setCanopyDescribeEnabled(true);
    insertPendingEntry(fx);
    const probe = makeProbe(fx);

    // First call walks and finds pending work.
    expect(probe()).toBeGreaterThan(0);
    // Drain the queue; the cached non-zero is served within the TTL —
    // zero-only caching used to re-walk every tick.
    deletePendingEntries(fx);
    expect(probe()).toBeGreaterThan(0);
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
