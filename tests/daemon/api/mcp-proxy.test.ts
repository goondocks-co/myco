import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { upsertSession } from '@myco/db/queries/sessions';
import { insertBatch } from '@myco/db/queries/batches';
import { getPlan } from '@myco/db/queries/plans';
import { createMcpProxyHandlers } from '@myco/daemon/api/mcp-proxy';
import type { RouteRequest } from '@myco/daemon/router';

const epochNow = () => Math.floor(Date.now() / 1000);

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    ...overrides,
  } as RouteRequest;
}

describe('createMcpProxyHandlers handleSavePlan', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-proxy-'));
    const db = initDatabase(path.join(tmpDir, 'myco.db'));
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers() {
    return createMcpProxyHandlers({
      machineId: 'local',
      embeddingManager: { onContentWritten: vi.fn(), onRemoved: vi.fn() } as never,
      projectRoot: tmpDir,
    });
  }

  it('saves a file-backed plan and attaches the latest open batch', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-file-plan',
      agent: 'claude-code',
      started_at: now,
      created_at: now,
    });
    const batch = insertBatch({
      session_id: 'sess-file-plan',
      prompt_number: 1,
      user_prompt: 'Plan this',
      started_at: now,
      created_at: now,
      status: 'active',
    });

    const { handleSavePlan } = makeHandlers();
    const res = await handleSavePlan(makeRequest({
      body: {
        session_id: 'sess-file-plan',
        content: '# Saved Plan',
        source_path: path.join(tmpDir, 'docs/plans/saved-plan.md'),
      },
    }));

    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { id: string; logical_key: string; prompt_batch_id: number | null; source_path: string | null };
    expect(body.logical_key).toBe('path:docs/plans/saved-plan.md');
    expect(body.prompt_batch_id).toBe(batch.id);
    expect(body.source_path).toBe('docs/plans/saved-plan.md');
    expect(getPlan(body.id)?.title).toBe('Saved Plan');
  });

  it('saves a tool-only plan under a session-scoped plan_key', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-key-plan',
      agent: 'claude-code',
      started_at: now,
      created_at: now,
    });

    const { handleSavePlan } = makeHandlers();
    const res = await handleSavePlan(makeRequest({
      body: {
        session_id: 'sess-key-plan',
        content: 'no heading here',
        plan_key: 'primary',
      },
    }));

    const body = res.body as { id: string; logical_key: string; title: string | null };
    expect(body.logical_key).toBe('session:sess-key-plan:key:primary');
    expect(body.title).toBe('Primary');
    expect(getPlan(body.id)?.source_path).toBeNull();
  });

  it('returns 404 when the session does not exist', async () => {
    const { handleSavePlan } = makeHandlers();
    const res = await handleSavePlan(makeRequest({
      body: {
        session_id: 'missing-session',
        content: '# Missing',
        plan_key: 'primary',
      },
    }));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'session-not-found' } });
  });
});
