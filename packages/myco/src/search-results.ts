import {
  TOOL_AGENT,
  TOOL_CORTEX,
  TOOL_PLANS,
  TOOL_SESSIONS,
  TOOL_SKILLS,
  TOOL_SPORES,
} from './tools/definitions.js';

export interface SearchResultRow {
  id?: string;
  type?: string | null;
  table?: string | null;
  table_name?: string | null;
  title?: string | null;
  name?: string | null;
  content?: string | null;
  preview?: string | null;
  summary?: string | null;
  score?: number;
  project_id?: string | null;
  path?: string | null;
  llm_description?: string | null;
  language?: string | null;
  source?: string;
  metadata?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  release_state?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface RetrieveHint {
  tool: string;
  input: Record<string, unknown>;
}

export interface NormalizedSearchResult extends SearchResultRow {
  id: string;
  type: string;
  title: string;
  preview: string;
  retrieve?: RetrieveHint;
}

export interface NormalizeSearchResultOptions {
  includeMachineIdInRetrieve?: boolean;
}

export function normalizeSearchResults(
  rows: readonly unknown[],
  options: NormalizeSearchResultOptions = {},
): NormalizedSearchResult[] {
  return rows
    .map((row) => normalizeSearchResult(row as SearchResultRow, options))
    .filter((row): row is NormalizedSearchResult => row !== null);
}

export function normalizeSearchResult(
  row: SearchResultRow,
  options: NormalizeSearchResultOptions = {},
): NormalizedSearchResult | null {
  const type = normalizeResultType(row);
  const id = normalizeResultId(row, type);
  if (!id) return null;

  const title = normalizeTitle(row, type, id);
  const preview = normalizePreview(row);
  const retrieve = retrieveHint(type, id, row, options);
  return {
    ...row,
    id,
    type,
    title,
    preview,
    ...(retrieve ? { retrieve } : {}),
  };
}

export function normalizeResultType(row: SearchResultRow): string {
  const raw = String(
    row.type
      ?? row.table_name
      ?? row.table
      ?? row.metadata?.table
      ?? '',
  ).toLowerCase();

  if (raw === 'plans') return 'plan';
  if (raw === 'sessions') return 'session';
  if (raw === 'spores') return 'spore';
  if (raw === 'skills' || raw === 'skill' || raw === 'skill_record' || raw === 'skill_records') return 'skill';
  if (raw === 'canopy' || raw === 'canopy_file' || raw === 'canopy_entry' || row.project_id || row.llm_description) {
    return 'canopy_entry';
  }
  if (raw === 'agent_run' || raw === 'run' || raw === 'runs') return 'agent_run';
  return raw || 'unknown';
}

function normalizeResultId(row: SearchResultRow, type: string): string | null {
  if (typeof row.id === 'string' && row.id.trim()) return row.id;
  if (type === 'canopy_entry' && row.project_id && row.path) return `${row.project_id}:${row.path}`;
  return null;
}

function normalizeTitle(row: SearchResultRow, type: string, id: string): string {
  if (typeof row.title === 'string' && row.title.trim()) return row.title;
  if (typeof row.name === 'string' && row.name.trim()) return row.name;
  if (typeof row.data?.title === 'string' && row.data.title.trim()) return row.data.title;
  if (typeof row.data?.name === 'string' && row.data.name.trim()) return row.data.name;
  if (type === 'canopy_entry' && row.path) return row.path;
  return id;
}

function normalizePreview(row: SearchResultRow): string {
  const value = row.preview
    ?? row.llm_description
    ?? row.summary
    ?? row.content
    ?? row.data?.summary
    ?? row.data?.content
    ?? '';
  return typeof value === 'string' ? value : '';
}

function retrieveHint(
  type: string,
  id: string,
  row: SearchResultRow,
  options: NormalizeSearchResultOptions,
): RetrieveHint | undefined {
  const machineInput = options.includeMachineIdInRetrieve && typeof row.machine_id === 'string'
    ? { machine_id: row.machine_id }
    : {};

  if (type === 'plan') return { tool: TOOL_PLANS, input: { op: 'get', id, ...machineInput } };
  if (type === 'session') return { tool: TOOL_SESSIONS, input: { op: 'get', id, ...machineInput } };
  if (type === 'spore') return { tool: TOOL_SPORES, input: { op: 'get', id, ...machineInput } };
  if (type === 'skill') return { tool: TOOL_SKILLS, input: { op: 'get', id, ...machineInput } };
  if (type === 'agent_run') return { tool: TOOL_AGENT, input: { op: 'run', id } };
  if (type === 'canopy_entry') {
    return {
      tool: TOOL_CORTEX,
      input: {
        op: 'canopy_entry',
        id,
        ...(row.project_id ? { project_id: row.project_id } : {}),
        ...(row.path ? { path: row.path } : {}),
      },
    };
  }
  return undefined;
}
