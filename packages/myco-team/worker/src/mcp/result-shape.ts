import type { HydratedResult } from '../search-helpers';

type RetrieveHint = { tool: string; input: Record<string, unknown> };

const TABLE_TO_ENTITY: Record<string, string> = {
  plans: 'plan',
  sessions: 'session',
  spores: 'spore',
  skill_records: 'skill',
  skills: 'skill',
};

const ENTITY_TO_TOOL: Record<string, string> = {
  plan: 'myco_plans',
  session: 'myco_sessions',
  spore: 'myco_spores',
  skill: 'myco_skills',
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
  const retrieve = retrieveHint(type, result.id, result.machine_id);
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

function retrieveHint(type: string, id: string, machineId: string): RetrieveHint | undefined {
  const tool = ENTITY_TO_TOOL[type];
  if (!tool) return undefined;
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
