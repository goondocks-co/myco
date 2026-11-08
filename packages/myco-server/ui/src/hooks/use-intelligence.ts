import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { live } from '../lib/live';

export interface SporeRow {
  id: string;
  agentId: string;
  sessionId: string | null;
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
  /** Continues after this page's last spore; null when none follows. */
  cursor: string | null;
  hasMore: boolean;
  /** How many spores the filters match, from the counts Myco keeps; absent while it is still counting older spores. */
  total?: number;
  counting?: 'building';
  maxPage: number;
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
  /** Narrows to the spores one session produced. */
  session?: string;
  limit?: number;
  /** Continues after the spore a previous page's `cursor` names. */
  cursor?: string;
}

function sporeQuery(filters: SporeFilters): string {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? SPORE_PAGE_SIZE));
  if (filters.status !== undefined && filters.status !== '') params.set('status', filters.status);
  if (filters.type !== undefined && filters.type !== '') params.set('type', filters.type);
  if (filters.session !== undefined && filters.session !== '') params.set('session', filters.session);
  if (filters.cursor !== undefined) params.set('cursor', filters.cursor);
  return params.toString();
}

/**
 * A project's spores, newest first, a page at a time: `more()` continues after the last spore shown, by the cursor the
 * page answered, and the read ends when a page says no more follow. A spore written meanwhile neither repeats a row nor
 * ends the walk early; `total` is the latest page's count, to show.
 */
export function useSporePages(projectId: string, filters: Omit<SporeFilters, 'cursor'> = {}) {
  const limit = filters.limit ?? SPORE_PAGE_SIZE;
  const query = useInfiniteQuery({
    queryKey: ['spores', projectId, 'pages', sporeQuery({ ...filters, limit })],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<SporesResponse>(`${project(projectId)}/spores?${sporeQuery({ ...filters, limit, ...(pageParam === null ? {} : { cursor: pageParam }) })}`, signal),
    getNextPageParam: (last) => (last.hasMore && last.cursor !== null ? last.cursor : undefined),
    ...live({ follows: ['knowledge'] }),
  });
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.spores) ?? [], [query.data]);
  return {
    rows,
    total: query.data?.pages.at(-1)?.total,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    // A page already on its way is joined, never asked for again.
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { void query.refetch(); },
  };
}
