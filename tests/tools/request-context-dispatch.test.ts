import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCanopyMap } from '@myco/canopy/map/store.js';
import { openDatabase, withDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { DaemonClient } from '@myco/daemon/client.js';
import { createMycoTools } from '@myco/tools/index.js';
import { PROJECT_PIVOT } from '@myco/tools/pivot.js';
import { resolveLegacyRequestContext, type MycoRequestContext } from '@myco/grove/request-context.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import { seedCanopyEntry } from '../helpers/db.js';
import { vi } from '../helpers/vi-shim.js';

const PROJECT_A = assertGroveProjectId(createProjectId());
const PROJECT_B = assertGroveProjectId(createProjectId());

function mockClient(): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

function createFixture(projectId = PROJECT_A): {
  db: Database;
  vaultDir: string;
  requestContext: MycoRequestContext;
  cleanup: () => void;
  withDb: <T>(fn: () => T) => T;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-context-dispatch-'));
  const vaultDir = path.join(root, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  const db = openDatabase(path.join(vaultDir, 'myco.db'));
  createSchema(db);
  const requestContext = resolveLegacyRequestContext(vaultDir, {
    projectRoot: root,
    projectId,
    groveId: 'grove-a',
    machineId: 'machine-a',
    source: 'explicit',
    // createMycoTools requires caller-supplied tenancy; the fixture stands
    // in for a real CLI/MCP caller context.
    tenancySource: 'caller',
  });

  return {
    db,
    vaultDir,
    requestContext,
    withDb: (fn) => withDatabase(db, fn),
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('Myco tools request-context dispatch', () => {
  it('honors the request context by default and pivots when input names another project', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fixture = createFixture();
    try {
      fixture.withDb(() => {
        upsertSession({ id: 'sess-a', project_id: PROJECT_A, agent: 'codex', started_at: now + 1, created_at: now + 1 });
        upsertSession({ id: 'sess-b', project_id: PROJECT_B, agent: 'codex', started_at: now + 2, created_at: now + 2 });
      });
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      // No pivot: the request context wins.
      const baseline = await tools.callTool('myco_sessions', {}) as Array<{ id: string }>;
      expect(baseline.map((row) => row.id)).toEqual(['sess-a']);

      // The agent names another project. Same Grove, so the same database;
      // only the row scope flips.
      const pivoted = await tools.callTool('myco_sessions', { [PROJECT_PIVOT]: PROJECT_B }) as Array<{ id: string }>;
      expect(pivoted.map((row) => row.id)).toEqual(['sess-b']);
    } finally {
      fixture.cleanup();
    }
  });

  it('uses Grove request context for in-process plan/session helpers', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fixture = createFixture();
    try {
      fixture.withDb(() => {
        upsertSession({ id: 'sess-legacy', agent: 'codex', started_at: now, created_at: now });
        upsertSession({ id: 'sess-a', project_id: PROJECT_A, agent: 'codex', started_at: now + 1, created_at: now + 1 });
        upsertSession({ id: 'sess-b', project_id: PROJECT_B, agent: 'codex', started_at: now + 2, created_at: now + 2 });
        upsertPlan({
          id: 'plan-legacy',
          logical_key: 'path:docs/plan.md',
          title: 'Legacy',
          created_at: now,
        });
        upsertPlan({
          id: 'plan-a',
          project_id: PROJECT_A,
          logical_key: 'path:docs/plan.md',
          title: 'Project A',
          created_at: now + 1,
        });
        upsertPlan({
          id: 'plan-b',
          project_id: PROJECT_B,
          logical_key: 'path:docs/plan.md',
          title: 'Project B',
          created_at: now + 2,
        });
      });
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      const sessions = await tools.callTool('myco_sessions', {}) as Array<{ id: string }>;
      const plans = await tools.callTool('myco_plans', {}) as Array<{ id: string }>;

      expect(sessions.map((row) => row.id)).toEqual(['sess-a']);
      expect(plans.map((row) => row.id)).toEqual(['plan-a']);
    } finally {
      fixture.cleanup();
    }
  });

  it('uses each request context database path instead of the first opened DB', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fixtureA = createFixture(PROJECT_A);
    const fixtureB = createFixture(PROJECT_B);
    try {
      fixtureA.withDb(() => {
        upsertPlan({
          id: 'plan-a',
          project_id: PROJECT_A,
          logical_key: 'path:docs/a.md',
          title: 'Project A',
          created_at: now,
        });
      });
      fixtureB.withDb(() => {
        upsertPlan({
          id: 'plan-b',
          project_id: PROJECT_B,
          logical_key: 'path:docs/b.md',
          title: 'Project B',
          created_at: now,
        });
      });

      const toolsA = createMycoTools(fixtureA.vaultDir, mockClient(), { requestContext: fixtureA.requestContext });
      const toolsB = createMycoTools(fixtureB.vaultDir, mockClient(), { requestContext: fixtureB.requestContext });

      const plansA = await toolsA.callTool('myco_plans', {}) as Array<{ id: string }>;
      const plansB = await toolsB.callTool('myco_plans', {}) as Array<{ id: string }>;

      expect(plansA.map((row) => row.id)).toEqual(['plan-a']);
      expect(plansB.map((row) => row.id)).toEqual(['plan-b']);
    } finally {
      fixtureA.cleanup();
      fixtureB.cleanup();
    }
  });

  it('uses Grove request context for in-process spore writes', async () => {
    const fixture = createFixture();
    try {
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      const result = await tools.callTool('myco_spores', {
        op: 'save',
        type: 'decision',
        content: 'Project-scoped spore',
      }) as { id: string };

      const row = fixture.db.prepare(
        'SELECT project_id FROM spores WHERE id = ?',
      ).get(result.id) as { project_id: string | null };
      expect(row.project_id).toBe(PROJECT_A);
    } finally {
      fixture.cleanup();
    }
  });
});
