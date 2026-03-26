import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Cpu, Play, Trash2, RefreshCw, RotateCcw, ArrowDown, Pause } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEmbeddingDetails, type EmbeddingDetails } from '../hooks/use-embedding-details';
import { usePowerQuery } from '../hooks/use-power-query';
import { fetchJson, postJson } from '../lib/api';
import { POLL_INTERVALS, LEVEL_ORDER, type LogLevel, levelBadgeVariant, levelDotColor } from '../lib/constants';
import { PageLoading } from '../components/ui/page-loading';
import { PageHeader } from '../components/ui/page-header';
import { Surface } from '../components/ui/surface';
import { StatCard } from '../components/ui/stat-card';
import { SectionHeader } from '../components/ui/section-header';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/cn';

/* ---------- Constants ---------- */

const EMBEDDABLE_NAMESPACES = ['sessions', 'spores', 'plans', 'artifacts'] as const;
const EMBEDDING_LOG_CATEGORY = 'embedding';
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_ENTRIES = 2000;
const SCROLL_BOTTOM_THRESHOLD_PX = 40;

/** Number of recent data points to show in stat card sparklines. */
const SPARKLINE_HISTORY_LENGTH = 20;

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

function statusLabel(data: EmbeddingDetails): string {
  if (!data.provider.available) return 'unavailable';
  const hasPending = Object.values(data.pending).some((n) => n > 0);
  return hasPending ? 'processing' : 'idle';
}

function statusDotColor(data: EmbeddingDetails): string {
  if (!data.provider.available) return 'bg-tertiary';
  const hasPending = Object.values(data.pending).some((n) => n > 0);
  return hasPending ? 'bg-secondary' : 'bg-primary';
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

/* ---------- Sub-components ---------- */

function NamespaceTable({ data }: { data: EmbeddingDetails }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-sm">
        <thead>
          <tr className="text-left text-on-surface-variant">
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest">Namespace</th>
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right">Embedded</th>
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right">Pending</th>
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right">Stale</th>
            <th className="pb-2 font-sans font-medium text-xs uppercase tracking-widest text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {EMBEDDABLE_NAMESPACES.map((ns, idx) => {
            const nsStats = data.by_namespace[ns];
            const embedded = nsStats?.embedded ?? 0;
            const stale = nsStats?.stale ?? 0;
            const pending = data.pending[ns] ?? 0;
            const total = embedded + pending;
            return (
              <tr
                key={ns}
                className={cn(
                  'transition-colors hover:bg-surface-container-high/50',
                  idx % 2 === 1 ? 'bg-surface-container-low/30' : '',
                )}
              >
                <td className="py-2.5 pr-4">{ns}</td>
                <td className="py-2.5 pr-4 text-right">{embedded}</td>
                <td className="py-2.5 pr-4 text-right">
                  {pending > 0 ? (
                    <span className="text-secondary">{pending}</span>
                  ) : (
                    pending
                  )}
                </td>
                <td className="py-2.5 pr-4 text-right">
                  {stale > 0 ? (
                    <span className="text-tertiary">{stale}</span>
                  ) : (
                    stale
                  )}
                </td>
                <td className="py-2.5 text-right">{total}</td>
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
    <tr className="hover:bg-surface-container-high/30 transition-colors">
      <td className="whitespace-nowrap py-1.5 pl-4 pr-3 text-on-surface-variant/60 align-top w-[68px]">
        {formatTimestamp(entry.timestamp)}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 align-top w-[20px]">
        <div className={cn('h-2 w-2 rounded-full mt-1', levelDotColor(entry.level))} />
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 align-top w-[54px]">
        <Badge variant={levelBadgeVariant(entry.level)} className="px-1.5 py-0 text-[10px] uppercase">
          {entry.level}
        </Badge>
      </td>
      <td className="py-1.5 pr-4 text-on-surface align-top break-words">
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

  // --- Sparkline history tracking ---
  const [totalHistory, setTotalHistory] = useState<number[]>([]);

  useEffect(() => {
    if (data) {
      setTotalHistory((prev) => {
        const next = [...prev, data.total];
        return next.length > SPARKLINE_HISTORY_LENGTH
          ? next.slice(-SPARKLINE_HISTORY_LENGTH)
          : next;
      });
    }
  }, [data]);

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

  // Client-side filter to embedding category
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
          <div className="px-6 pt-6">
            <PageHeader title="Operations" subtitle="Embedding health, maintenance actions, and activity log" />
          </div>

          <div className="flex-1 overflow-auto">
            <div className="space-y-6 px-6 pb-6">
              {/* Provider status bar */}
              <div className="flex flex-wrap items-center gap-4 font-sans text-sm">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-primary" />
                  <span className="text-on-surface-variant">Provider</span>
                  <span className="font-mono text-on-surface">{data.provider.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-on-surface-variant">Model</span>
                  <span className="font-mono text-xs text-on-surface truncate max-w-[200px]" title={data.provider.model}>
                    {data.provider.model}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={cn('h-2 w-2 rounded-full', statusDotColor(data))} />
                  <span className="text-on-surface-variant capitalize">{statusLabel(data)}</span>
                </div>
              </div>

              {/* Stat cards */}
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Total Vectors" value={String(data.total)} sparklineData={totalHistory} accent="sage" />
                <StatCard label="Pending" value={String(totalPending)} accent={totalPending > 0 ? 'ochre' : 'outline'} />
                <StatCard label="Stale" value={String(totalStale)} accent={totalStale > 0 ? 'terracotta' : 'outline'} />
              </div>

              {/* Namespace breakdown */}
              <Surface level="low" className="p-6 space-y-4">
                <SectionHeader>Namespace Breakdown</SectionHeader>
                <NamespaceTable data={data} />
              </Surface>

              {/* Action toolbar */}
              <Surface level="low" className="p-6 space-y-3">
                <SectionHeader>Actions</SectionHeader>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={handleReembedStale}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Re-embed stale
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleCleanOrphans}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clean orphans
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleReconcile}>
                    <Play className="mr-2 h-4 w-4" />
                    Force reconcile
                  </Button>
                  <Button variant="destructive" size="sm" onClick={handleRebuild}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Rebuild all
                  </Button>
                </div>

                {/* Action result message */}
                {actionResult && (
                  <p
                    className={cn(
                      'font-sans text-sm',
                      actionResult.type === 'success' ? 'text-primary' : 'text-tertiary',
                    )}
                  >
                    {actionResult.text}
                  </p>
                )}
              </Surface>

              {/* Activity log — recessed terminal feel */}
              <Surface level="low" className="flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-6 py-4">
                  <SectionHeader>Activity Log</SectionHeader>
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
                </div>
                <div className="relative flex-1 p-0">
                  <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="h-64 overflow-y-auto font-mono text-xs bg-surface-container-lowest"
                  >
                    {filteredEntries.length === 0 ? (
                      <div className="flex h-32 items-center justify-center font-sans text-on-surface-variant">
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
              </Surface>
            </div>
          </div>
        </div>
      )}
    </PageLoading>
  );
}
