import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { usePowerQuery } from './use-power-query';

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

/**
 * Tail the daemon log stream.
 *
 * First fetch omits `since`, which the backend treats as tail mode and returns
 * the most recent N entries. Subsequent polls pass `since=<cursor>` so only
 * new entries are returned. Pass `paused=true` to halt polling without clearing
 * the buffer; resuming triggers an immediate refetch so the user doesn't wait
 * out the remainder of the current 3s interval.
 *
 * Returned `clear()` resets both the buffer AND the cursor — callers can use
 * it to re-prime the stream from a fresh tail (e.g., when toggling modes).
 */
export function useLogStream(paused: boolean = false) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  // null = tail mode (first fetch); number = follow mode from this cursor
  const cursorRef = useRef<number | null>(null);

  const { data, refetch } = usePowerQuery({
    queryKey: ['logs-stream'],
    queryFn: ({ signal }) => {
      const path = cursorRef.current === null
        ? '/logs/stream'
        : `/logs/stream?since=${cursorRef.current}`;
      return fetchJson<LogStreamResponse>(path, { signal });
    },
    pollCategory: 'realtime',
    refetchInterval: paused ? false : POLL_INTERVALS.LOGS,
    contextFree: true,
  });

  // Immediate refetch on resume so the UI catches up without waiting for the
  // next 3s tick. Harmless while paused — the effect is a no-op until paused
  // transitions back to false.
  const wasPausedRef = useRef(paused);
  useEffect(() => {
    if (wasPausedRef.current && !paused) refetch();
    wasPausedRef.current = paused;
  }, [paused, refetch]);

  useEffect(() => {
    if (!data?.entries.length) {
      // Even with no entries, seed the cursor from the first response so the
      // follow path starts from "now" rather than refetching tail forever.
      if (data && cursorRef.current === null) cursorRef.current = data.cursor;
      return;
    }
    cursorRef.current = data.cursor;
    setEntries((prev) => {
      const combined = [...prev, ...data.entries];
      return combined.length > MAX_LIVE_ENTRIES ? combined.slice(-MAX_LIVE_ENTRIES) : combined;
    });
  }, [data]);

  const clear = useCallback(() => {
    setEntries([]);
    cursorRef.current = null;
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
