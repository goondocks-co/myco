/**
 * Tests for the myco_skills tool handler.
 *
 * The handler proxies through DaemonClient to /api/skill-records.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoSkills } from '@myco/mcp/tools/skills.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
    put: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

describe('myco_skills', () => {
  it('lists skills from /api/skill-records with status + limit query', async () => {
    const records = [{ id: 's1', name: 'demo', status: 'active' }];
    const client = mockClient({ records });

    const result = await handleMycoSkills({ status: 'active', limit: 5 }, client);

    expect(result).toEqual(records);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/api/skill-records'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('status=active'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('limit=5'));
  });

  it('fetches a specific skill by id via path segment', async () => {
    const skill = { id: 's1', name: 'demo', status: 'active' };
    const client = mockClient(skill);

    const result = await handleMycoSkills({ id: 'demo' }, client);

    expect(result).toEqual(skill);
    expect(client.get).toHaveBeenCalledWith('/api/skill-records/demo');
  });

  it('url-encodes the id', async () => {
    const client = mockClient({ id: 'abc' });
    await handleMycoSkills({ id: 'weird name/with slashes' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/skill-records/weird%20name%2Fwith%20slashes');
  });

  it('returns error shape when looking up a non-existent skill', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoSkills({ id: 'missing' }, client);
    expect(result).toEqual({ error: 'Skill not found' });
  });

  it('returns empty array when list call fails', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoSkills({}, client);
    expect(result).toEqual([]);
  });
});
