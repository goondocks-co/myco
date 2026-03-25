import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Wrench, Cpu, Play, Trash2, RefreshCw, RotateCcw, ArrowDown, Pause } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEmbeddingDetails, type EmbeddingDetails } from '../hooks/use-embedding-details';
import { usePowerQuery } from '../hooks/use-power-query';
import { fetchJson, postJson } from '../lib/api';
import { POLL_INTERVALS, LEVEL_ORDER, type LogLevel } from '../lib/constants';
import { PageLoading } from '../components/ui/page-loading';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/cn';

/* ---------- Constants ---------- */

const EMBEDDABLE_NAMESPACES = ['sessions', 'spores', 'plans', 'artifacts'] as const;
const EMBEDDING_LOG_CATEGORY = 'embedding';
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_ENTRIES = 2000;
const SCROLL_BOTTOM_THRESHOLD_PX = 40;

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

function statusBadgeVariant(available: boolean): 'default' | 'secondary' | 'destructive' {
  return available ? 'secondary' : 'destructive';
}

function statusLabel(data: EmbeddingDetails): string {
  if (!data.provider.available) return 'unavailable';
  const hasPending = Object.values(data.pending).some((n) => n > 0);
  return hasPending ? 'processing' : 'idle';
}

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

const LEVEL_BADGE_CLASS: Record<LogLevel, string> = {
  debug: 'border-transparent bg-muted text-muted-foreground',
  info: 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  warn: 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400',
  error: 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400',
};

/* ---------- Sub-components ---------- */

