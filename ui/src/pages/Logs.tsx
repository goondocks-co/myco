import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { Pause, Play, Trash2, ArrowDown, ScrollText, Filter, ChevronRight } from 'lucide-react';
import { usePowerQuery } from '../hooks/use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS, LOG_LEVELS, LEVEL_ORDER, type LogLevel, levelBadgeVariant, levelDotColor } from '../lib/constants';
import { PageHeader } from '../components/ui/page-header';
import { Surface } from '../components/ui/surface';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { cn } from '../lib/cn';

/* ---------- Constants ---------- */

const DEFAULT_LOG_LIMIT = 200;
/** Matches LOG_RING_BUFFER_CAPACITY in src/daemon/log-buffer.ts */
const MAX_LOG_ENTRIES = 5000;
const SCROLL_BOTTOM_THRESHOLD_PX = 40;

/** Left-border color accent per log level for row emphasis. */
const LEVEL_BORDER_LEFT: Record<LogLevel, string> = {
  debug: 'border-l-outline/30',
  info: 'border-l-primary/50',
  warn: 'border-l-secondary/70',
  error: 'border-l-tertiary/80',
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

  /* Fetch new log entries -- stable queryKey avoids cache bloat */
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

  /* Accumulate entries when new data arrives */
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
      return combined.length > MAX_LOG_ENTRIES
        ? combined.slice(-MAX_LOG_ENTRIES)
        : combined;
    });

    setCursor(logsData.cursor);

    // Incrementally discover new categories
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

  const isFiltered = activeLevel !== 'debug' || activeCategories.size > 0 || searchText.trim().length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Page header */}
      <div className="px-6 pt-6">
        <PageHeader title="Logs" subtitle="Real-time daemon log stream" />
      </div>

      {/* Filter toolbar */}
      <Surface level="default" className="mx-6 mb-4 rounded-md p-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Level filter buttons */}
          <div className="flex items-center gap-1">
            {LOG_LEVELS.map((level) => (
              <Button
                key={level}
                size="sm"
                variant={activeLevel === level ? 'default' : 'ghost'}
                className="h-7 px-2 text-xs capitalize gap-1.5"
                onClick={() => setActiveLevel(level)}
              >
                <div className={cn('h-1.5 w-1.5 rounded-full', levelDotColor(level))} />
                {level}
              </Button>
            ))}
          </div>

          {/* Separator between level and category filters */}
          {knownCategories.length > 0 && (
            <div className="h-5 w-px bg-outline-variant/30" />
          )}

          {/* Category filter chips */}
          {knownCategories.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <Filter className="h-3 w-3 text-on-surface-variant/60 mr-0.5" />
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
                  className="h-5 px-1.5 text-[10px] text-on-surface-variant"
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
            aria-label="Filter log messages"
          />

          <div className="ml-auto flex items-center gap-1">
            {/* Auto-scroll toggle */}
            <Button
              size="sm"
              variant={autoScroll ? 'default' : 'ghost'}
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
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs text-on-surface-variant"
              onClick={clearEntries}
              title="Clear log entries"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </Button>
          </div>
        </div>
      </Surface>

      {/* Log viewer — terminal window chrome */}
      <div className="relative flex-1 overflow-hidden mx-6 mb-6 rounded-lg border border-outline-variant/10 flex flex-col" role="log" aria-label="Real-time daemon log stream" aria-live="polite">
        {/* Terminal title bar */}
        <div className="flex items-center gap-3 bg-surface-container-low px-4 py-2 border-b border-outline-variant/10">
          <div className="flex items-center gap-1.5">
            <span className={cn(
              'h-2 w-2 rounded-full',
              autoScroll ? 'bg-primary animate-pulse' : 'bg-secondary',
            )} />
            <span className="h-2 w-2 rounded-full bg-outline/30" />
            <span className="h-2 w-2 rounded-full bg-outline/30" />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant/60">
            {autoScroll ? 'streaming' : 'paused'}
          </span>
          <span className="ml-auto font-mono text-[10px] text-on-surface-variant/40 tabular-nums">
            {entries.length > 0 && `${entries.length} buffered`}
          </span>
        </div>

        {/* Scrollable log content */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto bg-surface-container-lowest font-mono text-xs"
        >
          {filteredEntries.length === 0 ? (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 py-12">
              <ScrollText className="h-8 w-8 text-outline/40" />
              <div className="text-center space-y-1">
                <p className="font-sans text-sm text-on-surface-variant">
                  {entries.length === 0 ? 'Waiting for log entries' : 'No entries match current filters'}
                </p>
                <p className="font-sans text-xs text-on-surface-variant/60">
                  {entries.length === 0
                    ? 'Log output will appear here as the daemon operates.'
                    : 'Try adjusting the level filter or clearing the search.'}
                </p>
              </div>
            </div>
          ) : (
            <table className="w-full border-collapse" aria-label="Daemon log entries">
              <tbody>
                {filteredEntries.map((entry, idx) => (
                  <LogRow key={`${entry.timestamp}-${idx}`} entry={entry} />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Status footer bar */}
        <div className="flex items-center gap-4 bg-surface-container-low px-4 py-1.5 border-t border-outline-variant/10">
          <span className="font-mono text-[10px] text-on-surface-variant/50 tabular-nums">
            {isFiltered
              ? `${filteredEntries.length} of ${entries.length} entries`
              : `${entries.length} entries`}
          </span>
          {isFiltered && (
            <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
              filtered
            </Badge>
          )}
          {activeCategories.size > 0 && (
            <span className="font-mono text-[10px] text-on-surface-variant/40">
              {activeCategories.size} {activeCategories.size === 1 ? 'category' : 'categories'}
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-on-surface-variant/40">
            {activeLevel !== 'debug' && `>= ${activeLevel}`}
          </span>
        </div>

        {/* "New entries below" indicator */}
        {hasNewEntries && !autoScroll && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              'absolute bottom-10 left-1/2 -translate-x-1/2',
              'flex items-center gap-1.5 rounded-full',
              'bg-surface-container-high px-3 py-1.5 text-xs font-medium shadow-ambient',
              'text-on-surface-variant transition-colors hover:text-on-surface',
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

/** Keys that are part of the log structure, not extra metadata. */
const STRUCTURAL_KEYS = new Set(['timestamp', 'level', 'component', 'category', 'message']);

function getMetadata(entry: LogEntry): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(entry)) {
    if (!STRUCTURAL_KEYS.has(k)) {
      meta[k] = v;
      count++;
    }
  }
  return count > 0 ? meta : null;
}

function formatMetaValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return JSON.stringify(value);
}

const LogRow = memo(function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const meta = useMemo(() => getMetadata(entry), [entry]);

  return (
    <>
      <tr
        className={cn(
          'hover:bg-surface-container-high/30 transition-colors border-l-2',
          LEVEL_BORDER_LEFT[entry.level],
          meta && 'cursor-pointer',
        )}
        onClick={meta ? () => setExpanded((e) => !e) : undefined}
      >
        {/* Timestamp */}
        <td className="whitespace-nowrap py-1.5 pl-3 pr-3 text-on-surface-variant/60 align-top w-[68px]">
          {formatTimestamp(entry.timestamp)}
        </td>

        {/* Level dot */}
        <td className="whitespace-nowrap py-1.5 pr-2 align-top w-[16px]">
          <div className={cn('h-2 w-2 rounded-full mt-1', levelDotColor(entry.level))} />
        </td>

        {/* Level badge */}
        <td className="whitespace-nowrap py-1.5 pr-3 align-top w-[54px]">
          <Badge
            variant={levelBadgeVariant(entry.level)}
            className="px-1.5 py-0 text-[10px] uppercase"
          >
            {entry.level}
          </Badge>
        </td>

        {/* Category */}
        <td className="whitespace-nowrap py-1.5 pr-3 text-on-surface-variant align-top w-[120px] truncate max-w-[120px]">
          {entry.category}
        </td>

        {/* Message */}
        <td className="py-1.5 pr-4 text-on-surface align-top break-words">
          <span className="flex items-start gap-1.5">
            {meta && (
              <ChevronRight className={cn(
                'h-3 w-3 mt-0.5 shrink-0 text-on-surface-variant/40 transition-transform',
                expanded && 'rotate-90',
              )} />
            )}
            <span>{entry.message}</span>
          </span>
        </td>
      </tr>
      {expanded && meta && (
        <tr className={cn('border-l-2', LEVEL_BORDER_LEFT[entry.level])}>
          <td colSpan={5} className="py-1 pl-[68px] pr-4 pb-2">
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-on-surface-variant/70">
              {Object.entries(meta).map(([k, v]) => (
                <span key={k}>
                  <span className="text-on-surface-variant/50">{k}:</span>{' '}
                  <span className="text-on-surface/80">{formatMetaValue(v)}</span>
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});
