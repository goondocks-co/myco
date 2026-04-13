import { searchAcrossProjects } from './fanout';
import type { Env, ProjectRecord } from './index';

export async function listProjects(env: Env): Promise<ProjectRecord[]> {
  const rows = await env.MYCO_COLLECTIVE_DB.prepare(
    'SELECT id, name, worker_url, api_key_hash, capabilities, package_version, schema_version, last_seen, registered_at FROM projects ORDER BY name ASC',
  ).all<{
    id: string;
    name: string;
    worker_url: string;
    api_key_hash: string;
    capabilities: string;
    package_version: string | null;
    schema_version: number | null;
    last_seen: number | null;
    registered_at: number;
  }>();

  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    worker_url: row.worker_url,
    api_key_hash: row.api_key_hash,
    capabilities: JSON.parse(row.capabilities || '[]') as string[],
    package_version: row.package_version,
    schema_version: row.schema_version,
    last_seen: row.last_seen,
    registered_at: row.registered_at,
  }));
}

export async function listSettings(env: Env): Promise<Record<string, { value: unknown; description: string | null; updated_at: number; updated_by: string | null }>> {
  const rows = await env.MYCO_COLLECTIVE_DB.prepare(
    'SELECT key, value, description, updated_at, updated_by FROM settings_overrides ORDER BY key ASC',
  ).all<{ key: string; value: string; description: string | null; updated_at: number; updated_by: string | null }>();

  return Object.fromEntries(rows.results.map((row) => [
    row.key,
    {
      value: JSON.parse(row.value),
      description: row.description,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    },
  ]));
}

export async function handleCollectiveSearch(env: Env, args: { query: string; project?: string; limit?: number }) {
  const projects = await listProjects(env);
  const { results, errors } = await searchAcrossProjects(env, projects, args.query, args.project, args.limit);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ results, errors }) }] };
}

export async function handleCollectiveProjects(env: Env) {
  const projects = await listProjects(env);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ projects }) }] };
}

export async function handleCollectiveProject(env: Env, args: { project: string; include_digest?: boolean }) {
  const projects = await listProjects(env);
  const project = projects.find((entry) => entry.id === args.project || entry.name === args.project) ?? null;
  return { content: [{ type: 'text' as const, text: JSON.stringify({ project, digest: args.include_digest ? null : undefined }) }] };
}

export async function handleCollectiveSettings(env: Env) {
  const settings = await listSettings(env);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ settings_overrides: settings }) }] };
}
