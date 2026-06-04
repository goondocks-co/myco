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

import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { makeGrovePendingProbe } from '@myco/daemon/grove-pending-probe.js';
import { createGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

interface Fixture {
  workDir: string;
  mycoHome: string;
  daemonStateDir: string;
  cache: GroveRuntimeCache;
  logger: DaemonLogger;
  cleanup: () => void;
}

function setup(): Fixture {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-probe-')));
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
  cache.getDatabase(databasePath);

  return {
    workDir,
    mycoHome,
    daemonStateDir,
    cache,
    logger,
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

describe('makeGrovePendingProbe', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setup();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('sums countForGrove across served Groves', () => {
    let calls = 0;
    const probe = makeGrovePendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      daemonStateDir: fx.daemonStateDir,
      mycoHome: fx.mycoHome,
      logKind: LOG_KINDS.CANOPY_ERROR,
      countForGrove: () => {
        calls += 1;
        return 7;
      },
    });
    expect(probe()).toBe(7);
    expect(calls).toBe(1);
  });

  it('caches a non-zero result within the TTL (no re-walk)', () => {
    let calls = 0;
    const probe = makeGrovePendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      daemonStateDir: fx.daemonStateDir,
      mycoHome: fx.mycoHome,
      logKind: LOG_KINDS.CANOPY_ERROR,
      countForGrove: () => {
        calls += 1;
        return 3;
      },
    });
    expect(probe()).toBe(3);
    expect(probe()).toBe(3);
    // Second call served from cache — countForGrove ran exactly once.
    expect(calls).toBe(1);
  });

  it('caches a zero result within the TTL (no re-walk)', () => {
    let calls = 0;
    const probe = makeGrovePendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      daemonStateDir: fx.daemonStateDir,
      mycoHome: fx.mycoHome,
      logKind: LOG_KINDS.CANOPY_ERROR,
      countForGrove: () => {
        calls += 1;
        return 0;
      },
    });
    expect(probe()).toBe(0);
    expect(probe()).toBe(0);
    expect(calls).toBe(1);
  });

  it('re-walks once the TTL expires', () => {
    let value = 5;
    let calls = 0;
    const probe = makeGrovePendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      daemonStateDir: fx.daemonStateDir,
      mycoHome: fx.mycoHome,
      logKind: LOG_KINDS.CANOPY_ERROR,
      ttlMs: 0, // expire immediately so every call re-walks
      countForGrove: () => {
        calls += 1;
        return value;
      },
    });
    expect(probe()).toBe(5);
    value = 0;
    expect(probe()).toBe(0);
    expect(calls).toBe(2);
  });

  it('swallows a throwing countForGrove and returns 0 (never throws)', () => {
    const probe = makeGrovePendingProbe({
      cache: fx.cache,
      logger: fx.logger,
      daemonStateDir: fx.daemonStateDir,
      mycoHome: fx.mycoHome,
      logKind: LOG_KINDS.CANOPY_ERROR,
      countForGrove: () => {
        throw new Error('boom');
      },
    });
    expect(() => probe()).not.toThrow();
    expect(probe()).toBe(0);
  });
});
