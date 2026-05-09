import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS, LEVEL_ORDER, type LogLevel } from '../lib/constants';

/** Log entry shape returned by `/api/logs`. Extra fields are tolerated. */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  [key: string]: unknown;
}

interface LogsResponse {
  entries: LogEntry[];
  cursor: string;
  cursor_reset?: boolean;
}

const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_ENTRIES = 2000;
const SCROLL_BOTTOM_THRESHOLD_PX = 40;

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD_PX;
}

export interface UseLogFeedResult {
  /** Entries scoped to `category`, filtered to the debug level floor. */
  filteredEntries: LogEntry[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
  setAutoScroll: (next: boolean) => void;
  hasNewEntries: boolean;
  handleScroll: () => void;
  scrollToBottom: () => void;
}

/**
 * Cursor-based polling log feed for a single category.
 *
 * Owns the scroll ref, auto-scroll pause/resume state, "new entries below" pill
 * tracking, and cursor state. Server-side filters by `category` via the
 * `/api/logs?category=…` query param; the client trusts that filter.
 *
 * Shared by the Embedding and Database tabs on the Operations page.
 */
export function useLogFeed(category: string): UseLogFeedResult {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasNewEntries, setHasNewEntries] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const { data: logsData } = usePowerQuery<LogsResponse>({
    queryKey: ['logs', category],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        limit: String(DEFAULT_LOG_LIMIT),
        category,
      });
      if (cursorRef.current) params.set('since', cursorRef.current);
      return fetchJson<LogsResponse>(`/logs?${params.toString()}`, { signal });
    },
    refetchInterval: POLL_INTERVALS.LOGS,
    pollCategory: 'standard',
    contextFree: true,
  });

  useEffect(() => {
    if (!logsData?.entries.length) return;

    setEntries((prev) => {
      let combined: LogEntry[];
      if (logsData.cursor_reset) {
        // cursor_reset can re-deliver recent entries; dedup by timestamp+message
        const existingKeys = new Set(prev.map((e) => `${e.timestamp}|${e.message}`));
        const fresh = logsData.entries.filter(
          (e) => !existingKeys.has(`${e.timestamp}|${e.message}`),
        );
        combined = fresh.length ? [...prev, ...fresh] : prev;
      } else {
        combined = [...prev, ...logsData.entries];
      }
      return combined.length > MAX_LOG_ENTRIES
        ? combined.slice(-MAX_LOG_ENTRIES)
        : combined;
    });

    setCursor(logsData.cursor);

    if (!autoScrollRef.current) {
      setHasNewEntries(true);
    }
  }, [logsData]);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    setHasNewEntries(false);
  }, [entries, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottom(el)) {
      setAutoScroll(true);
      setHasNewEntries(false);
    } else {
      setAutoScroll(false);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    setAutoScroll(true);
    setHasNewEntries(false);
  }, []);

  const filteredEntries = useMemo(() => {
    const levelFloor = LEVEL_ORDER['debug'];
    return entries.filter((e) => LEVEL_ORDER[e.level] >= levelFloor);
  }, [entries]);

  return {
    filteredEntries,
    scrollRef,
    autoScroll,
    setAutoScroll,
    hasNewEntries,
    handleScroll,
    scrollToBottom,
  };
}
