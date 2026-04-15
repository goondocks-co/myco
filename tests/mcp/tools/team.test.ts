/**
 * Tests for myco_team tool handler.
 *
 * The handler proxies GET /api/mcp/team through DaemonClient.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoTeam } from '@myco/mcp/tools/team.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

describe('myco_team', () => {
  it('returns the list of team members from the daemon', async () => {
    const members = [
      { id: 'm1', user: 'alice', role: 'lead', joined: '2024-01-02', tags: ['frontend'] },
      { id: 'm2', user: 'bob', role: 'eng', joined: '2024-02-01', tags: [] },
    ];
    const client = mockClient({ members });

    const result = await handleMycoTeam({}, client);

    expect(result).toHaveLength(2);
    expect(result[0].user).toBe('alice');
    expect(client.get).toHaveBeenCalledWith('/api/mcp/team');
  });

  it('returns empty array when daemon fails', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoTeam({}, client);
    expect(result).toEqual([]);
  });

  it('returns empty array when daemon response has no members key', async () => {
    const client = mockClient({ somethingElse: [] });
    const result = await handleMycoTeam({}, client);
    expect(result).toEqual([]);
  });
});
