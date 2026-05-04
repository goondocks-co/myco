import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCanopyMap } from '@myco/canopy/map/store.js';
import { getDatabase } from '@myco/db/client.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { createMycoTools } from '@myco/tools/index.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import { cleanTestDb, seedCanopyEntry, setupTestDb, teardownTestDb } from '../helpers/db.js';
import { vi } from '../helpers/vi-shim.js';

function mockClient(): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

describe('Myco tools request-context dispatch', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('uses the resolved request context for project-scoped Canopy reads', async () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-context-dispatch-'));
    try {
      writeCanopyMap({
        project_id: 'project-a',
        machine_id: 'machine-a',
        content: '## Project A',
        inputs_hash: 'hash-a',
        token_estimate: 10,
        generated_by_run_id: null,
      });
      writeCanopyMap({
        project_id: 'project-b',
        machine_id: 'machine-a',
        content: '## Project B',
        inputs_hash: 'hash-b',
        token_estimate: 10,
        generated_by_run_id: null,
      });

      const requestContext = resolveLegacyRequestContext(vaultDir, {
        projectRoot: '/workspace/project-a',
        projectId: 'project-a',
        groveId: 'grove-a',
        machineId: 'machine-a',
        source: 'explicit',
      });
      const tools = createMycoTools(vaultDir, mockClient(), { requestContext });

      const result = await tools.callTool('myco_cortex', { op: 'canopy_map' }) as { content: string };
      const overrideAttempt = await tools.callTool('myco_cortex', {
        op: 'canopy_map',
        project_id: 'project-b',
      }) as { content: string };

      expect(result.content).toBe('## Project A');
      expect(overrideAttempt.content).toBe('## Project A');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('uses the resolved request context for Canopy entry lookups', async () => {
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: 'project-a',
      path: 'src/shared.ts',
      llm_description: 'Project A entry',
    });
    seedCanopyEntry(db, {
      project_id: 'project-b',
      path: 'src/shared.ts',
      llm_description: 'Project B entry',
    });

    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-context-dispatch-'));
    try {
      const requestContext = resolveLegacyRequestContext(vaultDir, {
        projectRoot: '/workspace/project-a',
        projectId: 'project-a',
        groveId: 'grove-a',
        machineId: 'machine-a',
        source: 'explicit',
      });
      const tools = createMycoTools(vaultDir, mockClient(), { requestContext });

      const pathLookup = await tools.callTool('myco_cortex', {
        op: 'canopy_entry',
        project_id: 'project-b',
        path: 'src/shared.ts',
      }) as { project_id: string; llm_description: string };
      const crossProjectId = await tools.callTool('myco_cortex', {
        op: 'canopy_entry',
        id: 'project-b:src/shared.ts',
      }) as { ok: false; error: string };

      expect(pathLookup.project_id).toBe('project-a');
      expect(pathLookup.llm_description).toBe('Project A entry');
      expect(crossProjectId).toEqual({
        ok: false,
        error: 'Canopy entry is outside the current project context',
      });
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('uses Grove request context for in-process plan/session helpers', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertSession({ id: 'sess-legacy', agent: 'codex', started_at: now, created_at: now });
    upsertSession({ id: 'sess-a', project_id: 'project-a', agent: 'codex', started_at: now + 1, created_at: now + 1 });
    upsertSession({ id: 'sess-b', project_id: 'project-b', agent: 'codex', started_at: now + 2, created_at: now + 2 });
    upsertPlan({
      id: 'plan-legacy',
      logical_key: 'path:docs/plan.md',
      title: 'Legacy',
      created_at: now,
    });
    upsertPlan({
      id: 'plan-a',
      project_id: 'project-a',
      logical_key: 'path:docs/plan.md',
      title: 'Project A',
      created_at: now + 1,
    });
    upsertPlan({
      id: 'plan-b',
      project_id: 'project-b',
      logical_key: 'path:docs/plan.md',
      title: 'Project B',
      created_at: now + 2,
    });

    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-context-dispatch-'));
    try {
      const requestContext = resolveLegacyRequestContext(vaultDir, {
        projectRoot: '/workspace/project-a',
        projectId: 'project-a',
        groveId: 'grove-a',
        machineId: 'machine-a',
        source: 'explicit',
      });
      const tools = createMycoTools(vaultDir, mockClient(), { requestContext });

      const sessions = await tools.callTool('myco_sessions', {}) as Array<{ id: string }>;
      const plans = await tools.callTool('myco_plans', {}) as Array<{ id: string }>;

      expect(sessions.map((row) => row.id)).toEqual(['sess-a']);
      expect(plans.map((row) => row.id)).toEqual(['plan-a']);
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('uses Grove request context for in-process spore writes', async () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-context-dispatch-'));
    try {
      const requestContext = resolveLegacyRequestContext(vaultDir, {
        projectRoot: '/workspace/project-a',
        projectId: 'project-a',
        groveId: 'grove-a',
        machineId: 'machine-a',
        source: 'explicit',
      });
      const tools = createMycoTools(vaultDir, mockClient(), { requestContext });

      const result = await tools.callTool('myco_spores', {
        op: 'save',
        type: 'decision',
        content: 'Project-scoped spore',
      }) as { id: string };

      const row = getDatabase().prepare(
        'SELECT project_id FROM spores WHERE id = ?',
      ).get(result.id) as { project_id: string | null };
      expect(row.project_id).toBe('project-a');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
