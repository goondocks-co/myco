import type { HydratedResult } from '../search-helpers';

type RetrieveHint = { tool: string; input: Record<string, unknown> };

/**
 * Table-name → canonical entity-type mapping. Mirrors the core
 * `normalizeResultType` mapping in `packages/myco/src/search-results.ts`
 * so a worker-side hint and a daemon-side hint produce the same result.
 *
 * `agent_runs` and `canopy_*` entries are present even though those tables
 * aren't synced to D1 today — keeping the mapping complete prevents silent
 * drift if a future sync expansion does start surfacing them.
 */
const TABLE_TO_ENTITY: Record<string, string> = {
  plans: 'plan',
  sessions: 'session',
  spores: 'spore',
  skill_records: 'skill',
  skills: 'skill',
  agent_runs: 'agent_run',
  runs: 'agent_run',
  canopy_entries: 'canopy_entry',
  canopy_file: 'canopy_entry',
};

const ENTITY_TO_TOOL: Record<string, string> = {
  plan: 'myco_plans',
  session: 'myco_sessions',
  spore: 'myco_spores',
  skill: 'myco_skills',
  agent_run: 'myco_agent',
  canopy_entry: 'myco_cortex',
};

export interface CloudSearchResult {
  id: string;
  machine_id: string;
  type: string;
  title: string;
  preview: string;
  score: number;
  data: Record<string, unknown>;
  metadata: HydratedResult['metadata'];
  retrieve?: RetrieveHint;
}

export function toCloudSearchResult(result: HydratedResult): CloudSearchResult {
  const type = normalizeEntityType(result.type);
  const retrieve = retrieveHint(type, result.id, result.machine_id, result.data);
  return {
    id: result.id,
    machine_id: result.machine_id,
    type,
    title: titleFor(result.data, type, result.id),
    preview: previewFor(result.data),
    score: result.score,
    data: result.data,
    metadata: result.metadata,
    ...(retrieve ? { retrieve } : {}),
  };
}

export function normalizeEntityType(table: string): string {
  return TABLE_TO_ENTITY[table] ?? table;
}

function retrieveHint(
  type: string,
  id: string,
  machineId: string,
  data: Record<string, unknown>,
): RetrieveHint | undefined {
  const tool = ENTITY_TO_TOOL[type];
  if (!tool) return undefined;
  if (type === 'agent_run') {
    return { tool, input: { op: 'run', id } };
  }
  if (type === 'canopy_entry') {
    const projectId = typeof data.project_id === 'string' ? data.project_id : undefined;
    const path = typeof data.path === 'string' ? data.path : undefined;
    return {
      tool,
      input: {
        op: 'canopy_entry',
        id,
        ...(projectId ? { project_id: projectId } : {}),
        ...(path ? { path } : {}),
      },
    };
  }
  return { tool, input: { op: 'get', id, machine_id: machineId } };
}

function titleFor(data: Record<string, unknown>, type: string, id: string): string {
  if (typeof data.title === 'string' && data.title.trim()) return data.title;
  if (typeof data.display_name === 'string' && data.display_name.trim()) return data.display_name;
  if (typeof data.name === 'string' && data.name.trim()) return data.name;
  if (type === 'spore' && typeof data.observation_type === 'string') return `${data.observation_type}:${id}`;
  return id;
}

function previewFor(data: Record<string, unknown>): string {
  const value = data.summary ?? data.description ?? data.content ?? '';
  if (typeof value !== 'string') return '';
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

export function textJson(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** Standard error envelope for worker tool handlers. */
export function textJsonError(error: string) {
  return textJson({ ok: false, error });
}
