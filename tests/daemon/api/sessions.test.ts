import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { upsertSession, getSession } from '@myco/db/queries/sessions';
import { insertBatch, PROMPT_BATCH_ORIGIN } from '@myco/db/queries/batches';
import { getSessionTombstone } from '@myco/db/queries/session-tombstones.js';
import { upsertPlan, getPlan } from '@myco/db/queries/plans';
import { createSessionMutationHandlers, createGetSessionHandler, handleListSessions } from '@myco/daemon/api/sessions';
import { initTeamContext, resetTeamContext } from '@myco/team/context.js';
import type { RouteRequest } from '@myco/daemon/router';
import { resolveLegacyRequestContext } from '@myco/grove/request-context';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
/**
 * Handlers depend on an EmbeddingManager for the delete path; the complete
 * path doesn't touch it, so a stub with the interface shape is enough.
 */
function makeEmbeddingManagerStub(): unknown {
  return { remove: vi.fn(), reconcile: vi.fn(), onRemoved: vi.fn() };
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    requestContext: TEST_REQUEST_CONTEXT,
    ...overrides,
  } as RouteRequest;
}

function requestContext(vaultDir: string, projectId: string) {
  return resolveLegacyRequestContext(vaultDir, {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
    // Explicit project/grove pivot = caller-asserted tenancy. The scope seam
    // (projectScopeFromRequestContext) binds a Grove-bound context to its
    // project scope ONLY when tenancy is caller-asserted; a synthesized
    // context resolves to GLOBAL_SCOPE.
    tenancySource: 'caller',
  });
}

const epochNow = () => Math.floor(Date.now() / 1000);

