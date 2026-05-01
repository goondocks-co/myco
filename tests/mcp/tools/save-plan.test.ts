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
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';

function mockClient(): DaemonClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  } as unknown as DaemonClient;
}

function seedSession(id: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO sessions (id, agent, started_at, created_at, machine_id, status)
    VALUES (?, 'claude-code', ?, ?, 'local', 'active')
  `).run(id, 1700000000, 1700000000);
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

  beforeAll(() => {
    fs.mkdirSync(vaultDir, { recursive: true });
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
