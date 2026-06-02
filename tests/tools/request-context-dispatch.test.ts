import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCanopyMap } from '@myco/canopy/map/store.js';
import { openDatabase, withDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { createMycoTools } from '@myco/tools/index.js';
import { resolveLegacyRequestContext, type MycoRequestContext } from '@myco/tools/request-context.js';
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
  it('honors the request context by default and pivots when input carries a project_id (Stream J)', async () => {
    const fixture = createFixture();
    try {
      fixture.withDb(() => {
        writeCanopyMap({
          project_id: PROJECT_A,
          machine_id: 'machine-a',
          content: '## Project A',
          inputs_hash: 'hash-a',
          token_estimate: 10,
          generated_by_run_id: null,
        });
        writeCanopyMap({
          project_id: PROJECT_B,
          machine_id: 'machine-a',
          content: '## Project B',
          inputs_hash: 'hash-b',
          token_estimate: 10,
          generated_by_run_id: null,
        });
      });
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      // No pivot: request context wins.
      const baseline = await tools.callTool('myco_cortex', { op: 'canopy_map' }) as { content: string };
      expect(baseline.content).toBe('## Project A');

      // Stream J — agent passes a Grove project id pivot. Same Grove, so
      // the same DB; only the row scope flips. Mirrors the UI's project
      // switcher.
      const pivoted = await tools.callTool('myco_cortex', {
        op: 'canopy_map',
        project_id: PROJECT_B,
      }) as { content: string };
      expect(pivoted.content).toBe('## Project B');
    } finally {
      fixture.cleanup();
    }
  });

  it('pivots Canopy entry lookups when input carries a Grove project_id (Stream J)', async () => {
    const fixture = createFixture();
    try {
      fixture.withDb(() => {
        seedCanopyEntry(fixture.db, {
          project_id: PROJECT_A,
          path: 'src/shared.ts',
          llm_description: 'Project A entry',
        });
        seedCanopyEntry(fixture.db, {
          project_id: PROJECT_B,
          path: 'src/shared.ts',
          llm_description: 'Project B entry',
        });
      });
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      // Pivot via project_id: cortex op resolves under PROJECT_B's scope,
      // returns the PROJECT_B row.
      const pathLookup = await tools.callTool('myco_cortex', {
        op: 'canopy_entry',
        project_id: PROJECT_B,
        path: 'src/shared.ts',
      }) as { project_id: string; llm_description: string };
      expect(pathLookup.project_id).toBe(PROJECT_B);
      expect(pathLookup.llm_description).toBe('Project B entry');

      // Non-Grove-format `project_id` (legacy Canopy id) does NOT pivot.
      // It's treated as the legacy Canopy id hint and flows into the
      // canopy_entry handler which compares against the resolved
      // request context (still PROJECT_A). Cross-project ids surface
      // as a typed error rather than silently leaking data.
      const crossProjectId = await tools.callTool('myco_cortex', {
        op: 'canopy_entry',
        id: 'project-b:src/shared.ts',
      }) as { ok: false; error: string };
      expect(crossProjectId).toEqual({
        ok: false,
        error: 'Canopy entry is outside the current project context',
      });
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