describe('session API request context scoping', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sessions-scope-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists only sessions in the requested project context', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agent: 'test-agent', started_at: now, created_at: now });
    upsertSession({ id: 'sess-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', agent: 'test-agent', started_at: now, created_at: now });

    const res = await handleListSessions(makeRequest({
      requestContext: requestContext(tmpDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }));

    const body = res.body as { sessions: Array<{ id: string }>; total: number };
    expect(body.sessions.map((session) => session.id)).toEqual(['sess-a']);
    expect(body.total).toBe(1);
  });

  it('returns activity_buckets and branch on every list row', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-bucketed',
      project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      agent: 'test-agent',
      branch: 'feat/test-branch',
      started_at: now,
      created_at: now,
    });

    const res = await handleListSessions(makeRequest({
      requestContext: requestContext(tmpDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }));

    const body = res.body as { sessions: Array<{ id: string; branch: string | null; activity_buckets: number[] }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].branch).toBe('feat/test-branch');
    expect(body.sessions[0].activity_buckets).toHaveLength(8);
    expect(body.sessions[0].activity_buckets.every((n) => n === 0)).toBe(true);
  });

  it('does not return a session from a different project context', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-other', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', agent: 'test-agent', started_at: now, created_at: now });
    const handler = createGetSessionHandler();

    const res = await handler(makeRequest({
      params: { id: 'sess-other' },
      requestContext: requestContext(tmpDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });
});

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
    const liveConfig = {
      current: {
        agent: { summary_batch_interval: 5, event_tasks_enabled: false },
      },
    };
    return createSessionMutationHandlers({
      embeddingManager: makeEmbeddingManagerStub() as never,
      resolveEmbeddingManager: () => makeEmbeddingManagerStub() as never,
      vaultDir: tmpDir,
      logger: makeLogger() as never,
      liveConfig: liveConfig as never,
      reconciler: { clearSession: vi.fn() },
      registry: { unregister: vi.fn(), getSession: vi.fn(() => undefined) },
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

    const after = getSession('sess-active', ALL_PROJECTS_SCOPE);
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

    const after = getSession('sess-done', ALL_PROJECTS_SCOPE);
    expect(after?.status).toBe('completed');
    expect(after?.ended_at).toBe(originalEnd);
  });

  it('returns 404 for a missing session', async () => {
    const { handleCompleteSession } = makeHandlers();
    const res = await handleCompleteSession(makeRequest({ params: { id: 'missing' } }));
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('Session not found');
  });

  it('handleDeleteSession ALSO clears the in-memory registry — invariant', async () => {
    // Regression: prior to this guard, cascade-delete cleared the DB
    // and the reconciler cache but left the in-memory registry
    // populated. The dispatcher's auto-register-and-reconcile branch
    // is gated on `registry.getSession(sessionId)`, so a stale
    // registry entry caused the next event for the deleted id to
    // skip reconcile entirely — the buffered prompts for the
    // deleted session became orphaned forever, and the defensive
    // `ensureSessionRowExists` materialized an empty row.
    //
    // The fix: cascade-delete must also call
    // `registry.unregister(sessionId)`, mirroring the unregister
    // path in `session-lifecycle.ts`. This test pins the contract.
    const now = epochNow();
    upsertSession({
      id: 'sess-delete-clear-registry',
      agent: 'test-agent',
      started_at: now,
      created_at: now,
      status: 'completed',
    });

    const liveConfig = {
      current: {
        agent: { summary_batch_interval: 5, event_tasks_enabled: false },
      },
    };
    const reconcilerStub = { clearSession: vi.fn() };
    const registryStub = { unregister: vi.fn(), getSession: vi.fn(() => undefined) };
    const handlers = createSessionMutationHandlers({
      embeddingManager: makeEmbeddingManagerStub() as never,
      resolveEmbeddingManager: () => makeEmbeddingManagerStub() as never,
      vaultDir: tmpDir,
      logger: makeLogger() as never,
      liveConfig: liveConfig as never,
      reconciler: reconcilerStub,
      registry: registryStub,
    });

    await handlers.handleDeleteSession(makeRequest({ params: { id: 'sess-delete-clear-registry' } }));

    expect(reconcilerStub.clearSession).toHaveBeenCalledWith('sess-delete-clear-registry');
    expect(registryStub.unregister).toHaveBeenCalledWith('sess-delete-clear-registry');
  });

  it('handleDeleteSession writes an api_delete tombstone so the reconciler never resurrects the id', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-delete-tombstone',
      agent: 'test-agent',
      started_at: now,
      created_at: now,
      status: 'completed',
    });

    const { handleDeleteSession } = makeHandlers();
    await handleDeleteSession(makeRequest({ params: { id: 'sess-delete-tombstone' } }));

    expect(getSession('sess-delete-tombstone', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(getSessionTombstone('sess-delete-tombstone')?.source).toBe('api_delete');
  });

  it('resolves the grove embedding manager from the request context for cascade cleanup (anchor-leak guard)', async () => {
    // The cleanup-cascade must remove vectors from the run's grove store, not
    // the daemon bootstrap manager (which would orphan the grove's vectors and
    // miss the project's on-disk files). Assert it resolves per request context.
    const now = epochNow();
    upsertSession({ id: 'sess-cleanup-scope', agent: 'test-agent', started_at: now, created_at: now, status: 'completed' });
    let seen: unknown = 'NOT_CALLED';
    const handlers = createSessionMutationHandlers({
      embeddingManager: makeEmbeddingManagerStub() as never,
      resolveEmbeddingManager: (rc) => { seen = rc; return makeEmbeddingManagerStub() as never; },
      vaultDir: tmpDir,
      logger: makeLogger() as never,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
      reconciler: { clearSession: vi.fn() },
      registry: { unregister: vi.fn(), getSession: vi.fn(() => undefined) },
    });
    await handlers.handleDeleteSession(makeRequest({ params: { id: 'sess-cleanup-scope' } }));
    expect(seen).toBe(TEST_REQUEST_CONTEXT);
  });
});

