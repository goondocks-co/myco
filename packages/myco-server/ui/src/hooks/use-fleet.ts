import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { StoredKeyFailure } from '@goondocks/myco-shared/run-diagnostic';
import type { FleetQueue, RunnerCredentialChoice, RunnerFallbackNotice, StoredKeyFailureNotice } from '@goondocks/myco-shared/runner-fleet';
import { fetchJson, type RunnerRow, type WorkerRow } from '../lib/api';
import { live } from '../lib/live';

/** `GET /api/runners`: the active runners, legacy workers, the queue, and for an admin which agents have a usable stored key. */
export interface FleetAnswer {
  observedAt: number;
  runners: RunnerRow[];
  legacyWorkers: WorkerRow[];
  queue: FleetQueue;
  storedCredentials?: Record<string, boolean>;
  cursor?: string | null;
  totals?: { active: number };
}

export const RUNNERS_KEY = ['runners'] as const;

/** The runners as the server reads them, read again as the fleet and runs move. */
export function useFleet() {
  return useQuery({ queryKey: RUNNERS_KEY, queryFn: ({ signal }) => fetchJson<FleetAnswer>('/api/runners', signal), ...live<FleetAnswer>({ follows: ['fleet', 'runs'] }) });
}

/** `GET /api/runners/agents`: every agent a registered runner offers installed, what each runner pays with, and which agent each uses today. */
export interface AgentPayersAnswer {
  agents: Array<{ agent: string; storedUsable: boolean; storedFailure?: StoredKeyFailure; fallbacks?: Array<RunnerFallbackNotice & { runnerId: string }>; waiting?: Array<StoredKeyFailureNotice & { runnerId: string }>; runners: Array<{ id: string; name: string; choice: RunnerCredentialChoice | null }> }>;
  today: Array<{ id: string; name: string; agent: string | null }>;
}

/** Who pays for each agent on every registered runner, read under the runners' key so a fleet change reads it again. */
export function useAgentPayers(enabled = true) {
  return useQuery({ queryKey: [...RUNNERS_KEY, 'agents'], enabled, queryFn: ({ signal }) => fetchJson<AgentPayersAnswer>('/api/runners/agents', signal), ...live<AgentPayersAnswer>({ follows: ['fleet', 'runs'] }) });
}

/**
 * The active runners page by page, each further page read on request, or every page in turn with `all`. The first
 * page carries which agents have a usable stored key and how many runners there are.
 */
export function useRunnerPages(options: { all?: boolean } = {}) {
  const query = useInfiniteQuery({
    queryKey: [...RUNNERS_KEY, 'pages'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<FleetAnswer>(`/api/runners${pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...live({ follows: ['fleet', 'runs'] }),
  });
  useFollowEveryPage(options.all === true, query);
  const runners = useMemo(() => query.data?.pages.flatMap((page) => page.runners) ?? [], [query.data]);
  return { query, runners, storedUsable: query.data?.pages[0]?.storedCredentials, total: query.data?.pages[0]?.totals?.active };
}

/** `GET /api/runners/removed`: one page of removed runners, newest removal first. */
interface RemovedRunnersAnswer { runners: RunnerRow[]; cursor: string | null }

/** Every removed runner, page after page, read only while `enabled`. */
export function useRemovedRunnerPages(enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: [...RUNNERS_KEY, 'removed', 'pages'],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<RemovedRunnersAnswer>(`/api/runners/removed${pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...live({ follows: ['fleet'] }),
  });
  useFollowEveryPage(enabled, query);
  const runners = useMemo(() => query.data?.pages.flatMap((page) => page.runners) ?? [], [query.data]);
  return { query, runners };
}

/** Reads the next page whenever one is left and none is being read, until a page fails or none is left. */
function useFollowEveryPage(on: boolean, query: { hasNextPage: boolean; isFetchingNextPage: boolean; isFetchNextPageError: boolean; fetchNextPage: () => Promise<unknown> }) {
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (on && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [on, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
}
