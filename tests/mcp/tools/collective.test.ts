/**
 * Tests for collective_search, collective_projects, and collective_project
 * tool handlers — each proxies through DaemonClient to /api/collective/*.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import {
  handleCollectiveProject,
  handleCollectiveProjects,
  handleCollectiveSearch,
} from '@myco/tools/collective.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

describe('collective_search', () => {
  it('forwards query, project, and limit to the daemon', async () => {
    const results = [{ table: 'spores', id: 's1', data: {} }];
    const client = mockClient({ results });

    const result = await handleCollectiveSearch({ query: 'auth', project: 'myco-main', limit: 3 }, client);

    expect(result).toEqual(results);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/api/collective/search'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('q=auth'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('project=myco-main'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('limit=3'));
  });

  it('forwards semantic filter params to the daemon', async () => {
    const client = mockClient({ results: [] });
    await handleCollectiveSearch({
      query: 'auth',
      types: ['spores'],
      status: 'active',
      observation_type: 'decision',
      since: 10,
      until: 20,
      session_id: 'sess-1',
      source_path: '/tmp/plan.md',
      name: 'sqlite-query-patterns',
    }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('types=spores');
    expect(url).toContain('status=active');
    expect(url).toContain('observation_type=decision');
    expect(url).toContain('since=10');
    expect(url).toContain('until=20');
    expect(url).toContain('session_id=sess-1');
    expect(url).toContain('source_path=%2Ftmp%2Fplan.md');
    expect(url).toContain('name=sqlite-query-patterns');
  });

  it('returns empty array on daemon failure', async () => {
    const client = mockClient(null, false);
    const result = await handleCollectiveSearch({ query: 'x' }, client);
    expect(result).toEqual([]);
  });

  it('works without optional project and limit params', async () => {
    const client = mockClient({ results: [] });
    await handleCollectiveSearch({ query: 'just-query' }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('q=just-query');
    expect(url).not.toContain('project=');
    expect(url).not.toContain('limit=');
  });
});

describe('collective_projects', () => {
  it('returns projects list from the daemon', async () => {
    const projects = [{ id: 'p1', name: 'myco-main' }];
    const client = mockClient({ projects });
    const result = await handleCollectiveProjects(client);
    expect(result).toEqual(projects);
    expect(client.get).toHaveBeenCalledWith('/api/collective/projects');
  });

  it('returns empty array on daemon failure', async () => {
    const client = mockClient(null, false);
    const result = await handleCollectiveProjects(client);
    expect(result).toEqual([]);
  });
});

describe('collective_project', () => {
  it('forwards project name and include_digest=true as a query string', async () => {
    const project = { id: 'p1', name: 'myco-main' };
    const client = mockClient({ project });

    const result = await handleCollectiveProject({ project: 'myco-main', include_digest: true }, client);

    expect(result).toEqual(project);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('/api/collective/project');
    expect(url).toContain('project=myco-main');
    expect(url).toContain('include_digest=true');
  });

  it('omits include_digest when false (matches buildEndpoint undefined-stripping)', async () => {
    const client = mockClient({ project: { id: 'p1' } });
    await handleCollectiveProject({ project: 'p1', include_digest: false }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).not.toContain('include_digest');
  });

  it('returns null on daemon failure', async () => {
    const client = mockClient(null, false);
    const result = await handleCollectiveProject({ project: 'missing' }, client);
    expect(result).toBeNull();
  });
});
