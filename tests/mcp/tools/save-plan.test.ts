/**
 * Tests for myco_plans op:save.
 *
 * Calls the in-process service `saveMcpPlan` (no HTTP). Verifies the plan lands
 * in the DB with the correct logical key, status, and tags, and that the result
 * envelope echoes the persisted shape.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoPlans } from '@myco/tools/plans.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { getDatabase } from '@myco/db/client.js';
import { getPlan, upsertPlan } from '@myco/db/queries/plans.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

function mockClient(): DaemonClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  } as unknown as DaemonClient;
}

function seedSession(id: string, projectId?: string | null): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO sessions (id, project_id, agent, started_at, created_at, machine_id, status)
    VALUES (?, ?, 'claude-code', ?, ?, 'local', 'active')
  `).run(id, projectId ?? null, 1700000000, 1700000000);
}

interface PlanSaveSuccess {
  ok: true;
  id: string;
  logical_key: string;
  title: string | null;
  status: string;
  source_path: string | null;
  session_id: string | null;
  tags: string[];
}

describe('myco_plans op: save (in-process)', () => {
  const vaultDir = path.join(os.tmpdir(), 'myco-save-plan-test');

  beforeAll(async () => {
    fs.mkdirSync(vaultDir, { recursive: true });
    const { ensureProjectManifest } = await import('@myco/config/project-manifest.js');
    ensureProjectManifest(vaultDir, { projectName: 'save-plan-test' });
    setupTestDb();
  });
  afterAll(() => {
    teardownTestDb();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });
  beforeEach(() => { cleanTestDb(); });

  it('persists a plan with a session-key logical key and returns the saved metadata', async () => {
    seedSession('sess-1');

    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-1',
      content: '# Primary Plan',
      plan_key: 'primary',
      tags: ['planning'],
    }, mockClient(), vaultDir) as PlanSaveSuccess;

    expect(result.ok).toBe(true);
    expect(result.logical_key).toBe('session:sess-1:key:primary');
    expect(result.session_id).toBe('sess-1');
    expect(result.tags).toEqual(['planning']);
    expect(result.title).toBe('Primary Plan');
    expect(result.status).toBe('active');

    const db = getDatabase();
    const row = db.prepare('SELECT logical_key, content, tags FROM plans WHERE id = ?').get(result.id) as {
      logical_key: string;
      content: string;
      tags: string;
    };
    expect(row.logical_key).toBe('session:sess-1:key:primary');
    expect(row.content).toBe('# Primary Plan');
    expect(row.tags).toBe('planning');
  });

  it('returns session-not-found when the session does not exist', async () => {
    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-missing',
      content: '# Plan',
      plan_key: 'primary',
    }, mockClient(), vaultDir);

    expect(result).toEqual({ ok: false, error: 'Session not found' });
  });

  it('updates an existing plan by id without requiring source_path or plan_key', async () => {
    seedSession('sess-1');
    const existing = upsertPlan({
      id: 'existing-plan',
      logical_key: 'session:old-session:key:addendum',
      title: 'Old Addendum',
      content: '# Old Addendum',
      tags: 'grove',
      status: 'active',
      session_id: null,
      created_at: 1700000000,
      machine_id: 'local',
    });

    const result = await handleMycoPlans({
      op: 'save',
      id: existing.id,
      session_id: 'sess-1',
      content: '# Updated Addendum\n\nCurrent details.',
      status: 'active',
    }, mockClient(), vaultDir) as PlanSaveSuccess;

    expect(result.ok).toBe(true);
    expect(result.id).toBe(existing.id);
    expect(result.logical_key).toBe(existing.logical_key);
    expect(result.tags).toEqual(['grove']);

    const row = getPlan(existing.id, ALL_PROJECTS_SCOPE);
    expect(row?.content).toBe('# Updated Addendum\n\nCurrent details.');
    expect(row?.session_id).toBe('sess-1');
    expect(row?.logical_key).toBe(existing.logical_key);
  });

  it('returns Plan not found when updating an unknown id', async () => {
    const result = await handleMycoPlans({
      op: 'save',
      id: 'missing-plan',
      content: '# Missing',
    }, mockClient(), vaultDir);

    expect(result).toEqual({ ok: false, error: 'Plan not found' });
  });

  it('stores file-backed plans under the resolved Grove project scope', async () => {
    seedSession('sess-a', 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    seedSession('sess-b', 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const contextA = resolveLegacyRequestContext(vaultDir, {
      projectRoot: '/workspace/project-a',
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      groveId: 'grove-a',
      machineId: 'machine-a',
      source: 'explicit',
    });
    const contextB = resolveLegacyRequestContext(vaultDir, {
      projectRoot: '/workspace/project-b',
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      groveId: 'grove-a',
      machineId: 'machine-b',
      source: 'explicit',
    });

    const first = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-a',
      content: '# Shared Plan A',
      source_path: 'docs/shared-plan.md',
    }, mockClient(), contextA) as PlanSaveSuccess;
    const second = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-b',
      content: '# Shared Plan B',
      source_path: 'docs/shared-plan.md',
    }, mockClient(), contextB) as PlanSaveSuccess;

    expect(first.logical_key).toBe('path:docs/shared-plan.md');
    expect(second.logical_key).toBe('path:docs/shared-plan.md');
    expect(first.id).not.toBe(second.id);

    const rows = getDatabase().prepare(
      `SELECT id, project_id, title
         FROM plans
        WHERE logical_key = 'path:docs/shared-plan.md'
        ORDER BY project_id`,
    ).all() as Array<{ id: string; project_id: string; title: string }>;
    expect(rows).toEqual([
      { id: first.id, project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Shared Plan A' },
      { id: second.id, project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'Shared Plan B' },
    ]);
  });

  it('normalizes the source_path against the caller cwd so worktrees produce a portable logical_key', async () => {
    seedSession('sess-worktree', 'proj_cccccccccccccccccccccccccccccccc');
    const worktreeRoot = '/workspace/worktrees/feature-x';
    const context = resolveLegacyRequestContext(vaultDir, {
      projectRoot: '/workspace/project-c',
      callerRoot: worktreeRoot,
      projectId: 'proj_cccccccccccccccccccccccccccccccc',
      groveId: 'grove-c',
      machineId: 'machine-c',
      source: 'explicit',
    });

    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-worktree',
      content: '# Worktree Plan',
      source_path: `${worktreeRoot}/docs/plans/sprint.md`,
    }, mockClient(), context) as PlanSaveSuccess;

    expect(result.logical_key).toBe('path:docs/plans/sprint.md');
    expect(result.source_path).toBe('docs/plans/sprint.md');
  });

  it('rejects op:save when both source_path and plan_key are passed', async () => {
    seedSession('sess-1');

    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-1',
      content: '# Plan',
      source_path: 'docs/plan.md',
      plan_key: 'primary',
    }, mockClient(), vaultDir);

    expect(result).toEqual({
      ok: false,
      error: 'Provide exactly one of source_path or plan_key',
    });
  });

  it('rejects op:save without session_id', async () => {
    const result = await handleMycoPlans({
      op: 'save',
      content: '# Plan',
      plan_key: 'p',
    }, mockClient(), vaultDir);
    expect(result).toEqual({ ok: false, error: 'session_id is required for op: save' });
  });

  it('rejects op:save without content', async () => {
    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-1',
      plan_key: 'p',
    }, mockClient(), vaultDir);
    expect(result).toEqual({ ok: false, error: 'content is required for op: save' });
  });
});
