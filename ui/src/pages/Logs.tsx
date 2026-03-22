import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ScrollText, Pause, Play, Trash2, ArrowDown } from 'lucide-react';
import { usePowerQuery } from '../hooks/use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS, LOG_LEVELS, LEVEL_ORDER, type LogLevel } from '../lib/constants';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { cn } from '../lib/cn';

/* ---------- Constants ---------- */

const DEFAULT_LOG_LIMIT = 200;
/** Matches LOG_RING_BUFFER_CAPACITY in src/daemon/log-buffer.ts */
const MAX_LOG_ENTRIES = 5000;
const SCROLL_BOTTOM_THRESHOLD_PX = 40;

const LEVEL_BADGE_CLASS: Record<LogLevel, string> = {
  debug: 'border-transparent bg-muted text-muted-foreground',
  info: 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  warn: 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400',
  error: 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400',
};

/* ---------- Types ---------- */

interface LogEntry {
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

/* ---------- Helpers ---------- */

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD_PX;
}

/* ---------- Logs Page ---------- */

export default function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [activeLevel, setActiveLevel] = useState<LogLevel>('debug');
  const [searchText, setSearchText] = useState('');
  const [activeCategories, setActiveCategories] = useState<Set<string>>(new Set());
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasNewEntries, setHasNewEntries] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  /* Fetch new log entries — stable queryKey avoids cache bloat */
  const { data: logsData } = usePowerQuery<LogsResponse>({
    queryKey: ['logs'],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: String(DEFAULT_LOG_LIMIT) });
      if (cursorRef.current) params.set('since', cursorRef.current);
      return fetchJson<LogsResponse>(`/logs?${params.toString()}`, { signal });
    },
    refetchInterval: POLL_INTERVALS.LOGS,
    pollCategory: 'standard',
  });

  /* Accumulate entries when new data arrives (replaces deprecated onSuccess) */
  useEffect(() => {
    if (!logsData?.entries.length) return;

    setEntries((prev) => {
      let combined: LogEntry[];
      if (logsData.cursor_reset) {
        const existingKeys = new Set(prev.map((e) => `${e.timestamp}|${e.message}`));
        const fresh = logsData.entries.filter(
          (e) => !existingKeys.has(`${e.timestamp}|${e.message}`),
        );
        combined = fresh.length ? [...prev, ...fresh] : prev;
      } else {
        combined = [...prev, ...logsData.entries];
      }
      // Cap entries to prevent unbounded memory growth
      return combined.length > MAX_LOG_ENTRIES
        ? combined.slice(-MAX_LOG_ENTRIES)
        : combined;
    });

    setCursor(logsData.cursor);

    // Incrementally discover new categories from incoming entries
    setKnownCategories((prev) => {
      const known = new Set(prev);
      let changed = false;
      for (const e of logsData.entries) {
        if (!known.has(e.category)) {
          known.add(e.category);
          changed = true;
        }
      }
      return changed ? Array.from(known).sort() : prev;
    });

    if (!autoScrollRef.current) {
      setHasNewEntries(true);
    }
  }, [logsData]);

  /* Auto-scroll to bottom when new entries arrive */
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    setHasNewEntries(false);
  }, [entries, autoScroll]);

  /* Detect manual scroll-up to pause auto-scroll */
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

  /* Scroll to bottom and resume */
  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    setAutoScroll(true);
    setHasNewEntries(false);
  }, []);

  /* Clear accumulated entries */
  const clearEntries = useCallback(() => {
    setEntries([]);
    setKnownCategories([]);
    setHasNewEntries(false);
  }, []);

  /* Client-side filtering */
  const filteredEntries = useMemo(() => {
    const levelFloor = LEVEL_ORDER[activeLevel];
    const search = searchText.trim().toLowerCase();
    return entries.filter((e) => {
      if (LEVEL_ORDER[e.level] < levelFloor) return false;
      if (activeCategories.size > 0 && !activeCategories.has(e.category)) return false;
      if (search && !e.message.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [entries, activeLevel, activeCategories, searchText]);

  return (
    <div className="flex h-full flex-col">
      {/* Header toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-3">
        {/* Page title */}
        <div className="flex items-center gap-2 mr-2">
          <ScrollText className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Logs</span>
        </div>

        {/* Level filter buttons */}
        <div className="flex items-center gap-1">
          {LOG_LEVELS.map((level) => (
            <Button
              key={level}
              size="sm"
              variant={activeLevel === level ? 'default' : 'outline'}
              className="h-7 px-2 text-xs capitalize"
              onClick={() => setActiveLevel(level)}
            >
              {level}
            </Button>
          ))}
        </div>

        {/* Category filter chips */}
        {knownCategories.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[10px] text-muted-foreground mr-0.5">cat:</span>
            {knownCategories.map((cat) => (
              <Button
                key={cat}
                size="sm"
                variant={activeCategories.has(cat) ? 'default' : 'ghost'}
                className="h-5 px-1.5 text-[10px]"
                onClick={() => {
                  setActiveCategories((prev) => {
                    const next = new Set(prev);
                    if (next.has(cat)) {
                      next.delete(cat);
                    } else {
                      next.add(cat);
                    }
                    return next;
                  });
                }}
              >
                {cat}
              </Button>
            ))}
            {activeCategories.size > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px] text-muted-foreground"
                onClick={() => setActiveCategories(new Set())}
              >
                clear
              </Button>
            )}
          </div>
        )}

        {/* Search */}
        <Input
          className="h-7 w-48 text-xs"
          placeholder="Filter messages..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />

        <div className="ml-auto flex items-center gap-1">
          {/* Auto-scroll toggle */}
          <Button
            size="sm"
            variant={autoScroll ? 'default' : 'outline'}
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => {
              if (autoScroll) {
                setAutoScroll(false);
              } else {
                scrollToBottom();
              }
            }}
            title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
          >
            {autoScroll ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {autoScroll ? 'Pause' : 'Resume'}
          </Button>

          {/* Clear */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={clearEntries}
            title="Clear log entries"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </Button>
        </div>
      </div>

      {/* Log entry list */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto font-mono text-xs"
        >
          {filteredEntries.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              No log entries
            </div>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {filteredEntries.map((entry, idx) => (
                  <LogRow key={`${entry.timestamp}-${idx}`} entry={entry} />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* "New entries below" indicator */}
        {hasNewEntries && !autoScroll && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2',
              'flex items-center gap-1.5 rounded-full border border-border',
              'bg-card px-3 py-1.5 text-xs font-medium shadow-md',
              'text-muted-foreground transition-colors hover:text-foreground',
            )}
          >
            <ArrowDown className="h-3 w-3" />
            New entries below
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- Log Row ---------- */

function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <tr className="border-b border-border/40 hover:bg-accent/30 transition-colors">
      {/* Timestamp */}
      <td className="whitespace-nowrap py-1 pl-4 pr-3 text-muted-foreground/70 align-top w-[68px]">
        {formatTimestamp(entry.timestamp)}
      </td>

      {/* Level badge */}
      <td className="whitespace-nowrap py-1 pr-3 align-top w-[54px]">
        <Badge
          className={cn('px-1.5 py-0 text-[10px] font-medium uppercase', LEVEL_BADGE_CLASS[entry.level])}
        >
          {entry.level}
        </Badge>
      </td>

      {/* Category */}
      <td className="whitespace-nowrap py-1 pr-3 text-muted-foreground align-top w-[120px] truncate max-w-[120px]">
        {entry.category}
      </td>

      {/* Message */}
      <td className="py-1 pr-4 text-foreground align-top break-words">
        {entry.message}
      </td>
    </tr>
  );
}
