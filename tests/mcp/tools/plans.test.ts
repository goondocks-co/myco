/**
 * Tests for myco_plans tool handler.
 *
 * The list-op tests mock DaemonClient to verify endpoint shape. The delete-op
 * tests spin up a real DaemonServer with the real /api/plans/:id route and
 * drive the real DaemonClient, so the 403 / force_remote / local branches of
 * handleDeletePlan are actually exercised end-to-end (Bundle D spec review
 * flagged this surface as under-covered).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleMycoPlans } from '@myco/tools/plans.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { createSessionMutationHandlers } from '@myco/daemon/api/sessions.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { upsertPlan, getPlan } from '@myco/db/queries/plans.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { initTeamContext } from '@myco/daemon/team-context.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
    delete: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_plans op: list (default)', () => {
  it('lists plans from daemon response', async () => {
    const plans = [
      { id: 'auth', title: 'Auth Redesign', status: 'active', progress: '1/2', tags: [], created_at: 1700000000 },
      { id: 'done', title: 'Completed Plan', status: 'completed', progress: '1/1', tags: [], created_at: 1699999900 },
    ];
    const client = mockClient({ plans });

    const results = await handleMycoPlans({}, client);
    expect(Array.isArray(results)).toBe(true);
    expect((results as unknown[]).length).toBe(2);
  });

  it('passes status filter to daemon', async () => {
    const client = mockClient({ plans: [{ id: 'auth', title: 'Auth', status: 'active', progress: '1/2', tags: [], created_at: 1700000000 }] });

    const results = await handleMycoPlans({ status: 'active' }, client);
    expect((results as unknown[]).length).toBe(1);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('status=active'));
  });

  it('returns empty on daemon failure', async () => {
    const client = mockClient(null, false);
    const results = await handleMycoPlans({}, client);
    expect(results).toEqual([]);
  });

  it('passes limit to daemon', async () => {
    const client = mockClient({ plans: [] });
    await handleMycoPlans({ limit: 5 }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('limit=5'));
  });

  it('forwards id to daemon for op: get', async () => {
    const client = mockClient({
      plans: [{
        id: 'plan-auth',
        title: 'Auth',
        status: 'active',
        progress: '0/3',
        tags: [],
        created_at: 1700000000,
        content: '# Plan content here',
      }],
    });
    await handleMycoPlans({ op: 'get', id: 'plan-auth' }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('id=plan-auth'));
  });

  it('surfaces plan content on op: get response', async () => {
    const content = '# Auth Redesign\n\n- [x] Step 1\n- [ ] Step 2';
    const client = mockClient({
      plans: [{ id: 'plan-auth', title: 'Auth', status: 'active', progress: '1/2', tags: [], created_at: 1700000000, content }],
    });
    const result = await handleMycoPlans({ op: 'get', id: 'plan-auth' }, client);
    expect((result as { content?: string }).content).toBe(content);
  });

  it('forwards session filter to daemon', async () => {
    const client = mockClient({ plans: [] });
    await handleMycoPlans({ session: 'sess-abc' }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('session=sess-abc'));
  });

  it('refuses both id and session in same list call with a structured error', async () => {
    const client = mockClient({ plans: [] });
    const result = await handleMycoPlans({ id: 'p1', session: 'sess-1' }, client);
    // Match the daemon's /api/mcp/plans 400 behavior — surface the rejection
    // explicitly so agents can correct the call, rather than swallowing into [].
    expect(result).toEqual({ ok: false, error: 'Pass either id or session, not both' });
    // No HTTP roundtrip should happen when the input is contradictory.
    expect(client.get).not.toHaveBeenCalled();
  });

  it('explicit op: "list" works the same as default', async () => {
    const plans = [{ id: 'auth', title: 'A', status: 'active', progress: '0/0', tags: [], created_at: 0 }];
    const client = mockClient({ plans });
    const r = await handleMycoPlans({ op: 'list' }, client);
    expect((r as unknown[]).length).toBe(1);
  });
});

/**
 * Integration suite — drives handleMycoPlans through the real DaemonClient
 * and a real in-process DaemonServer so handleDeletePlan's ownership check
 * actually runs. Catches two regressions:
 *   1. Silent fallback to 'delete_failed' when the daemon returned a helpful
 *      403 body (Wrong #2 from Bundle D review).
 *   2. Any future route-level behavior change (e.g. status code, error
 *      wording) that the hand-mocked tests would miss.
 */