describe('handleDeleteSession — live-session guard', () => {
  // RC-A: deleting a session with a live agent connection silently raced
  // the event stream (the next event resurrected the id). The handler now
  // refuses with 409 session_live unless the caller re-sends {force: true}
  // — the handleDeletePlan force_remote precedent.
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sessions-live-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers(registryStub: { unregister: ReturnType<typeof vi.fn>; getSession: ReturnType<typeof vi.fn> }) {
    return createSessionMutationHandlers({
      embeddingManager: makeEmbeddingManagerStub() as never,
      resolveEmbeddingManager: () => makeEmbeddingManagerStub() as never,
      vaultDir: tmpDir,
      logger: makeLogger() as never,
      liveConfig: { current: { agent: { summary_batch_interval: 5, event_tasks_enabled: false } } } as never,
      reconciler: { clearSession: vi.fn() },
      registry: registryStub,
    });
  }

  it('refuses to delete a registered (live) session with 409 session_live and leaves the row intact', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-live-guard', agent: 'test-agent', started_at: now, created_at: now, status: 'active' });
    const registryStub = {
      unregister: vi.fn(),
      getSession: vi.fn(() => ({ startedAt: new Date().toISOString() })),
    };

    const { handleDeleteSession } = makeHandlers(registryStub);
    const res = await handleDeleteSession(makeRequest({ params: { id: 'sess-live-guard' } }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'session_live' });
    expect(getSession('sess-live-guard', ALL_PROJECTS_SCOPE)).not.toBeNull();
    expect(getSessionTombstone('sess-live-guard')).toBeNull();
    expect(registryStub.unregister).not.toHaveBeenCalled();
  });

  it('deletes a live session when the caller re-sends {force: true} — tombstone written, registry cleared', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-live-forced', agent: 'test-agent', started_at: now, created_at: now, status: 'active' });
    const registryStub = {
      unregister: vi.fn(),
      getSession: vi.fn(() => ({ startedAt: new Date().toISOString() })),
    };

    const { handleDeleteSession } = makeHandlers(registryStub);
    const res = await handleDeleteSession(makeRequest({
      params: { id: 'sess-live-forced' },
      body: { force: true },
    }));

    expect(res.status).toBeUndefined();
    expect(res.body).toMatchObject({ ok: true });
    expect(getSession('sess-live-forced', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(getSessionTombstone('sess-live-forced')?.source).toBe('api_delete');
    expect(registryStub.unregister).toHaveBeenCalledWith('sess-live-forced');
  });

  it('deletes a non-registered session without force (unchanged behavior)', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-not-live', agent: 'test-agent', started_at: now, created_at: now, status: 'completed' });
    const registryStub = { unregister: vi.fn(), getSession: vi.fn(() => undefined) };

    const { handleDeleteSession } = makeHandlers(registryStub);
    const res = await handleDeleteSession(makeRequest({ params: { id: 'sess-not-live' } }));

    expect(res.status).toBeUndefined();
    expect(res.body).toMatchObject({ ok: true });
    expect(getSession('sess-not-live', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(getSessionTombstone('sess-not-live')?.source).toBe('api_delete');
  });

  // -- RC-G: expect_empty phantom-delete contract -----------------------------
  // The hook's drop-path cleanup sends {expect_empty: true}. Emptiness (zero
  // human-origin batches) is the gate: an empty just-registered phantom
  // deletes even though it is registry-live; a session with real content
  // refuses regardless of force — the phantom-cleanup caller must never
  // destroy captured work (the codex parent-id/child-transcript confusion).

  function seedHumanBatch(sessionId: string): void {
    const now = epochNow();
    insertBatch({
      session_id: sessionId,
      origin: PROMPT_BATCH_ORIGIN.HUMAN,
      prompt_number: 1,
      user_prompt: 'a real captured user prompt',
      started_at: now,
      created_at: now,
    });
  }

  it('expect_empty deletes an empty just-registered session even though it is registry-live', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-phantom-empty', agent: 'codex', started_at: now, created_at: now, status: 'active' });
    const registryStub = {
      unregister: vi.fn(),
      getSession: vi.fn(() => ({ startedAt: new Date().toISOString() })),
    };

    const { handleDeleteSession } = makeHandlers(registryStub);
    const res = await handleDeleteSession(makeRequest({
      params: { id: 'sess-phantom-empty' },
      body: { expect_empty: true },
    }));

    expect(res.status).toBeUndefined();
    expect(res.body).toMatchObject({ ok: true });
    expect(getSession('sess-phantom-empty', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(getSessionTombstone('sess-phantom-empty')?.source).toBe('api_delete');
  });

  it('expect_empty deletes a session whose only batch is SYSTEM-origin — non-human batches carry no user intent', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-phantom-system', agent: 'codex', started_at: now, created_at: now, status: 'active' });
    insertBatch({
      session_id: 'sess-phantom-system',
      origin: PROMPT_BATCH_ORIGIN.SYSTEM,
      prompt_number: 1,
      user_prompt: '<skill> envelope injected by the agent',
      started_at: now,
      created_at: now,
    });
    const registryStub = {
      unregister: vi.fn(),
      getSession: vi.fn(() => ({ startedAt: new Date().toISOString() })),
    };

    const { handleDeleteSession } = makeHandlers(registryStub);
    const res = await handleDeleteSession(makeRequest({
      params: { id: 'sess-phantom-system' },
      body: { expect_empty: true },
    }));

    expect(res.status).toBeUndefined();
    expect(res.body).toMatchObject({ ok: true });
    expect(getSession('sess-phantom-system', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(getSessionTombstone('sess-phantom-system')?.source).toBe('api_delete');
  });

  it('expect_empty refuses a session WITH human batches — 409 session_not_empty, row intact, no tombstone', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-phantom-mistaken', agent: 'codex', started_at: now, created_at: now, status: 'active' });
    seedHumanBatch('sess-phantom-mistaken');
    const registryStub = { unregister: vi.fn(), getSession: vi.fn(() => undefined) };

    const { handleDeleteSession } = makeHandlers(registryStub);
    const res = await handleDeleteSession(makeRequest({
      params: { id: 'sess-phantom-mistaken' },
      body: { expect_empty: true },
    }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'session_not_empty' });
    expect(getSession('sess-phantom-mistaken', ALL_PROJECTS_SCOPE)).not.toBeNull();
    expect(getSessionTombstone('sess-phantom-mistaken')).toBeNull();
    expect(registryStub.unregister).not.toHaveBeenCalled();
  });

  it('expect_empty + force still refuses when non-empty — force does not override emptiness', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-phantom-forced', agent: 'codex', started_at: now, created_at: now, status: 'active' });
    seedHumanBatch('sess-phantom-forced');
    const registryStub = { unregister: vi.fn(), getSession: vi.fn(() => undefined) };

    const { handleDeleteSession } = makeHandlers(registryStub);
    const res = await handleDeleteSession(makeRequest({
      params: { id: 'sess-phantom-forced' },
      body: { expect_empty: true, force: true },
    }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'session_not_empty' });
    expect(getSession('sess-phantom-forced', ALL_PROJECTS_SCOPE)).not.toBeNull();
    expect(getSessionTombstone('sess-phantom-forced')).toBeNull();
  });

  it('plain force delete on a non-empty live session still works (operator path)', async () => {
    const now = epochNow();
    upsertSession({ id: 'sess-operator-force', agent: 'test-agent', started_at: now, created_at: now, status: 'active' });
    seedHumanBatch('sess-operator-force');
    const registryStub = {
      unregister: vi.fn(),
      getSession: vi.fn(() => ({ startedAt: new Date().toISOString() })),
    };

    const { handleDeleteSession } = makeHandlers(registryStub);
    const res = await handleDeleteSession(makeRequest({
      params: { id: 'sess-operator-force' },
      body: { force: true },
    }));

    expect(res.status).toBeUndefined();
    expect(res.body).toMatchObject({ ok: true });
    expect(getSession('sess-operator-force', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(getSessionTombstone('sess-operator-force')?.source).toBe('api_delete');
    expect(registryStub.unregister).toHaveBeenCalledWith('sess-operator-force');
  });
});

describe('handleDeletePlan', () => {
  let tmpDir: string;
  let embeddingManager: { onRemoved: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plans-api-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
    embeddingManager = { onRemoved: vi.fn() };
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers() {
    return createSessionMutationHandlers({
      embeddingManager: embeddingManager as never,
      resolveEmbeddingManager: () => embeddingManager as never,
      vaultDir: tmpDir,
      logger: makeLogger() as never,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
      reconciler: { clearSession: vi.fn() },
      registry: { unregister: vi.fn(), getSession: vi.fn(() => undefined) },
    });
  }

  it('deletes the plan row and removes its embedding', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-plan-delete',
      agent: 'test-agent',
      started_at: now,
      created_at: now,
    });
    upsertPlan({
      id: 'plan-delete',
      logical_key: 'session:sess-plan-delete:key:primary',
      session_id: 'sess-plan-delete',
      title: 'Delete me',
      content: '# Delete me',
      created_at: now,
    });

    const { handleDeletePlan } = makeHandlers();
    const res = await handleDeletePlan(makeRequest({ params: { id: 'plan-delete' } }));

    expect(res.status === undefined || res.status < 400).toBe(true);
    expect(getPlan('plan-delete', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(embeddingManager.onRemoved).toHaveBeenCalledWith('plans', 'plan-delete');
  });

  it('returns 404 when the plan does not exist', async () => {
    const { handleDeletePlan } = makeHandlers();
    const res = await handleDeletePlan(makeRequest({ params: { id: 'missing-plan' } }));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'plan-not-found' } });
  });

  it('does not delete a plan from a different project context', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-plan-other',
      project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      agent: 'test-agent',
      started_at: now,
      created_at: now,
    });
    upsertPlan({
      id: 'plan-other-project',
      project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      logical_key: 'session:sess-plan-other:key:primary',
      session_id: 'sess-plan-other',
      title: 'Do not delete',
      content: '# Do not delete',
      created_at: now,
    });

    const { handleDeletePlan } = makeHandlers();
    const res = await handleDeletePlan(makeRequest({
      params: { id: 'plan-other-project' },
      requestContext: requestContext(tmpDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }));

    expect(res.status).toBe(404);
    expect(getPlan('plan-other-project', projectScope('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as GroveProjectId))).not.toBeNull();
    expect(embeddingManager.onRemoved).not.toHaveBeenCalled();
  });
});

describe('handleDeletePlan — machine_id ownership', () => {
  let tmpDir: string;
  let embeddingManager: { onRemoved: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plans-ownership-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
    embeddingManager = { onRemoved: vi.fn() };
    // Simulate a team-sync-enabled daemon on a known local machine id.
    initTeamContext('local-machine-a');
  });

  afterEach(() => {
    closeDatabase();
    resetTeamContext();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers() {
    return createSessionMutationHandlers({
      embeddingManager: embeddingManager as never,
      resolveEmbeddingManager: () => embeddingManager as never,
      vaultDir: tmpDir,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
      reconciler: { clearSession: vi.fn() },
      registry: { unregister: vi.fn(), getSession: vi.fn(() => undefined) },
    });
  }

  function seedPlan(machineId: string) {
    const now = Math.floor(Date.now() / 1000);
    upsertSession({ id: 'sess-own', agent: 'a', started_at: now, created_at: now });
    upsertPlan({
      id: 'plan-owned',
      logical_key: 'session:sess-own:key:primary',
      session_id: 'sess-own',
      title: 't', content: 'c',
      created_at: now,
      machine_id: machineId,
    });
  }

  it('rejects DELETE for a plan owned by another machine (no force_remote)', async () => {
    seedPlan('some-other-machine');
    const { handleDeletePlan } = makeHandlers();
    const res = await handleDeletePlan(makeRequest({ params: { id: 'plan-owned' } }));
    expect(res.status).toBe(403);
    expect(getPlan('plan-owned', ALL_PROJECTS_SCOPE)).not.toBeNull();
    expect(embeddingManager.onRemoved).not.toHaveBeenCalled();
  });

  it('allows DELETE for a remote-owned plan when force_remote=true', async () => {
    seedPlan('some-other-machine');
    const { handleDeletePlan } = makeHandlers();
    const res = await handleDeletePlan(makeRequest({
      params: { id: 'plan-owned' },
      body: { force_remote: true },
    }));
    expect(res.status === undefined || res.status < 400).toBe(true);
    expect(getPlan('plan-owned', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(embeddingManager.onRemoved).toHaveBeenCalledWith('plans', 'plan-owned');
  });

  it('allows DELETE for a locally-owned plan without force_remote', async () => {
    seedPlan('local-machine-a');
    const { handleDeletePlan } = makeHandlers();
    const res = await handleDeletePlan(makeRequest({ params: { id: 'plan-owned' } }));
    expect(res.status === undefined || res.status < 400).toBe(true);
    expect(getPlan('plan-owned', ALL_PROJECTS_SCOPE)).toBeNull();
  });
});

describe('handlePatchPlan — status updates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plans-patch-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
    initTeamContext('local-machine-a');
  });

  afterEach(() => {
    closeDatabase();
    resetTeamContext();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers() {
    return createSessionMutationHandlers({
      embeddingManager: makeEmbeddingManagerStub() as never,
      resolveEmbeddingManager: () => makeEmbeddingManagerStub() as never,
      vaultDir: tmpDir,
      logger: makeLogger() as never,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
      reconciler: { clearSession: vi.fn() },
      registry: { unregister: vi.fn(), getSession: vi.fn(() => undefined) },
    });
  }

  function seedPatchPlan(machineId = 'local-machine-a') {
    const now = epochNow();
    upsertSession({
      id: 'sess-patch',
      agent: 'test-agent',
      started_at: now,
      created_at: now,
      machine_id: 'local-machine-a',
    });
    return upsertPlan({
      id: 'plan-patch',
      logical_key: 'session:sess-patch:key:primary',
      session_id: 'sess-patch',
      title: 'Patch Plan',
      content: '# Patch Plan\n\nKeep this body.',
      source_path: 'docs/plans/patch.md',
      tags: 'ui,status',
      status: 'active',
      created_at: now,
      updated_at: now,
      machine_id: machineId,
    });
  }

  it('PATCH transitions status through the shared write path and returns plan metadata', async () => {
    seedPatchPlan();
    const { handlePatchPlan } = makeHandlers();

    const res = await handlePatchPlan(makeRequest({
      params: { id: 'plan-patch' },
      body: { status: 'in_progress' },
    }));

    expect(res.status === undefined || res.status < 400).toBe(true);
    expect(res.body).toMatchObject({
      ok: true,
      id: 'plan-patch',
      status: 'in_progress',
      session_id: 'sess-patch',
    });
    expect((res.body as { updated_at?: number | null }).updated_at).not.toBeNull();
  });

  it('PATCH rejects invalid status with a canonical envelope', async () => {
    seedPatchPlan();
    const { handlePatchPlan } = makeHandlers();

    const res = await handlePatchPlan(makeRequest({
      params: { id: 'plan-patch' },
      body: { status: 'all' },
    }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: {
        code: 'invalid-plan-status',
        message: "Invalid plan status 'all'. Expected one of: active, in_progress, completed, abandoned.",
      },
    });
  });

  it('PATCH returns plan-not-found for a missing plan', async () => {
    const { handlePatchPlan } = makeHandlers();

    const res = await handlePatchPlan(makeRequest({
      params: { id: 'missing-plan' },
      body: { status: 'completed' },
    }));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'plan-not-found' } });
  });

  it('PATCH rejects remote-owned plans without a force path', async () => {
    seedPatchPlan('remote-machine-b');
    const { handlePatchPlan } = makeHandlers();

    const res = await handlePatchPlan(makeRequest({
      params: { id: 'plan-patch' },
      body: { status: 'completed' },
    }));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'cross-machine-plan-status' } });
    expect(getPlan('plan-patch', ALL_PROJECTS_SCOPE)?.status).toBe('active');
  });

  it('PATCH status-only update preserves content, title, session, source, logical key, and tags', async () => {
    const before = seedPatchPlan();
    const { handlePatchPlan } = makeHandlers();

    const res = await handlePatchPlan(makeRequest({
      params: { id: 'plan-patch' },
      body: { status: 'completed' },
    }));

    expect(res.status === undefined || res.status < 400).toBe(true);
    const after = getPlan('plan-patch', ALL_PROJECTS_SCOPE);
    expect(after?.status).toBe('completed');
    expect(after?.content).toBe(before.content);
    expect(after?.title).toBe(before.title);
    expect(after?.session_id).toBe(before.session_id);
    expect(after?.source_path).toBe(before.source_path);
    expect(after?.logical_key).toBe(before.logical_key);
    expect(after?.tags).toBe(before.tags);
  });

  it('PATCH status-only update preserves nullable legacy content and title', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-null-plan',
      agent: 'test-agent',
      started_at: now,
      created_at: now,
      machine_id: 'local-machine-a',
    });
    upsertPlan({
      id: 'plan-null-content',
      logical_key: 'session:sess-null-plan:file:docs/plans/null-content.md',
      session_id: 'sess-null-plan',
      title: null,
      content: null,
      source_path: 'docs/plans/null-content.md',
      tags: 'legacy',
      status: 'active',
      created_at: now,
      updated_at: now,
      machine_id: 'local-machine-a',
    });
    const { handlePatchPlan } = makeHandlers();

    const res = await handlePatchPlan(makeRequest({
      params: { id: 'plan-null-content' },
      body: { status: 'abandoned' },
    }));

    expect(res.status === undefined || res.status < 400).toBe(true);
    const after = getPlan('plan-null-content', ALL_PROJECTS_SCOPE);
    expect(after?.status).toBe('abandoned');
    expect(after?.content).toBeNull();
    expect(after?.title).toBeNull();
    expect(after?.source_path).toBe('docs/plans/null-content.md');
    expect(after?.content_hash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleGetSession — team-fanout fallback (recall parity with search)
// ---------------------------------------------------------------------------

describe('createGetSessionHandler — team fallback', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-get-session-team-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTeamClient(impl: (type: string, id: string) => Promise<Record<string, unknown> | null>) {
    const getRecord = vi.fn(impl);
    return { getRecord: getRecord as never } as unknown as {
      getRecord: typeof getRecord;
    };
  }

  it('local hit: returns local record with source=local and does not call the team', async () => {
    const now = epochNow();
    upsertSession({
      id: 'sess-local',
      agent: 'claude',
      started_at: now,
      created_at: now,
      status: 'active',
      title: 'local title',
    });

    const teamClient = makeTeamClient(async () => null);
    const handler = createGetSessionHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'sess-local' } }));
    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { id: string; source: string };
    expect(body.id).toBe('sess-local');
    expect(body.source).toBe('local');
    expect(teamClient.getRecord).not.toHaveBeenCalled();
  });

  it('local miss + team hit: returns team record tagged team:<machine_id>', async () => {
    const teamClient = makeTeamClient(async (type, id) => {
      expect(type).toBe('sessions');
      expect(id).toBe('sess-remote');
      return { id: 'sess-remote', machine_id: 'remote-node', title: 'from team' };
    });

    const handler = createGetSessionHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'sess-remote' } }));
    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { id: string; source: string; prompt_count: number | null; tool_count: number | null };
    expect(body.id).toBe('sess-remote');
    expect(body.source).toBe('team:remote-node');
    expect(body.prompt_count).toBeNull();
    expect(body.tool_count).toBeNull();
  });

  it('local miss + team miss: returns 404', async () => {
    const teamClient = makeTeamClient(async () => null);
    const handler = createGetSessionHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'absent' } }));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('local miss + team throws: returns 404 (team failures are non-blocking)', async () => {
    const teamClient = {
      getRecord: vi.fn(async () => {
        throw new Error('team down');
      }),
    };
    const handler = createGetSessionHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    // The handler itself must not throw — it simply returns 404.
    const res = await handler(makeRequest({ params: { id: 'broken' } }));
    expect(res.status).toBe(404);
  });

  it('local miss + team hit with own machine_id: falls through to 404 (no self-echo)', async () => {
    const teamClient = makeTeamClient(async () => ({
      id: 'sess-self',
      machine_id: 'local-machine',
      title: 'echoed back from team',
    }));

    const handler = createGetSessionHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'sess-self' } }));
    expect(res.status).toBe(404);
  });
});
