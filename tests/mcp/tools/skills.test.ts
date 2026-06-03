/**
 * Tests for the myco_skills tool handler.
 *
 * The handler proxies through DaemonClient to /api/skill-records.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoSkills } from '@myco/tools/skills.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { REQUEST_CONTEXT_HEADERS, type MycoRequestContext } from '@myco/grove/request-context.js';

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

    const result = await handleMycoSkills({ op: 'get', id: 'demo' }, client);

    expect(result).toEqual(skill);
    expect(client.get).toHaveBeenCalledWith('/api/skill-records/demo');
  });

  it('forwards Grove request context headers to daemon reads', async () => {
    const records = [{ id: 's1', name: 'demo', status: 'active' }];
    const client = mockClient({ records });
    const context: MycoRequestContext = {
      projectRoot: '/workspace/project-a',
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      groveId: 'grove-a',
      machineId: 'machine-a',
      sessionId: 'sess-a',
      projectVaultDir: '/workspace/project-a/.myco',
      databasePath: '/tmp/grove-a/myco.db',
      source: 'headers',
    };

    await handleMycoSkills({}, client, context);

    expect(client.get).toHaveBeenCalledWith(
      '/api/skill-records',
      expect.objectContaining({
        headers: expect.objectContaining({
          [REQUEST_CONTEXT_HEADERS.projectId]: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          [REQUEST_CONTEXT_HEADERS.groveId]: 'grove-a',
        }),
      }),
    );
  });

  it('url-encodes the id', async () => {
    const client = mockClient({ id: 'abc' });
    await handleMycoSkills({ op: 'get', id: 'weird name/with slashes' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/skill-records/weird%20name%2Fwith%20slashes');
  });

  it('returns error shape when looking up a non-existent skill', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoSkills({ op: 'get', id: 'missing' }, client);
    expect(result).toEqual({ ok: false, error: 'Skill not found' });
  });

  it('returns empty array when list call fails', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoSkills({}, client);
    expect(result).toEqual([]);
  });
});
