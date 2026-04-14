import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { upsertSession, getSession } from '@myco/db/queries/sessions';
import { createSessionMutationHandlers } from '@myco/daemon/api/sessions';
import type { RouteRequest } from '@myco/daemon/router';

/**
 * Handlers depend on an EmbeddingManager for the delete path; the complete
 * path doesn't touch it, so a stub with the interface shape is enough.
 */
function makeEmbeddingManagerStub(): unknown {
  return { remove: vi.fn(), reconcile: vi.fn() };
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    ...overrides,
  } as RouteRequest;
}

const epochNow = () => Math.floor(Date.now() / 1000);

describe('handleCompleteSession', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sessions-api-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers() {
    // `event_tasks_enabled: false` short-circuits triggerTitleSummary before
    // it tries to dynamic-import the agent executor — test isolation without
    // needing to mock the whole module.
    const config = {
      agent: { summary_batch_interval: 5, event_tasks_enabled: false },
    };
    return createSessionMutationHandlers({
      embeddingManager: makeEmbeddingManagerStub() as never,
      vaultDir: tmpDir,
      logger: makeLogger() as never,
      config: config as never,
    });
  }

  it('flips an active session to completed and sets ended_at', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-active',
      agent: 'test-agent',
      started_at: now,
      created_at: now,
      status: 'active',
    });

    const { handleCompleteSession } = makeHandlers();
    const res = await handleCompleteSession(makeRequest({ params: { id: 'sess-active' } }));

    expect(res.status === undefined || res.status < 400).toBe(true);
    expect((res.body as { ok: boolean; was_active: boolean })).toMatchObject({
      ok: true,
      was_active: true,
    });

    const after = getSession('sess-active');
    expect(after?.status).toBe('completed');
    expect(after?.ended_at).toBeGreaterThanOrEqual(now);
  });

  it('is idempotent — re-completing a completed session does not rewrite ended_at', async () => {
    const now = epochNow();
    const originalEnd = now - 100;
    upsertSession({
      id: 'sess-done',
      agent: 'test-agent',
      started_at: now - 200,
      created_at: now - 200,
      status: 'completed',
      ended_at: originalEnd,
    });

    const { handleCompleteSession } = makeHandlers();
    const res = await handleCompleteSession(makeRequest({ params: { id: 'sess-done' } }));

    expect((res.body as { ok: boolean; was_active: boolean })).toMatchObject({
      ok: true,
      was_active: false,
    });

    const after = getSession('sess-done');
    expect(after?.status).toBe('completed');
    expect(after?.ended_at).toBe(originalEnd);
  });

  it('returns 404 for a missing session', async () => {
    const { handleCompleteSession } = makeHandlers();
    const res = await handleCompleteSession(makeRequest({ params: { id: 'missing' } }));
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('Session not found');
  });
});
