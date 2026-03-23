/**
 * Tests for myco_sessions tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoSessions } from '@myco/mcp/tools/sessions.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_sessions', () => {
  it('lists sessions from daemon response', async () => {
    const sessions = [
      { id: 'sess-1', agent: 'claude-code', user: null, branch: null, started_at: 1700000000, ended_at: null, status: 'completed', title: 'Auth Refactor', summary: 'Refactored JWT middleware.', prompt_count: 5, tool_count: 20, parent_session_id: null },
      { id: 'sess-2', agent: 'claude-code', user: null, branch: null, started_at: 1700000100, ended_at: null, status: 'active', title: 'Current Work', summary: 'Working on something.', prompt_count: 2, tool_count: 5, parent_session_id: null },
    ];
    const client = mockClient({ sessions });

    const results = await handleMycoSessions({}, client);
    expect(results).toHaveLength(2);
  });

  it('passes status filter to daemon', async () => {
    const client = mockClient({ sessions: [{ id: 'sess-2', agent: 'claude-code', status: 'active' }] });

    const results = await handleMycoSessions({ status: 'active' }, client);
    expect(results).toHaveLength(1);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('status=active'));
  });

  it('passes limit to daemon', async () => {
    const client = mockClient({ sessions: [] });
    await handleMycoSessions({ limit: 1 }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('limit=1'));
  });

  it('returns empty on daemon failure', async () => {
    const client = mockClient(null, false);
    const results = await handleMycoSessions({}, client);
    expect(results).toEqual([]);
  });

  it('returns session summaries with expected fields', async () => {
    const sessions = [
      { id: 'sess-1', agent: 'claude-code', user: null, branch: null, started_at: 1700000000, ended_at: null, status: 'completed', title: 'Auth Refactor', summary: '', prompt_count: 5, tool_count: 20, parent_session_id: null },
    ];
    const client = mockClient({ sessions });

    const results = await handleMycoSessions({}, client);
    const session = results[0];
    expect(session.agent).toBe('claude-code');
    expect(session.title).toBe('Auth Refactor');
    expect(session.status).toBe('completed');
    expect(typeof session.started_at).toBe('number');
  });
});
