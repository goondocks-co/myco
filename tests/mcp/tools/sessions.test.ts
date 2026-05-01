/**
 * Tests for myco_sessions tool handler.
 *
 * `op:list` reads via `listSessionsForMcp` against the in-process DB (no HTTP).
 * `op:get` still proxies through DaemonClient to /api/sessions/:id, so that path
 * keeps its mock-based test.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSessions } from '@myco/tools/sessions.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
}

function seedSession(input: {
  id: string;
  agent?: string;
  status?: string;
  title?: string;
  summary?: string;
  branch?: string | null;
  user?: string | null;
  started_at?: number;
  prompt_count?: number;
  tool_count?: number;
}): void {
  const db = getDatabase();
  const startedAt = input.started_at ?? 1700000000;
  db.prepare(`
    INSERT INTO sessions (
      id, agent, "user", branch, started_at, status, title, summary,
      prompt_count, tool_count, created_at, machine_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')
  `).run(
    input.id,
    input.agent ?? 'claude-code',
    input.user ?? null,
    input.branch ?? null,
    startedAt,
    input.status ?? 'completed',
    input.title ?? null,
    input.summary ?? '',
    input.prompt_count ?? 0,
    input.tool_count ?? 0,
    startedAt,
  );
}

describe('myco_sessions op:list (in-process)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('lists sessions from the DB', async () => {
    seedSession({ id: 'sess-1', title: 'Auth Refactor', status: 'completed' });
    seedSession({ id: 'sess-2', title: 'Current Work', status: 'active' });

    const results = await handleMycoSessions({}, mockClient()) as Array<{ id: string }>;
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('filters by status', async () => {
    seedSession({ id: 'sess-1', status: 'completed' });
    seedSession({ id: 'sess-2', status: 'active' });

    const results = await handleMycoSessions({ status: 'active' }, mockClient()) as Array<{ id: string; status: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('sess-2');
  });

  it('respects limit', async () => {
    seedSession({ id: 'sess-1', started_at: 1700000000 });
    seedSession({ id: 'sess-2', started_at: 1700000100 });
    seedSession({ id: 'sess-3', started_at: 1700000200 });

    const results = await handleMycoSessions({ limit: 1 }, mockClient()) as Array<{ id: string }>;
    expect(results).toHaveLength(1);
  });

  it('returns empty when DB has no sessions', async () => {
    const results = await handleMycoSessions({}, mockClient()) as Array<unknown>;
    expect(results).toEqual([]);
  });

  it('returns session summaries with the expected projection', async () => {
    seedSession({
      id: 'sess-1',
      agent: 'claude-code',
      title: 'Auth Refactor',
      status: 'completed',
      started_at: 1700000000,
    });

    const results = await handleMycoSessions({}, mockClient()) as Array<{
      agent: string | null;
      title: string | null;
      status: string;
      started_at: number;
    }>;
    const session = results[0];
    expect(session.agent).toBe('claude-code');
    expect(session.title).toBe('Auth Refactor');
    expect(session.status).toBe('completed');
    expect(typeof session.started_at).toBe('number');
  });
});

describe('myco_sessions op:get (HTTP, unchanged)', () => {
  it('fetches single session via /api/sessions/:id', async () => {
    const client = mockClient({ id: 'sess-1', title: 'Detail' });
    const result = await handleMycoSessions({ op: 'get', id: 'sess-1' }, client);
    expect(result).toEqual({ id: 'sess-1', title: 'Detail' });
    expect(client.get).toHaveBeenCalledWith('/api/sessions/sess-1');
  });

  it('returns structured not-found on missing session', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoSessions({ op: 'get', id: 'missing' }, client);
    expect(result).toEqual({ ok: false, error: 'Session not found' });
  });

  it('rejects op:get without id', async () => {
    const client = mockClient({});
    const result = await handleMycoSessions({ op: 'get' }, client);
    expect(result).toEqual({ ok: false, error: 'id is required for op: get' });
    expect(client.get).not.toHaveBeenCalled();
  });
});
