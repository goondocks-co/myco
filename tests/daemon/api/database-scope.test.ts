/**
 * Phase-7 dispatch test for `/api/database/*` actions.
 *
 * Verifies the scope-aware route handlers fan out correctly:
 *  - `kind: 'project'` and `kind: 'grove'` operate on a single Grove.
 *  - `kind: 'all-groves'` produces one result per registered Grove.
 *  - Coalescing: two concurrent identical "all-groves" calls share the
 *    same in-flight promise (only one underlying optimize sweep runs).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonLogger } from '@myco/daemon/logger';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache';
import { createDatabaseMaintenanceHandlers } from '@myco/daemon/api/database';
import { DatabaseMaintenanceManager } from '@myco/daemon/database/manager';
import { ensureGroveDatabase } from '@myco/grove/database';
import { createGrove } from '@myco/grove/registry';
import { assertGroveProjectId } from '@myco/grove/ids';
import type { RouteRequest } from '@myco/daemon/router';

const VALID_PROJECT_ID = 'proj_' + 'a'.repeat(32);

function makeLogger(workDir: string): DaemonLogger {
  return new DaemonLogger(path.join(workDir, 'logs'), { level: 'error' });
}

function emptyRequest(body: unknown = undefined): RouteRequest {
  return { body, query: {}, params: {}, pathname: '/api/database/optimize' };
}

describe('database scope-aware actions', () => {
  let workDir: string;
  let mycoHome: string;
  let previousMycoHome: string | undefined;
  let logger: DaemonLogger;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-scope-'));
    mycoHome = path.join(workDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    logger = makeLogger(workDir);
  });

  afterEach(() => {
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function makeHandlers() {
    const cache = new GroveRuntimeCache();
    return createDatabaseMaintenanceHandlers({
      // The legacy `details` endpoint isn't exercised here.
      createManager: () =>
        new DatabaseMaintenanceManager(
          path.join(workDir, 'unused.db'),
          workDir,
          logger,
        ),
      cache,
      logger,
      vaultDir: workDir,
      mycoHome,
    });
  }

  it('rejects body with malformed scope', async () => {
    const handlers = makeHandlers();
    const res = await handlers.handleOptimize(
      emptyRequest({ scope: { kind: 'unknown' } }),
    );
    expect(res.status).toBe(400);
  });

  it('runs against a single Grove for kind=grove', async () => {
    const grove = createGrove('alpha', mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);

    const handlers = makeHandlers();
    const res = await handlers.handleOptimize(
      emptyRequest({ scope: { kind: 'grove', grove_id: grove.id } }),
    );

    const body = res.body as {
      scope: { kind: string };
      results: Array<{ grove_id: string; ok: boolean }>;
      summary: { ok: number; failed: number };
    };
    expect(body.scope.kind).toBe('grove');
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.grove_id).toBe(grove.id);
    expect(body.summary.ok + body.summary.failed).toBe(1);
  });

  it('rejects kind=project for database actions with 400 invalid_scope', async () => {
    // Database maintenance has no project-narrowed data plane (the
    // whole SQLite file is the unit), so wire-level `kind: 'project'`
    // is rejected rather than silently widened to the Grove DB. (P2 #36)
    const grove = createGrove('alpha', mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);

    const handlers = makeHandlers();
    const res = await handlers.handleOptimize(
      emptyRequest({
        scope: {
          kind: 'project',
          grove_id: grove.id,
          project_id: assertGroveProjectId(VALID_PROJECT_ID),
        },
      }),
    );

    expect(res.status).toBe(400);
    const body = res.body as { error: string; message: string };
    expect(body.error).toBe('invalid_scope');
    expect(body.message).toMatch(/whole Grove DB/);
  });

  it('fans out across every Grove for kind=all-groves', async () => {
    const a = createGrove('alpha', mycoHome);
    ensureGroveDatabase(a.id, mycoHome);
    const b = createGrove('beta', mycoHome);
    ensureGroveDatabase(b.id, mycoHome);

    const handlers = makeHandlers();
    const res = await handlers.handleOptimize(emptyRequest({ scope: { kind: 'all-groves' } }));

    const body = res.body as {
      scope: { kind: string };
      results: Array<{ grove_id: string; ok: boolean }>;
      summary: { ok: number; failed: number };
    };
    expect(body.scope.kind).toBe('all-groves');
    expect(body.results.length).toBe(2);
    const ids = new Set(body.results.map((r) => r.grove_id));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id)).toBe(true);
    expect(body.summary.ok + body.summary.failed).toBe(2);
  });

  it('coalesces concurrent identical all-groves dispatches', async () => {
    const a = createGrove('alpha', mycoHome);
    ensureGroveDatabase(a.id, mycoHome);

    const handlers = makeHandlers();
    const req = emptyRequest({ scope: { kind: 'all-groves' } });

    const [r1, r2] = await Promise.all([
      handlers.handleOptimize(req),
      handlers.handleOptimize(req),
    ]);
    // The two responses should be the *same* promise's resolution —
    // identical content, same shape — proving coalescing didn't fork.
    expect(r1.body).toEqual(r2.body);
  });
});
