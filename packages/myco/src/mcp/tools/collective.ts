import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';

export async function handleCollectiveSearch(
  input: {
    query: string;
    project?: string;
    limit?: number;
    types?: string[];
    status?: string;
    observation_type?: string;
    since?: number;
    until?: number;
    session_id?: string;
    source_path?: string;
    name?: string;
  },
  client: DaemonClient,
): Promise<Record<string, unknown>[]> {
  const endpoint = buildEndpoint('/api/collective/search', {
    q: input.query,
    project: input.project,
    limit: input.limit,
    types: input.types?.join(','),
    status: input.status,
    observation_type: input.observation_type,
    since: input.since,
    until: input.until,
    session_id: input.session_id,
    source_path: input.source_path,
    name: input.name,
  });
  const result = await client.get(endpoint);
  if (!result.ok) return [];
  return (result.data?.results ?? []) as Record<string, unknown>[];
}

export async function handleCollectiveProjects(client: DaemonClient): Promise<Record<string, unknown>[]> {
  const result = await client.get('/api/collective/projects');
  if (!result.ok) return [];
  return (result.data?.projects ?? []) as Record<string, unknown>[];
}

export async function handleCollectiveProject(
  input: { project: string; include_digest?: boolean },
  client: DaemonClient,
): Promise<Record<string, unknown> | null> {
  const endpoint = buildEndpoint('/api/collective/project', {
    project: input.project,
    include_digest: input.include_digest ? 'true' : undefined,
  });
  const result = await client.get(endpoint);
  if (!result.ok) return null;
  return (result.data?.project ?? null) as Record<string, unknown> | null;
}
