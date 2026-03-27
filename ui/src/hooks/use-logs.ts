import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  id: number;
  timestamp: string;
  level: string;
  kind: string;
  component: string;
  message: string;
  data: Record<string, unknown> | null;
  session_id: string | null;
}

export interface LogSearchParams {
  q?: string;
  level?: string;
  component?: string;
  kind?: string;
  session_id?: string;
  from?: string;
  to?: string;
  page?: number;
  page_size?: number;
}

interface LogSearchResponse {
  entries: LogEntry[];
  total: number;
  page: number;
  page_size: number;
}

interface LogStreamResponse {
  entries: LogEntry[];
  cursor: number;
}

export interface LogDetailEntry extends LogEntry {
  resolved: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Live mode hook
// ---------------------------------------------------------------------------

const MAX_LIVE_ENTRIES = 5000;

export function useLogStream() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const cursorRef = useRef<number>(0);

  const { data } = useQuery({
    queryKey: ['logs-stream'],
    queryFn: ({ signal }) =>
      fetchJson<LogStreamResponse>(
        `/logs/stream?since=${cursorRef.current}`,
        { signal },
      ),
    refetchInterval: POLL_INTERVALS.LOGS,
  });

  useEffect(() => {
    if (!data?.entries.length) return;
    cursorRef.current = data.cursor;
    setEntries((prev) => {
      const combined = [...prev, ...data.entries];
      return combined.length > MAX_LIVE_ENTRIES ? combined.slice(-MAX_LIVE_ENTRIES) : combined;
    });
  }, [data]);

  const clear = useCallback(() => {
    setEntries([]);
  }, []);

  return { entries, clear };
}

// ---------------------------------------------------------------------------
// Search mode hook
// ---------------------------------------------------------------------------

export function useLogSearch(params: LogSearchParams, enabled: boolean) {
  const queryParams = new URLSearchParams();
  if (params.q) queryParams.set('q', params.q);
  if (params.level) queryParams.set('level', params.level);
  if (params.component) queryParams.set('component', params.component);
  if (params.kind) queryParams.set('kind', params.kind);
  if (params.session_id) queryParams.set('session_id', params.session_id);
  if (params.from) queryParams.set('from', params.from);
  if (params.to) queryParams.set('to', params.to);
  if (params.page) queryParams.set('page', String(params.page));
  if (params.page_size) queryParams.set('page_size', String(params.page_size));

  return useQuery({
    queryKey: ['logs-search', Object.fromEntries(queryParams)],
    queryFn: ({ signal }) =>
      fetchJson<LogSearchResponse>(
        `/logs/search?${queryParams.toString()}`,
        { signal },
      ),
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Detail hook
// ---------------------------------------------------------------------------

export function useLogDetail(id: number | null) {
  return useQuery({
    queryKey: ['log-detail', id],
    queryFn: ({ signal }) =>
      fetchJson<LogDetailEntry>(`/logs/${id}`, { signal }),
    enabled: id !== null,
  });
}