function NamespaceTable({ data }: { data: EmbeddingDetails }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="pb-2 pr-4 font-medium">Namespace</th>
            <th className="pb-2 pr-4 font-medium text-right">Embedded</th>
            <th className="pb-2 pr-4 font-medium text-right">Pending</th>
            <th className="pb-2 pr-4 font-medium text-right">Stale</th>
            <th className="pb-2 font-medium text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {EMBEDDABLE_NAMESPACES.map((ns) => {
            const nsStats = data.by_namespace[ns];
            const embedded = nsStats?.embedded ?? 0;
            const stale = nsStats?.stale ?? 0;
            const pending = data.pending[ns] ?? 0;
            const total = embedded + pending + stale;
            return (
              <tr key={ns} className="border-b border-border/40">
                <td className="py-2 pr-4 font-mono">{ns}</td>
                <td className="py-2 pr-4 text-right font-mono">{embedded}</td>
                <td className="py-2 pr-4 text-right font-mono">{pending}</td>
                <td className="py-2 pr-4 text-right font-mono">{stale}</td>
                <td className="py-2 text-right font-mono">{total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EmbeddingLogRow({ entry }: { entry: LogEntry }) {
  return (
    <tr className="border-b border-border/40 hover:bg-accent/30 transition-colors">
      <td className="whitespace-nowrap py-1 pl-4 pr-3 text-muted-foreground/70 align-top w-[68px]">
        {formatTimestamp(entry.timestamp)}
      </td>
      <td className="whitespace-nowrap py-1 pr-3 align-top w-[54px]">
        <Badge
          className={cn('px-1.5 py-0 text-[10px] font-medium uppercase', LEVEL_BADGE_CLASS[entry.level])}
        >
          {entry.level}
        </Badge>
      </td>
      <td className="py-1 pr-4 text-foreground align-top break-words">
        {entry.message}
      </td>
    </tr>
  );
}

/* ---------- Operations Page ---------- */

export default function Operations() {
  const { data, isLoading, isError, error } = useEmbeddingDetails();
  const queryClient = useQueryClient();
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // --- Embedding log feed ---
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
    queryKey: ['embedding-logs'],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        limit: String(DEFAULT_LOG_LIMIT),
        category: EMBEDDING_LOG_CATEGORY,
      });
      if (cursorRef.current) params.set('since', cursorRef.current);
      return fetchJson<LogsResponse>(`/logs?${params.toString()}`, { signal });
    },
    refetchInterval: POLL_INTERVALS.LOGS,
    pollCategory: 'standard',
  });

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

  // Client-side filter to embedding category (in case server doesn't support category param)
  const filteredEntries = useMemo(() => {
    const levelFloor = LEVEL_ORDER['debug'];
    return entries.filter((e) => {
      if (LEVEL_ORDER[e.level] < levelFloor) return false;
      if (e.category !== EMBEDDING_LOG_CATEGORY) return false;
      return true;
    });
  }, [entries]);

  // --- Action handlers ---

  async function handleReembedStale() {
    setActionResult(null);
    try {
      const result = await postJson<{ reembedded: number }>('/embedding/reembed-stale');
      setActionResult({ type: 'success', text: `Re-embedded ${result.reembedded} stale vectors` });
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${(err as Error).message}` });
    }
  }

  async function handleRebuild() {
    if (!confirm('This will re-embed all vectors. Continue?')) return;
    setActionResult(null);
    try {
      const result = await postJson<{ queued: number }>('/embedding/rebuild');
      setActionResult({ type: 'success', text: `Rebuild queued: ${result.queued} vectors to re-embed` });
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${(err as Error).message}` });
    }
  }

  async function handleCleanOrphans() {
    setActionResult(null);
    try {
      const result = await postJson<{ orphans_cleaned: number }>('/embedding/clean-orphans');
      setActionResult({ type: 'success', text: `Cleaned ${result.orphans_cleaned} orphan vectors` });
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${(err as Error).message}` });
    }
  }

  async function handleReconcile() {
    setActionResult(null);
    try {
      const result = await postJson<{ embedded: number; orphans_cleaned: number; duration_ms: number }>(
        '/embedding/reconcile',
      );
      setActionResult({
        type: 'success',
        text: `Reconcile complete: ${result.embedded} embedded, ${result.orphans_cleaned} orphans cleaned (${result.duration_ms}ms)`,
      });
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${(err as Error).message}` });
    }
  }

  // --- Aggregate totals ---
  const totalPending = data ? Object.values(data.pending).reduce((a, b) => a + b, 0) : 0;
  const totalStale = data
    ? Object.values(data.by_namespace).reduce((a, ns) => a + ns.stale, 0)
    : 0;

  return (
    <PageLoading
      isLoading={isLoading}
      error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
      loadingText="Loading embedding details..."
    >
      {data && (
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
            <Wrench className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Operations</span>
          </div>

          <div className="flex-1 overflow-auto">
            <div className="space-y-6 p-6">
              {/* Panel 1: Embedding Overview */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Cpu className="h-4 w-4 text-primary" />
                    Embedding Overview
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Provider info row */}
                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Provider</span>
                      <span className="font-mono text-foreground">{data.provider.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Model</span>
                      <span className="font-mono text-xs text-foreground truncate max-w-[200px]" title={data.provider.model}>
                        {data.provider.model}
                      </span>
                    </div>
                    <Badge variant={statusBadgeVariant(data.provider.available)} className="text-xs capitalize">
                      {statusLabel(data)}
                    </Badge>
                  </div>

                  {/* Aggregate counts */}
                  <div className="flex gap-6 text-sm">
                    <div>
                      <span className="text-muted-foreground">Total vectors</span>
                      <span className="ml-2 font-mono text-foreground">{data.total}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Pending</span>
                      <span className="ml-2 font-mono text-foreground">{totalPending}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Stale</span>
                      <span className="ml-2 font-mono text-foreground">{totalStale}</span>
                    </div>
                  </div>

                  {/* Per-namespace breakdown */}
                  <NamespaceTable data={data} />
                </CardContent>
              </Card>

              {/* Panel 2: Actions */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={handleReembedStale}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Re-embed stale
                    </Button>
                    <Button variant="destructive" size="sm" onClick={handleRebuild}>
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Rebuild all
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleCleanOrphans}>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Clean orphans
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleReconcile}>
                      <Play className="mr-2 h-4 w-4" />
                      Force reconcile
                    </Button>
                  </div>

                  {/* Action result message */}
                  {actionResult && (
                    <p
                      className={cn(
                        'text-sm',
                        actionResult.type === 'success'
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-destructive',
                      )}
                    >
                      {actionResult.text}
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Panel 3: Recent Activity */}
              <Card className="flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">Recent Activity</CardTitle>
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
                  </div>
                </CardHeader>
                <CardContent className="relative flex-1 p-0">
                  <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="h-64 overflow-y-auto font-mono text-xs"
                  >
                    {filteredEntries.length === 0 ? (
                      <div className="flex h-32 items-center justify-center text-muted-foreground">
                        No embedding log entries
                      </div>
                    ) : (
                      <table className="w-full border-collapse">
                        <tbody>
                          {filteredEntries.map((entry, idx) => (
                            <EmbeddingLogRow key={`${entry.timestamp}-${idx}`} entry={entry} />
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
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}
    </PageLoading>
  );
}
