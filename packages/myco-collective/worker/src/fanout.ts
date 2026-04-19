import type { Env, ProjectRecord } from './index';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FANOUT_REQUEST_TIMEOUT_MS = 5_000;
const REQUIRED_CAPABILITY_BY_TOOL: Record<string, string | null> = {
  collective_search: 'search',
  collective_projects: null,
  collective_project: null,
  collective_settings: null,
};

export interface FanoutErrorRecord {
  project: { id: string; name: string; worker_url: string };
  error: string;
  status?: number;
}

interface FanoutProjectResult {
  results: Array<Record<string, unknown>>;
  errors: FanoutErrorRecord[];
}

function projectMatches(project: ProjectRecord, requestedProject: string | undefined): boolean {
  if (!requestedProject) return true;
  return project.id === requestedProject || project.name === requestedProject;
}

async function getProjectApiKey(env: Env, projectId: string): Promise<string | null> {
  return env.MYCO_SECRETS.get(`project:${projectId}:api_key`);
}

export async function searchAcrossProjects(
  env: Env,
  projects: ProjectRecord[],
  query: string,
  projectFilter?: string,
  limit = DEFAULT_LIMIT,
  filters?: {
    types?: string[];
    status?: string;
    observation_type?: string;
    since?: number;
    until?: number;
    session_id?: string;
    source_path?: string;
    name?: string;
  },
): Promise<{ results: Array<Record<string, unknown>>; errors: FanoutErrorRecord[] }> {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
  const targetProjects = projects.filter((project) => projectMatches(project, projectFilter));
  const responses = await Promise.all(targetProjects.map((project) =>
    searchProject(env, project, query, boundedLimit, filters),
  ));

  const merged = responses.flatMap((response) => response.results);
  const errors = responses.flatMap((response) => response.errors);
  merged.sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0));
  return {
    results: merged.slice(0, boundedLimit),
    errors,
  };
}

async function searchProject(
  env: Env,
  project: ProjectRecord,
  query: string,
  limit: number,
  filters?: {
    types?: string[];
    status?: string;
    observation_type?: string;
    since?: number;
    until?: number;
    session_id?: string;
    source_path?: string;
    name?: string;
  },
): Promise<FanoutProjectResult> {
  if (!project.capabilities.includes('search')) {
    return { results: [], errors: [] };
  }

  const apiKey = await getProjectApiKey(env, project.id);
  if (!apiKey) {
    return {
      results: [],
      errors: [projectError(project, 'Project API key is missing')],
    };
  }

  const params = new URLSearchParams({ q: query, top_k: String(limit) });
  if (filters?.types && filters.types.length > 0) params.set('types', filters.types.join(','));
  if (filters?.status) params.set('status', filters.status);
  if (filters?.observation_type) params.set('observation_type', filters.observation_type);
  if (filters?.since !== undefined) params.set('since', String(filters.since));
  if (filters?.until !== undefined) params.set('until', String(filters.until));
  if (filters?.session_id) params.set('session_id', filters.session_id);
  if (filters?.source_path) params.set('source_path', filters.source_path);
  if (filters?.name) params.set('name', filters.name);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FANOUT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${project.worker_url.replace(/\/+$/, '')}/search?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        results: [],
        errors: [projectError(project, `Search request failed with status ${response.status}`, response.status)],
      };
    }

    const body = await response.json() as { results?: Array<Record<string, unknown>> };
    return {
      results: (body.results ?? []).map((result) => ({
        ...result,
        project: { id: project.id, name: project.name, worker_url: project.worker_url },
      })),
      errors: [],
    };
  } catch (error) {
    return {
      results: [],
      errors: [projectError(project, formatProjectError(error))],
    };
  } finally {
    clearTimeout(timeout);
  }
}

function projectError(project: ProjectRecord, error: string, status?: number): FanoutErrorRecord {
  return {
    project: { id: project.id, name: project.name, worker_url: project.worker_url },
    error,
    status,
  };
}

function formatProjectError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return `Search request timed out after ${FANOUT_REQUEST_TIMEOUT_MS}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function projectSupportsTool(project: ProjectRecord, toolName: string): boolean {
  const requiredCapability = REQUIRED_CAPABILITY_BY_TOOL[toolName] ?? null;
  if (!requiredCapability) return true;
  return project.capabilities.includes(requiredCapability);
}
