import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAcrossProjects } from '../../packages/myco-collective/worker/src/fanout.js';
import type { ProjectRecord } from '../../packages/myco-collective/worker/src/index.js';

function createEnv(apiKeys: Record<string, string | null>) {
  return {
    MYCO_SECRETS: {
      async get(key: string): Promise<string | null> {
        const projectMatch = key.match(/^project:(.+):api_key$/);
        if (!projectMatch) return null;
        return apiKeys[projectMatch[1]] ?? null;
      },
    },
  } as unknown as Parameters<typeof searchAcrossProjects>[0];
}

function createProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'project-1',
    name: 'Project One',
    worker_url: 'https://project-one.example.workers.dev',
    api_key_hash: 'hash',
    capabilities: ['search'],
    package_version: '0.1.0',
    schema_version: 1,
    last_seen: null,
    registered_at: 1,
    ...overrides,
  };
}

describe('collective fanout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns partial results and reports downstream failures', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ id: 'spore-1', table: 'spores', score: 0.81 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const env = createEnv({ alpha: 'alpha-key', beta: 'beta-key' });
    const projects = [
      createProject({ id: 'alpha', name: 'Alpha', worker_url: 'https://alpha.example.workers.dev' }),
      createProject({ id: 'beta', name: 'Beta', worker_url: 'https://beta.example.workers.dev' }),
    ];

    const result = await searchAcrossProjects(env, projects, 'query', undefined, 10);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].project).toEqual({
      id: 'alpha',
      name: 'Alpha',
      worker_url: 'https://alpha.example.workers.dev',
    });
    expect(result.errors).toEqual([
      {
        project: {
          id: 'beta',
          name: 'Beta',
          worker_url: 'https://beta.example.workers.dev',
        },
        error: 'Search request failed with status 401',
        status: 401,
      },
    ]);
  });

  it('times out a hung project and keeps other results', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        results: [{ id: 'session-1', table: 'sessions', score: 0.91 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce((input, init) => new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }));
    vi.stubGlobal('fetch', fetchMock);

    const env = createEnv({ alpha: 'alpha-key', beta: 'beta-key' });
    const promise = searchAcrossProjects(env, [
      createProject({ id: 'alpha', name: 'Alpha', worker_url: 'https://alpha.example.workers.dev' }),
      createProject({ id: 'beta', name: 'Beta', worker_url: 'https://beta.example.workers.dev' }),
    ], 'query', undefined, 10);

    await vi.advanceTimersByTimeAsync(5_100);
    const result = await promise;

    expect(result.results).toHaveLength(1);
    expect(result.errors).toEqual([
      {
        project: {
          id: 'beta',
          name: 'Beta',
          worker_url: 'https://beta.example.workers.dev',
        },
        error: 'Search request timed out after 5000ms',
      },
    ]);
  });
});