describe('myco_plans op: delete (integration against real HTTP router)', () => {
  const LOCAL_MACHINE = 'local-machine';
  const REMOTE_MACHINE = 'other-machine';

  let vaultDir: string;
  let server: DaemonServer;
  let logger: DaemonLogger;
  let client: DaemonClient;
  let now: number;

  beforeAll(async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plans-delete-'));
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
    setupTestDb();

    // Pin the daemon's machine identity so we can deterministically seed
    // rows that are "local" vs "remote" relative to this test.
    initTeamContext(false, LOCAL_MACHINE);

    server = new DaemonServer({ vaultDir, logger });

    const embeddingManager = {
      onRemoved: vi.fn(),
      remove: vi.fn(),
      reconcile: vi.fn(),
    } as never;
    const sessionMut = createSessionMutationHandlers({
      embeddingManager,
      vaultDir,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
    });
    server.registerRoute('DELETE', '/api/plans/:id', sessionMut.handleDeletePlan);

    await server.start();

    // Write daemon.json so DaemonClient can discover the test server.
    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({ pid: process.pid, port: server.port }),
    );

    client = new DaemonClient(vaultDir);
  });

  afterAll(async () => {
    await server.stop();
    logger.close();
    teardownTestDb();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    cleanTestDb();
    now = Math.floor(Date.now() / 1000);
    registerAgent({ id: 'myco-agent', name: 'Test', created_at: now });
    upsertSession({ id: 'sess-1', agent: 'myco-agent', started_at: now, created_at: now });
  });

  it('requires id', async () => {
    // Input validation happens before any HTTP roundtrip, so a mock client
    // suffices for this shape check.
    const mc = mockClient({ ok: true });
    const result = await handleMycoPlans({ op: 'delete' }, mc);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('id is required') });
    expect(mc.delete).not.toHaveBeenCalled();
  });

  it('calls DELETE /api/plans/:id without body when local', async () => {
    upsertPlan({
      id: 'plan-local',
      logical_key: 'session:sess-1:key:primary',
      session_id: 'sess-1',
      title: 'Local plan',
      content: '# local',
      created_at: now,
      machine_id: LOCAL_MACHINE,
    });

    const result = await handleMycoPlans({ op: 'delete', id: 'plan-local' }, client);

    expect(result).toMatchObject({ ok: true, id: 'plan-local', session_id: 'sess-1' });
    expect(getPlan('plan-local')).toBeNull();
  });

  it('forwards force_remote to the daemon when set', async () => {
    upsertPlan({
      id: 'plan-remote-force',
      logical_key: 'session:sess-1:key:force',
      session_id: 'sess-1',
      title: 'Remote plan (force)',
      content: '# remote',
      created_at: now,
      machine_id: REMOTE_MACHINE,
    });

    const result = await handleMycoPlans(
      { op: 'delete', id: 'plan-remote-force', force_remote: true },
      client,
    );

    expect(result).toMatchObject({ ok: true, id: 'plan-remote-force' });
    expect(getPlan('plan-remote-force')).toBeNull();
  });

  it('surfaces the daemon-side rejection when force_remote is omitted for a remote plan', async () => {
    upsertPlan({
      id: 'plan-remote-naked',
      logical_key: 'session:sess-1:key:naked',
      session_id: 'sess-1',
      title: 'Remote plan (no force)',
      content: '# remote',
      created_at: now,
      machine_id: REMOTE_MACHINE,
    });

    const result = await handleMycoPlans(
      { op: 'delete', id: 'plan-remote-naked' },
      client,
    );

    // Wrong #2 fix: the real 403 body must reach the MCP caller instead of
    // the generic 'delete_failed' string.
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('force_remote'),
    });
    // Row must still exist — the daemon rejected the delete.
    expect(getPlan('plan-remote-naked')).not.toBeNull();
  });
});
