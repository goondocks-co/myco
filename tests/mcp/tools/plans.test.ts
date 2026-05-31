/**
 * Tests for myco_plans tool handler.
 *
 * `op:list` and `op:get` call the in-process service `listPlansForMcp` against
 * a real in-memory DB. `op:delete` still goes through the daemon's regular
 * `/api/plans/:id` REST endpoint, so that suite drives a real DaemonServer
 * end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleMycoPlans } from '@myco/tools/plans.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { DaemonServer } from '@myco/daemon/server.js';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { createSessionMutationHandlers } from '@myco/daemon/api/sessions.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { upsertPlan, getPlan } from '@myco/db/queries/plans.js';
import { recordImportMapping } from '@myco/db/queries/migration-import-journal.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { getDatabase } from '@myco/db/client.js';
import { initTeamContext } from '@myco/daemon/team-context.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { makeTestRequestContext } from '../../helpers/request-context.js';
import { listGraphEdges } from '@myco/db/queries/graph-edges.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
    delete: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
}

const VAULT_DIR_FOR_TESTS = path.join(os.tmpdir(), 'myco-plans-test-stub');
fs.mkdirSync(VAULT_DIR_FOR_TESTS, { recursive: true });
ensureProjectManifest(VAULT_DIR_FOR_TESTS, { projectName: 'plans-test-stub' });

function seedSession(id: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, agent, started_at, created_at, machine_id, status)
    VALUES (?, 'claude-code', ?, ?, 'local', 'active')
  `).run(id, 1700000000, 1700000000);
}

function seedPlan(input: {
  id: string;
  logical_key: string;
  title?: string;
  status?: string;
  content?: string;
  tags?: string;
  session_id?: string;
  project_id?: string | null;
  created_at?: number;
}): void {
  upsertPlan({
    id: input.id,
    logical_key: input.logical_key,
    project_id: input.project_id,
    title: input.title ?? null,
    content: input.content ?? null,
    tags: input.tags ?? null,
    status: input.status ?? 'active',
    session_id: input.session_id ?? null,
    created_at: input.created_at ?? 1700000000,
    machine_id: 'local',
  });
}

describe('myco_plans op: list / get (in-process)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('lists plans from the DB', async () => {
    seedPlan({ id: 'auth', logical_key: 'session:s:key:auth', title: 'Auth Redesign', status: 'active', content: '- [x] one\n- [ ] two' });
    seedPlan({ id: 'done', logical_key: 'session:s:key:done', title: 'Completed Plan', status: 'completed', content: '- [x] one' });

    const results = await handleMycoPlans({}, mockClient(), VAULT_DIR_FOR_TESTS);
    expect(Array.isArray(results)).toBe(true);
    expect((results as unknown[]).length).toBe(2);
  });

  it('filters by status', async () => {
    seedPlan({ id: 'auth', logical_key: 'session:s:key:auth', status: 'active', content: '' });
    seedPlan({ id: 'done', logical_key: 'session:s:key:done', status: 'completed', content: '' });

    const results = await handleMycoPlans({ status: 'active' }, mockClient(), VAULT_DIR_FOR_TESTS) as Array<{ id: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('auth');
  });

  it('respects limit', async () => {
    seedPlan({ id: 'a', logical_key: 'session:s:key:a', created_at: 1700000000, content: '' });
    seedPlan({ id: 'b', logical_key: 'session:s:key:b', created_at: 1700000100, content: '' });
    seedPlan({ id: 'c', logical_key: 'session:s:key:c', created_at: 1700000200, content: '' });

    const results = await handleMycoPlans({ limit: 1 }, mockClient(), VAULT_DIR_FOR_TESTS) as unknown[];
    expect(results).toHaveLength(1);
  });

  it('returns empty array when DB has no plans', async () => {
    const results = await handleMycoPlans({}, mockClient(), VAULT_DIR_FOR_TESTS);
    expect(results).toEqual([]);
  });

  it('op:get returns a single plan with content', async () => {
    seedSession('sess-1');
    const content = '# Auth Redesign\n\n- [x] Step 1\n- [ ] Step 2';
    seedPlan({ id: 'plan-auth', logical_key: 'session:sess-1:key:auth', title: 'Auth', session_id: 'sess-1', content });

    const result = await handleMycoPlans({ op: 'get', id: 'plan-auth' }, mockClient(), VAULT_DIR_FOR_TESTS) as { id: string; content: string };
    expect(result.id).toBe('plan-auth');
    expect(result.content).toBe(content);
  });

  it('op:get resolves pre-migration plan ids through the import journal in Grove scope', async () => {
    const projectId = 'proj_current';
    const groveId = 'grove_current';
    const content = '# Migrated Plan\n\nPreserved after rekey.';
    seedPlan({
      id: 'plan_new',
      logical_key: 'legacy:old-plan',
      project_id: projectId,
      title: 'Migrated',
      content,
    });
    recordImportMapping({
      migration_id: 'mig_current',
      source_project_root: '/legacy/project',
      source_db_path: '/legacy/project/.myco/myco.db',
      target_grove_id: groveId,
      target_project_id: projectId,
      source_table: 'plans',
      source_id: 'old-plan',
      target_table: 'plans',
      target_id: 'plan_new',
      status: 'imported',
    });

    const result = await handleMycoPlans({ op: 'get', id: 'old-plan' }, mockClient(), {
      projectRoot: '/legacy/project',
      projectId,
      groveId,
      machineId: 'machine',
      sessionId: null,
      projectVaultDir: '/legacy/project/.myco',
      databasePath: ':memory:',
      source: 'explicit',
    }) as { id: string; content: string };

    expect(result.id).toBe('plan_new');
    expect(result.content).toBe(content);
  });

  it('op:get returns Plan-not-found when the id is unknown', async () => {
    const result = await handleMycoPlans({ op: 'get', id: 'nope' }, mockClient(), VAULT_DIR_FOR_TESTS);
    expect(result).toEqual({ ok: false, error: 'Plan not found' });
  });

  it('filters by session', async () => {
    seedSession('sess-a');
    seedSession('sess-b');
    seedPlan({ id: 'a1', logical_key: 'session:sess-a:key:1', session_id: 'sess-a', content: '' });
    seedPlan({ id: 'b1', logical_key: 'session:sess-b:key:1', session_id: 'sess-b', content: '' });

    const results = await handleMycoPlans({ session: 'sess-a' }, mockClient(), VAULT_DIR_FOR_TESTS) as Array<{ id: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a1');
  });

  it('refuses both id and session in same list call with a structured error', async () => {
    const result = await handleMycoPlans({ id: 'p1', session: 'sess-1' }, mockClient(), VAULT_DIR_FOR_TESTS);
    expect(result).toEqual({ ok: false, error: 'Pass either id or session, not both' });
  });

  it('explicit op: "list" works the same as default', async () => {
    seedPlan({ id: 'auth', logical_key: 'session:s:key:auth', status: 'active', content: '' });
    const r = await handleMycoPlans({ op: 'list' }, mockClient(), VAULT_DIR_FOR_TESTS) as unknown[];
    expect(r).toHaveLength(1);
  });

  // --- Cross-session lineage (Phase 2) ---

  it('records a PLAN_REFERENCED edge when a different session does op:get', async () => {
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'myco-agent', created_at: 1700000000 });
    seedSession('creator-session');
    const created = await handleMycoPlans(
      { op: 'save', session_id: 'creator-session', content: '# P', plan_key: 'p' },
      mockClient(),
      makeTestRequestContext({ sessionId: 'creator-session' }),
    ) as { ok: true; id: string };
    expect(created.ok).toBe(true);
    seedSession('reader-session');

    await handleMycoPlans(
      { op: 'get', id: created.id },
      mockClient(),
      makeTestRequestContext({ sessionId: 'reader-session' }),
    );

    const edges = listGraphEdges({ sourceId: created.id, scope: ALL_PROJECTS_SCOPE });
    expect(edges.some((e) => e.target_id === 'reader-session' && e.type === 'PLAN_REFERENCED')).toBe(true);
  });

  it('does NOT record an edge when the creating session does op:get', async () => {
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'myco-agent', created_at: 1700000000 });
    seedSession('solo-session');
    const created = await handleMycoPlans(
      { op: 'save', session_id: 'solo-session', content: '# P2', plan_key: 'p2' },
      mockClient(),
      makeTestRequestContext({ sessionId: 'solo-session' }),
    ) as { ok: true; id: string };

    await handleMycoPlans(
      { op: 'get', id: created.id },
      mockClient(),
      makeTestRequestContext({ sessionId: 'solo-session' }),
    );

    expect(listGraphEdges({ sourceId: created.id, scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });

  it('op:save update from another session emits PLAN_ADVANCED and keeps the creator immutable', async () => {
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'myco-agent', created_at: 1700000000 });
    seedSession('creatorB');
    const created = await handleMycoPlans(
      { op: 'save', session_id: 'creatorB', content: '# Q', plan_key: 'q' },
      mockClient(),
      makeTestRequestContext({ sessionId: 'creatorB' }),
    ) as { ok: true; id: string };
    seedSession('editorB');

    const res = await handleMycoPlans(
      { op: 'save', id: created.id, session_id: 'editorB', status: 'completed' },
      mockClient(),
      makeTestRequestContext({ sessionId: 'editorB' }),
    ) as { ok: boolean };
    expect(res.ok).toBe(true);

    const row = getPlan(created.id, ALL_PROJECTS_SCOPE);
    expect(row?.session_id).toBe('creatorB'); // creator preserved despite session_id=editorB in the update
    const edges = listGraphEdges({ sourceId: created.id, scope: ALL_PROJECTS_SCOPE });
    expect(edges.some((e) => e.target_id === 'editorB' && e.type === 'PLAN_ADVANCED')).toBe(true);
  });
});

/**
 * Integration suite — drives handleMycoPlans through the real DaemonClient
 * and a real in-process DaemonServer so handleDeletePlan's ownership check
 * actually runs.
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
    ensureProjectManifest(vaultDir, { projectName: 'plans-delete-test' });
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
    setupTestDb();

    initTeamContext(LOCAL_MACHINE);

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

    const statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({ pid: process.pid, port: server.port }),
    );

    client = new DaemonClient(vaultDir);
  });

  afterAll(async () => {
    await server.stop();
    logger.close();
    try { fs.unlinkSync(resolveServiceDaemonStatePath()); } catch { /* gone */ }
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
    const mc = mockClient({ ok: true });
    const result = await handleMycoPlans({ op: 'delete' }, mc, vaultDir);
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

    const result = await handleMycoPlans({ op: 'delete', id: 'plan-local' }, client, vaultDir);

    expect(result).toMatchObject({ ok: true, id: 'plan-local', session_id: 'sess-1' });
    expect(getPlan('plan-local', ALL_PROJECTS_SCOPE)).toBeNull();
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
      vaultDir,
    );

    expect(result).toMatchObject({ ok: true, id: 'plan-remote-force' });
    expect(getPlan('plan-remote-force', ALL_PROJECTS_SCOPE)).toBeNull();
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
      vaultDir,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('force_remote'),
    });
    expect(getPlan('plan-remote-naked', ALL_PROJECTS_SCOPE)).not.toBeNull();
  });
});
