import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({ createMcpHandler: () => vi.fn() }));
vi.mock('../../packages/myco-collective/worker/src/mcp/server.js', () => ({ createMcpServerInstance: () => ({}) }));

interface ProjectRecord {
  id: string;
  name: string;
  worker_url: string;
  api_key_hash: string;
  capabilities: string[];
  package_version: string | null;
  schema_version: number | null;
  last_seen: number | null;
  registered_at: number;
}

function createProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'project-1',
    name: 'Project One',
    worker_url: 'https://project-one.example.workers.dev',
    api_key_hash: 'hash',
    capabilities: ['search'],
    package_version: '0.1.0',
    schema_version: 12,
    last_seen: 1,
    registered_at: 1,
    ...overrides,
  };
}

function createEnv(projects: ProjectRecord[], apiKeys: Record<string, string>) {
  const rows = projects.map((project) => ({
    id: project.id,
    name: project.name,
    worker_url: project.worker_url,
    api_key_hash: project.api_key_hash,
    capabilities: JSON.stringify(project.capabilities),
    package_version: project.package_version,
    schema_version: project.schema_version,
    last_seen: project.last_seen,
    registered_at: project.registered_at,
  }));

  return {
    MYCO_COLLECTIVE_DB: {
      prepare() {
        return {
          all: async () => ({ results: rows }),
        };
      },
    },
    MYCO_SECRETS: {
      async get(key: string) {
        const match = key.match(/^project:(.+):api_key$/);
        if (!match) return null;
        return apiKeys[match[1]] ?? null;
      },
    },
  } as unknown as Parameters<typeof dispatchApiQuery>[0];
}

describe('collective query dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns collective projects from the parsed-body dispatcher', async () => {
    const { dispatchApiQuery } = await import('../../packages/myco-collective/worker/src/index.js');

    const env = createEnv([
      createProject({ id: 'alpha', name: 'Alpha' }),
      createProject({ id: 'beta', name: 'Beta', worker_url: 'https://beta.example.workers.dev' }),
    ], {
      alpha: 'alpha-key',
      beta: 'beta-key',
    });

    const response = await dispatchApiQuery(env, { tool: 'collective_projects', args: {} });
    const body = await response.json() as { projects: Array<{ id: string; name: string }> };

    expect(response.status).toBe(200);
    expect(body.projects.map((project) => project.name)).toEqual(['Alpha', 'Beta']);
  });

  it('fans out search results across multiple projects from the parsed-body dispatcher', async () => {
    const { dispatchApiQuery } = await import('../../packages/myco-collective/worker/src/index.js');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://project-one.example.workers.dev/search')) {
        expect(url).toContain('types=spores');
        expect(url).toContain('status=active');
        expect(url).toContain('observation_type=decision');
        return new Response(JSON.stringify({
          results: [{ id: 'alpha-session', table: 'sessions', score: 0.9 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://beta.example.workers.dev/search')) {
        expect(url).toContain('types=spores');
        expect(url).toContain('status=active');
        expect(url).toContain('observation_type=decision');
        return new Response(JSON.stringify({
          results: [{ id: 'beta-session', table: 'sessions', score: 0.8 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const env = createEnv([
      createProject({ id: 'alpha', name: 'Alpha', worker_url: 'https://project-one.example.workers.dev' }),
      createProject({ id: 'beta', name: 'Beta', worker_url: 'https://beta.example.workers.dev' }),
    ], {
      alpha: 'alpha-key',
      beta: 'beta-key',
    });

    const response = await dispatchApiQuery(env, {
      tool: 'collective_search',
      args: { query: 'collective', limit: 10, types: ['spores'], status: 'active', observation_type: 'decision' },
    });
    const body = await response.json() as {
      results: Array<{ id: string; project?: { name: string } }>;
      errors: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.errors).toEqual([]);
    expect(body.results).toHaveLength(2);
    expect(body.results.map((result) => result.project?.name)).toEqual(['Alpha', 'Beta']);
  });
});
