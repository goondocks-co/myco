import { type UseQueryOptions, useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

export interface SporeRow {
  id: string;
  agentId: string;
  sessionId: string | null;
  promptId: string | null;
  sourceCreatedAt?: number | null;
  observationType: string;
  status: string;
  content: string;
  /** The one line written for agents, when the writer gave one. */
  agentLine?: string | null;
  context: string | null;
  importance: number;
  filePath: string | null;
  tags: string | null;
  contentHash: string | null;
  properties: string | null;
  createdAt: number;
  updatedAt: number | null;
  embedded: number;
}

export interface SporesResponse {
  spores: SporeRow[];
  total: number;
  maxPage: number;
}

export interface SporeResponse {
  spore: SporeRow;
  /** Every spore recorded as replacing this one, newest first. */
  supersededBy: string[];
  /** Every spore this one replaced, newest first. */
  supersedes: string[];
}

const seg = (value: string) => encodeURIComponent(value);
const project = (projectId: string) => `/api/projects/${seg(projectId)}`;

/** How many spores one page of the rail holds. */
export const SPORE_PAGE_SIZE = 25;

export interface SporeFilters {
  /** One status; every status when absent. */
  status?: string;
  /** One observation type; every type when absent. */
  type?: string;
  /** Matches the content or the type. */
  q?: string;
  /** Narrows to the spores one session produced. */
  session?: string;
  limit?: number;
  offset?: number;
}

function sporeQuery(filters: SporeFilters): string {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? SPORE_PAGE_SIZE));
  if (filters.status !== undefined && filters.status !== '') params.set('status', filters.status);
  if (filters.type !== undefined && filters.type !== '') params.set('type', filters.type);
  if (filters.q !== undefined && filters.q !== '') params.set('q', filters.q);
  if (filters.session !== undefined && filters.session !== '') params.set('session', filters.session);
  if (filters.offset !== undefined && filters.offset > 0) params.set('offset', String(filters.offset));
  return params.toString();
}

/** A project's spores, newest first, with the count the filters match. A read with `enabled: false` waits, pending, until it is wanted. */
export function useSpores(projectId: string, filters: SporeFilters = {}, options: Pick<UseQueryOptions<SporesResponse>, 'enabled'> = {}) {
  const query = sporeQuery(filters);
  return useQuery({
    queryKey: ['spores', projectId, query],
    queryFn: ({ signal }) => fetchJson<SporesResponse>(`${project(projectId)}/spores?${query}`, signal),
    ...options,
  });
}

/** One spore with its lineage in both directions. */
export function useSpore(projectId: string, sporeId: string) {
  return useQuery({
    queryKey: ['spore', projectId, sporeId],
    queryFn: ({ signal }) => fetchJson<SporeResponse>(`${project(projectId)}/spores/${seg(sporeId)}`, signal),
  });
}
