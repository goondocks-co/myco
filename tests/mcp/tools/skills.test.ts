/**
 * Tests for myco_skills and myco_skill_candidates tool handlers.
 *
 * Both handlers proxy through DaemonClient; skill candidates additionally
 * dispatches on the `action` field to approve/dismiss via PUT.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoSkills, handleMycoSkillCandidates } from '@myco/mcp/tools/skills.js';
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

describe('myco_skill_candidates', () => {
  it('lists candidates with status + limit query', async () => {
    const candidates = [{ id: 'c1', topic: 'demo', status: 'identified' }];
    const client = mockClient({ candidates });

    const result = await handleMycoSkillCandidates({ status: 'identified', limit: 10 }, client);

    expect(result).toEqual(candidates);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/api/skill-candidates'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('status=identified'));
  });

  it('fetches a specific candidate by id', async () => {
    const candidate = { id: 'c1', topic: 'demo' };
    const client = mockClient(candidate);
    const result = await handleMycoSkillCandidates({ id: 'c1' }, client);
    expect(result).toEqual(candidate);
    expect(client.get).toHaveBeenCalledWith('/api/skill-candidates/c1');
  });

  it('approves a candidate via PUT with status=approved', async () => {
    const client = mockClient({ id: 'c1', status: 'approved' });
    await handleMycoSkillCandidates({ action: 'approve', id: 'c1' }, client);
    expect(client.put).toHaveBeenCalledWith('/api/skill-candidates/c1', { status: 'approved' });
  });

  it('dismisses a candidate via PUT with status=dismissed', async () => {
    const client = mockClient({ id: 'c1', status: 'dismissed' });
    await handleMycoSkillCandidates({ action: 'dismiss', id: 'c1' }, client);
    expect(client.put).toHaveBeenCalledWith('/api/skill-candidates/c1', { status: 'dismissed' });
  });

  it('rejects approve/dismiss without an id', async () => {
    const client = mockClient({});
    const result = await handleMycoSkillCandidates({ action: 'approve' }, client);
    expect(result).toEqual({ error: "Action 'approve' requires an id" });
    expect(client.put).not.toHaveBeenCalled();
  });

  it('returns error shape when PUT fails', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoSkillCandidates({ action: 'approve', id: 'c1' }, client);
    expect(result).toEqual({ error: 'Failed to approve candidate' });
  });
});
