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
import type { EmbeddingManager } from '@myco/daemon/embedding/manager';
import type { RouteHandler, RouteRequest } from '@myco/daemon/router.js';
import {
  registerCanopyReadRoutes,
  type CanopyReadRouteDeps,
} from '@myco/daemon/api/canopy-read.js';
import { createEmbeddingDetailsHandler } from '@myco/daemon/api/embedding.js';
import { createCanopyDescribeBacklogReader } from '@myco/canopy/describe-backlog.js';
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
import type { GroveProjectId } from '@myco/grove/ids.js';

// ---------------------------------------------------------------------------
// Fixture — a real Grove DB + registry so serviceableProjectIds() resolves
// registered projects and excludes orphans, modeled on canopy-pending-probe.
// ---------------------------------------------------------------------------

interface Fixture {
  workDir: string;
  mycoHome: string;
  grove: GroveRecord;
  databasePath: string;
  projectId: string;
  projectRoot: string;
  orphanProjectId: string;
  /** Override Grove-tier canopy-describe params.max_attempts. */
  setMaxAttempts: (n: number) => void;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-retry-stuck-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });

  const previousMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();
  invalidateMergedConfigCache();

  const grove = createGrove('RetryStuck', mycoHome);
  ensureGroveDatabase(grove.id, mycoHome);
  const databasePath = resolveGroveDbPath(grove.id, mycoHome);

  initDatabase(databasePath);
  createSchema(getDatabase());

  const projectId = 'proj_' + 'a1a2a3a4a5a6a7a8a9a0b1b2b3b4b5b6';
  const orphanProjectId = 'proj_' + 'f1f2f3f4f5f6f7f8f9f0e1e2e3e4e5e6';
  const projectRoot = path.join(workDir, 'projects', 'registered');
  const projectVaultDir = resolveProjectVaultDir(projectRoot);
  fs.mkdirSync(projectVaultDir, { recursive: true });
  fs.writeFileSync(path.join(projectVaultDir, 'myco.yaml'), 'version: 3\n');

  registerProjectInGrove(grove.id, {
    projectId,
    projectName: 'registered',
    projectRoot,
  }, mycoHome);

  const setMaxAttempts = (n: number): void => {
    const groveConfigPath = resolveGroveConfigPath(grove.id, mycoHome);
    fs.mkdirSync(path.dirname(groveConfigPath), { recursive: true });
    fs.writeFileSync(
      groveConfigPath,
      `agent:\n  tasks:\n    canopy-describe:\n      params:\n        max_attempts: ${n}\n`,
    );
    invalidateMergedConfigCache();
  };

  return {
    workDir,
    mycoHome,
    grove,
    databasePath,
    projectId,
    projectRoot,
    orphanProjectId,
    setMaxAttempts,
    cleanup: () => {
      try { closeDatabase(); } catch { /* noop */ }
      if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousMycoHome;
      clearGroveRegistryCaches();
      invalidateMergedConfigCache();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/** Insert a canopy_entries row needing a description with a fixed attempt count. */
function seedStuckRow(projectId: string, suffix: string, describeAttempts: number): void {
  getDatabase().prepare(
    `INSERT INTO canopy_entries
       (project_id, path, content_hash, size_bytes, token_estimate, line_count,
        mechanical_updated_at, llm_description, llm_updated_at, describe_attempts)
     VALUES (?, ?, ?, 100, 100, 5, unixepoch('now'), NULL, NULL, ?)`,
  ).run(projectId, `src/${suffix}.ts`, `hash_${suffix}`, describeAttempts);
}

function attemptsFor(projectId: string): number[] {
  return (getDatabase().prepare(
    `SELECT describe_attempts FROM canopy_entries WHERE project_id = ? ORDER BY path`,
  ).all(projectId) as Array<{ describe_attempts: number }>).map((r) => r.describe_attempts);
}

interface KickCall { target?: { groveId: string; projectId: GroveProjectId } }

function captureRetryStuckHandler(
  fx: Fixture,
  extraDeps: Partial<CanopyReadRouteDeps> = {},
): { handler: RouteHandler; kicks: KickCall[] } {
  const routes = new Map<string, RouteHandler>();
  const kicks: KickCall[] = [];
  registerCanopyReadRoutes({
    registerRoute(method, pattern, handler) {
      routes.set(`${method} ${pattern}`, handler);
    },
  }, {
    resolveProjectId: (req) => req.requestContext?.projectId ?? fx.projectId,
    kickCanopyDescribe: (target) => { kicks.push({ target }); },
    ...extraDeps,
  });
  const handler = routes.get('POST /api/canopy/describe/retry-stuck');
  if (!handler) throw new Error('retry-stuck route not registered');
  return { handler, kicks };
}

function retryStuckRequest(
  fx: Fixture,
  scopeKind: 'grove' | 'project' = 'project',
  overrides: { projectId?: string } = {},
): RouteRequest {
  const scopeBody = scopeKind === 'grove'
    ? { kind: 'grove', grove_id: fx.grove.id }
    : { kind: 'project', grove_id: fx.grove.id, project_id: overrides.projectId ?? fx.projectId };
  return {
    body: { scope: scopeBody },
    query: {},
    params: {},
    pathname: '/api/canopy/describe/retry-stuck',
    requestContext: {
      projectId: overrides.projectId ?? fx.projectId,
      groveId: fx.grove.id,
      machineId: 'local',
      projectVaultDir: resolveProjectVaultDir(fx.projectRoot),
      projectRoot: fx.projectRoot,
      databasePath: fx.databasePath,
      sessionId: null,
      tenancySource: 'caller',
    },
  } as unknown as RouteRequest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/canopy/describe/retry-stuck', () => {
  let fx: Fixture;

  beforeEach(() => { fx = setupFixture(); });
  afterEach(() => { fx.cleanup(); });

  it('resets only serviceable stuck rows (grove scope) and fires the drain kicker', async () => {
    // Two stuck rows in the registered project, one stuck row in an
    // unregistered orphan project. Default cap is 2 → attempts >= 2 are stuck.
    seedStuckRow(fx.projectId, 'a', 2);
    seedStuckRow(fx.projectId, 'b', 3);
    seedStuckRow(fx.orphanProjectId, 'orphan', 2);

    const { handler, kicks } = captureRetryStuckHandler(fx);
    const res = await handler(retryStuckRequest(fx, 'grove'));

    // Only the two serviceable rows reset.
    expect(res.body).toEqual({ reset: 2 });
    expect(attemptsFor(fx.projectId)).toEqual([0, 0]);
    // Orphan rows are left untouched — no scribe run will ever service them.
    expect(attemptsFor(fx.orphanProjectId)).toEqual([2]);
    // Grove-wide reset fires a broadcast bypass (no target).
    expect(kicks).toEqual([{ target: undefined }]);
  });

  it('does not fire the kicker when nothing was reset', async () => {
    // No stuck rows present.
    seedStuckRow(fx.projectId, 'fresh', 0);
    const { handler, kicks } = captureRetryStuckHandler(fx);
    const res = await handler(retryStuckRequest(fx, 'grove'));

    expect(res.body).toEqual({ reset: 0 });
    expect(kicks).toEqual([]);
  });

  it('honors the project override of max_attempts (should-fix B threading)', async () => {
    // Raise the per-project cap to 5; a row at 3 attempts is below it, so it is
    // NOT stuck under the effective cap (it would be under the default of 2).
    fx.setMaxAttempts(5);
    seedStuckRow(fx.projectId, 'below-raised-cap', 3);

    const { handler, kicks } = captureRetryStuckHandler(fx);
    // Project-scope body → effective cap resolved from project config.
    const res = await handler(retryStuckRequest(fx, 'project'));

    expect(res.body).toEqual({ reset: 0 });
    expect(attemptsFor(fx.projectId)).toEqual([3]);
    expect(kicks).toEqual([]);
  });

  it('project-scope reset fires a project-targeted kicker', async () => {
    seedStuckRow(fx.projectId, 'stuck', 2);
    const { handler, kicks } = captureRetryStuckHandler(fx);
    const res = await handler(retryStuckRequest(fx, 'project'));

    expect(res.body).toEqual({ reset: 1 });
    expect(kicks).toEqual([{ target: { groveId: fx.grove.id, projectId: fx.projectId } }]);
  });

  it('grove-body scope resets stuck rows across two registered projects (multi-project seam)', async () => {
    // Register a second project in the same grove — the case the old
    // query-based code silently missed: stuck rows in sibling projects were
    // counted in the grove badge but never reset.
    const projectId2 = 'proj_' + 'b2b2b2b2b2b2b2b2b2b2c2c2c2c2c2c2';
    const projectRoot2 = path.join(fx.workDir, 'projects', 'second');
    const projectVaultDir2 = resolveProjectVaultDir(projectRoot2);
    fs.mkdirSync(projectVaultDir2, { recursive: true });
    fs.writeFileSync(path.join(projectVaultDir2, 'myco.yaml'), 'version: 3\n');
    registerProjectInGrove(fx.grove.id, {
      projectId: projectId2,
      projectName: 'second',
      projectRoot: projectRoot2,
    }, fx.mycoHome);
    clearGroveRegistryCaches();

    // Seed one stuck row in each registered project.
    seedStuckRow(fx.projectId, 'p1-stuck', 2);
    seedStuckRow(projectId2, 'p2-stuck', 2);

    const { handler, kicks } = captureRetryStuckHandler(fx);
    const res = await handler(retryStuckRequest(fx, 'grove'));

    // Both projects' stuck rows must be reset under the grove-body scope.
    expect(res.body).toEqual({ reset: 2 });
    expect(attemptsFor(fx.projectId)).toEqual([0]);
    expect(attemptsFor(projectId2)).toEqual([0]);
    // Grove-wide reset fires a broadcast (no target).
    expect(kicks).toEqual([{ target: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// stuck flows into the embedding details payload via the backlog spread
// (embedding.ts handleEmbeddingDetails), no payload-specific code.
// ---------------------------------------------------------------------------

describe('embedding details payload exposes canopy_describe.stuck', () => {
  let fx: Fixture;

  beforeEach(() => { fx = setupFixture(); });
  afterEach(() => { fx.cleanup(); });

  function mockManager(): EmbeddingManager {
    return {
      getDetails: () => ({
        total: 0,
        by_namespace: {},
        models: {},
        pending: {},
        provider: { name: 'ollama', model: 'bge-m3', dimensions: 1024 },
      }),
    } as unknown as EmbeddingManager;
  }

  it('includes the stuck bucket under canopy_describe', async () => {
    // One stuck row (attempts >= default cap of 2) for the scoped project.
    seedStuckRow(fx.projectId, 'stuck', 2);

    const handler = createEmbeddingDetailsHandler({
      resolveRequestRuntime: () => ({ manager: mockManager(), db: getDatabase() }),
      canopyDescribeBacklog: createCanopyDescribeBacklogReader(),
    });

    const res = await handler(retryStuckRequest(fx, {}));
    const body = res.body as { canopy_describe: { stuck: number } };
    expect(body.canopy_describe).toHaveProperty('stuck');
    expect(body.canopy_describe.stuck).toBe(1);
  });
});
