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
import type { DaemonClient } from '@myco/daemon/client.js';
import { getDatabase } from '@myco/db/client.js';
import { getPlan, upsertPlan } from '@myco/db/queries/plans.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { resolveLegacyRequestContext } from '@myco/grove/request-context.js';
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

  it('preserves an existing title on status-only updates by id', async () => {
    seedSession('sess-1');
    const existing = upsertPlan({
      id: 'handoff-plan',
      logical_key: 'session:sess-1:key:handoff',
      title: 'Handoff: myco-handoff skill',
      content: [
        '<!-- myco-handoff:start -->',
        '## Handoff - 2026-06-05',
        '',
        '### Digest',
        'Resume context.',
        '<!-- myco-handoff:end -->',
      ].join('\n'),
      tags: 'handoff',
      status: 'active',
      session_id: 'sess-1',
      created_at: 1700000000,
      machine_id: 'local',
    });

    const result = await handleMycoPlans({
      op: 'save',
      id: existing.id,
      status: 'in_progress',
    }, mockClient(), vaultDir) as PlanSaveSuccess;

    expect(result.ok).toBe(true);
    expect(result.status).toBe('in_progress');
    expect(result.title).toBe('Handoff: myco-handoff skill');

    const row = getPlan(existing.id, ALL_PROJECTS_SCOPE);
    expect(row?.status).toBe('in_progress');
    expect(row?.title).toBe('Handoff: myco-handoff skill');
  });

  it('preserves nullable legacy content and title on status-only updates by id', async () => {
    seedSession('sess-legacy-null');
    const existing = upsertPlan({
      id: 'legacy-null-plan',
      logical_key: 'session:sess-legacy-null:file:docs/plans/legacy.md',
      title: null,
      content: null,
      source_path: 'docs/plans/legacy.md',
      tags: 'legacy',
      status: 'active',
      session_id: 'sess-legacy-null',
      created_at: 1700000000,
      machine_id: 'local',
    });

    const result = await handleMycoPlans({
      op: 'save',
      id: existing.id,
      status: 'completed',
    }, mockClient(), vaultDir) as PlanSaveSuccess;

    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.title).toBeNull();

    const row = getPlan(existing.id, ALL_PROJECTS_SCOPE);
    expect(row?.status).toBe('completed');
    expect(row?.content).toBeNull();
    expect(row?.title).toBeNull();
    expect(row?.source_path).toBe('docs/plans/legacy.md');
    expect(row?.content_hash).toBeNull();
  });

  it('rejects invalid writable statuses through op:save, including list-only all', async () => {
    seedSession('sess-status');

    const bad = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-status',
      content: '# Plan',
      plan_key: 'status-bad',
      status: 'paused',
    }, mockClient(), vaultDir);

    expect(bad).toEqual({
      ok: false,
      error: "Invalid plan status 'paused'. Expected one of: active, in_progress, completed, abandoned.",
    });

    const listOnly = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-status',
      content: '# Plan',
      plan_key: 'status-all',
      status: 'all',
    }, mockClient(), vaultDir);

    expect(listOnly).toEqual({
      ok: false,
      error: "Invalid plan status 'all'. Expected one of: active, in_progress, completed, abandoned.",
    });
  });

  it('still allows all as a list-only status filter', async () => {
    seedSession('sess-list-status');
    await handleMycoPlans({
      op: 'save',
      session_id: 'sess-list-status',
      content: '# Active Plan',
      plan_key: 'active',
      status: 'active',
    }, mockClient(), vaultDir);
    await handleMycoPlans({
      op: 'save',
      session_id: 'sess-list-status',
      content: '# Completed Plan',
      plan_key: 'completed',
      status: 'completed',
    }, mockClient(), vaultDir);

    const all = await handleMycoPlans({
      op: 'list',
      status: 'all',
    }, mockClient(), vaultDir) as Array<{ status: string }>;

    expect(all.map((plan) => plan.status).sort()).toEqual(['active', 'completed']);
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
      tenancySource: 'caller',
    });
    const contextB = resolveLegacyRequestContext(vaultDir, {
      projectRoot: '/workspace/project-b',
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      groveId: 'grove-a',
      machineId: 'machine-b',
      source: 'explicit',
      tenancySource: 'caller',
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

    expect(first.logical_key).toBe('session:sess-a:file:docs/shared-plan.md');
    expect(second.logical_key).toBe('session:sess-b:file:docs/shared-plan.md');
    expect(first.id).not.toBe(second.id);

    const rows = getDatabase().prepare(
      `SELECT id, project_id, title
         FROM plans
        WHERE source_path = 'docs/shared-plan.md'
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
      tenancySource: 'caller',
    });

    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-worktree',
      content: '# Worktree Plan',
      source_path: `${worktreeRoot}/docs/plans/sprint.md`,
    }, mockClient(), context) as PlanSaveSuccess;

    expect(result.logical_key).toBe('session:sess-worktree:file:docs/plans/sprint.md');
    expect(result.source_path).toBe('docs/plans/sprint.md');
  });

  it('accepts source_path and plan_key together; plan_key is identity, source_path is metadata', async () => {
    seedSession('sess-combo', 'proj_dddddddddddddddddddddddddddddddd');
    const context = resolveLegacyRequestContext(vaultDir, {
      projectRoot: '/workspace/project-d',
      projectId: 'proj_dddddddddddddddddddddddddddddddd',
      groveId: 'grove-d',
      machineId: 'machine-d',
      source: 'explicit',
      tenancySource: 'caller',
    });

    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-combo',
      content: '# Plan',
      source_path: '/workspace/project-d/docs/plan.md',
      plan_key: 'primary',
    }, mockClient(), context) as PlanSaveSuccess;

    expect(result.ok).toBe(true);
    expect(result.logical_key).toBe('session:sess-combo:key:primary');
    expect(result.source_path).toBe('docs/plan.md');
  });

  it('rejects op:save with neither source_path nor plan_key', async () => {
    seedSession('sess-1');

    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-1',
      content: '# Plan',
    }, mockClient(), vaultDir);

    expect(result).toEqual({
      ok: false,
      error: 'Provide source_path, plan_key, or both when creating a new plan',
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

  it('rejects op:save without content when creating a new plan', async () => {
    const result = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-1',
      plan_key: 'p',
    }, mockClient(), vaultDir);
    expect(result).toEqual({ ok: false, error: 'content is required when creating a new plan' });
  });

  it('allows status-only update on an existing plan and preserves body plus metadata', async () => {
    seedSession('sess-1');
    const created = await handleMycoPlans({
      op: 'save',
      session_id: 'sess-1',
      content: '# Original body\n\n- [ ] step 1',
      plan_key: 'lifecycle',
      source_path: 'docs/plans/lifecycle.md',
      title: 'Lifecycle Plan',
      tags: ['phase-one', 'status'],
    }, mockClient(), vaultDir) as PlanSaveSuccess;
    expect(created.status).toBe('active');

    const before = getPlan(created.id, ALL_PROJECTS_SCOPE);
    expect(before).not.toBeNull();

    const advanced = await handleMycoPlans({
      op: 'save',
      id: created.id,
      status: 'in_progress',
    }, mockClient(), vaultDir) as PlanSaveSuccess;
    expect(advanced.ok).toBe(true);
    expect(advanced.id).toBe(created.id);
    expect(advanced.status).toBe('in_progress');

    const row = getPlan(created.id, ALL_PROJECTS_SCOPE);
    expect(row?.content).toBe('# Original body\n\n- [ ] step 1');
    expect(row?.title).toBe('Lifecycle Plan');
    expect(row?.session_id).toBe('sess-1');
    expect(row?.source_path).toBe('docs/plans/lifecycle.md');
    expect(row?.logical_key).toBe(before?.logical_key);
    expect(row?.tags).toBe(before?.tags);

    const completed = await handleMycoPlans({
      op: 'save',
      id: created.id,
      status: 'completed',
    }, mockClient(), vaultDir) as PlanSaveSuccess;
    expect(completed.status).toBe('completed');
  });
});
