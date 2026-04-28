import { useState, useEffect, useCallback } from 'react';
import { Cpu, Database, Play, Trash2, RefreshCw, RotateCcw, ArrowDown, Pause } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { CONFIG_SECTION_IDS } from '@myco/config/focus';
import { useEmbeddingDetails, type EmbeddingDetails } from '../hooks/use-embedding-details';
import { useDatabaseDetails, type DatabaseDetails } from '../hooks/use-database-details';
import { useScopedConfig } from '../hooks/use-scoped-config';
import { ScopedField } from '../components/config/ScopedField';
import { Switch } from '../components/ui/switch';
import { useLogFeed } from '../hooks/use-log-feed';
import { Badge } from '../components/ui/badge';
import { postJson, ApiError } from '../lib/api';
import { formatBytes, formatTimeAgo, SECONDS_PER_HOUR } from '../lib/format';
import { PageLoading } from '../components/ui/page-loading';
import { PageHeader } from '../components/ui/page-header';
import { Surface } from '../components/ui/surface';
import { StatCard } from '../components/ui/stat-card';
import { SectionHeader } from '../components/ui/section-header';
import { Button } from '../components/ui/button';
import { cn } from '../lib/cn';
import { BackupCard } from '../components/operations/BackupCard';
import { UpdateCard } from '../components/operations/UpdateCard';
import { LogRow } from '../components/operations/LogRow';
import type { Tab } from '../components/ui/tab-switcher';

/* ---------- Constants ---------- */

const EMBEDDABLE_NAMESPACES = [
  'sessions',
  'spores',
  'plans',
  'artifacts',
  'skill_records',
  'canopy_entries',
] as const;

/**
 * The Operations namespace breakdown shows raw namespace identifiers across
 * the board (`sessions`, `spores`, `plans`, `artifacts`, `skill_records`,
 * `canopy_entries`) so what's visible matches what the daemon stores. The
 * universal-search facet uses "Canopy" because that surface is end-user
 * copy, not a namespace breakdown — different audience, different rules.
 */
const NAMESPACE_LABELS: Partial<Record<(typeof EMBEDDABLE_NAMESPACES)[number], string>> = {};

const EMBEDDING_LOG_CATEGORY = 'embedding';
const DATABASE_LOG_CATEGORY = 'database';

/** Fragmentation percentage at or above which the stat card uses a warning accent. */
const FRAGMENTATION_WARN_PCT = 15;

/** Error-code discriminant returned by /api/database/vacuum on 409. */
const VACUUM_INSUFFICIENT_DISK = 'insufficient_disk_space';

/** Number of recent data points to show in stat card sparklines. */
const SPARKLINE_HISTORY_LENGTH = 20;

/* ---------- Tabs ---------- */

type ActiveTab = 'embedding' | 'database' | 'system';

const OPERATIONS_TABS: Tab[] = [
  { id: 'embedding', label: 'Embedding' },
  { id: 'database', label: 'Database' },
  { id: 'system', label: 'System' },
];

const VALID_TABS = new Set<ActiveTab>(['embedding', 'database', 'system']);
const PARAM_TAB = 'tab';

function readTabFromUrl(): ActiveTab {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(PARAM_TAB);
  return raw && VALID_TABS.has(raw as ActiveTab) ? (raw as ActiveTab) : 'embedding';
}

function writeTabToUrl(tab: ActiveTab): void {
  const params = new URLSearchParams();
  if (tab !== 'embedding') params.set(PARAM_TAB, tab);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, '', url);
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

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  const hr = Math.floor(min / 60);
  return hr + 'h';
}

/* ---------- Sub-components ---------- */

function NamespaceTable({ data }: { data: EmbeddingDetails }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-sm" aria-label="Embedding namespace breakdown">
        <thead>
          <tr className="text-left text-on-surface-variant">
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest" scope="col">Namespace</th>
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">Embedded</th>
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">Pending</th>
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">Stale</th>
            <th className="pb-2 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">Total</th>
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
                <td className="py-2.5 pr-4">{NAMESPACE_LABELS[ns] ?? ns}</td>
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

function TablesTable({ tables }: { tables: DatabaseDetails['tables'] }) {
  const sorted = [...tables].sort((a, b) => b.rows - a.rows);
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-sm" aria-label="Database table breakdown">
        <thead>
          <tr className="text-left text-on-surface-variant">
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest" scope="col">Table</th>
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">Rows</th>
            <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">Indexes</th>
            <th className="pb-2 font-sans font-medium text-xs uppercase tracking-widest" scope="col">Type</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, idx) => (
            <tr
              key={t.name}
              className={cn(
                'transition-colors hover:bg-surface-container-high/50',
                idx % 2 === 1 ? 'bg-surface-container-low/30' : '',
              )}
            >
              <td className="py-2.5 pr-4">{t.name}</td>
              <td className="py-2.5 pr-4 text-right">{t.rows.toLocaleString()}</td>
              <td className="py-2.5 pr-4 text-right">{t.index_count}</td>
              <td className="py-2.5">
                {t.is_fts ? (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase">FTS5</Badge>
                ) : (
                  <span className="text-on-surface-variant/60">btree</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IndexesPanel({ indexes }: { indexes: DatabaseDetails['indexes'] }) {
  const [expanded, setExpanded] = useState(false);
  const btreeCount = indexes.filter((i) => i.type === 'btree').length;
  const autoCount = indexes.filter((i) => i.type === 'auto').length;

  return (
    <Surface
      id={CONFIG_SECTION_IDS.operationsMaintenance}
      level="low"
      className="rounded-lg p-6 space-y-4 transition-all duration-300"
    >
      <div className="flex items-center justify-between">
        <SectionHeader>Indexes</SectionHeader>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="font-sans text-xs text-on-surface-variant hover:text-on-surface transition-colors"
        >
          {expanded ? 'Hide' : 'Show all ' + indexes.length}
        </button>
      </div>
      <p className="font-sans text-sm text-on-surface-variant">
        {btreeCount} btree {btreeCount === 1 ? 'index' : 'indexes'}
        {autoCount > 0 && <> · {autoCount} auto-{autoCount === 1 ? 'index' : 'indexes'}</>}
      </p>
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs" aria-label="All database indexes">
            <thead>
              <tr className="text-left text-on-surface-variant">
                <th className="pb-2 pr-4 font-sans font-medium text-[10px] uppercase tracking-widest" scope="col">Name</th>
                <th className="pb-2 pr-4 font-sans font-medium text-[10px] uppercase tracking-widest" scope="col">Table</th>
                <th className="pb-2 pr-4 font-sans font-medium text-[10px] uppercase tracking-widest" scope="col">Type</th>
                <th className="pb-2 font-sans font-medium text-[10px] uppercase tracking-widest" scope="col">SQL</th>
              </tr>
            </thead>
            <tbody>
              {indexes.map((idx, i) => (
                <tr
                  key={idx.name}
                  className={cn(
                    'transition-colors hover:bg-surface-container-high/50',
                    i % 2 === 1 ? 'bg-surface-container-low/30' : '',
                  )}
                >
                  <td className="py-1.5 pr-4">{idx.name}</td>
                  <td className="py-1.5 pr-4 text-on-surface-variant">{idx.table}</td>
                  <td className="py-1.5 pr-4 text-on-surface-variant uppercase">{idx.type}</td>
                  <td className="py-1.5 text-on-surface-variant/70 truncate max-w-[300px]" title={idx.sql ?? ''}>
                    {idx.sql ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Surface>
  );
}

function ScheduledMaintenanceCard({
  details,
  onActionResult,
}: {
  details: DatabaseDetails;
  onActionResult: (r: { type: 'success' | 'error'; text: string }) => void;
}) {
  const { effective } = useScopedConfig();
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);

  if (!effective) return null;

  const enabled = effective.maintenance.auto_optimize;
  const intervalHours = effective.maintenance.auto_optimize_interval_hours;

  const lastRunMs = details.last_optimize_at ? new Date(details.last_optimize_at).getTime() : null;
  const nextRunMs = lastRunMs !== null ? lastRunMs + intervalHours * SECONDS_PER_HOUR * 1000 - Date.now() : 0;

  async function handleRunNow() {
    setRunning(true);
    try {
      const result = await postJson<{
        actions_completed: Array<{ name: string }>;
        actions_failed: Array<{ name: string; error?: string }>;
        duration_ms: number;
      }>('/database/optimize');
      const failed = result.actions_failed.length;
      onActionResult({
        type: failed > 0 ? 'error' : 'success',
        text: 'Optimize complete: ' + result.actions_completed.length + ' steps, ' + failed + ' failed (' + result.duration_ms + 'ms)',
      });
      queryClient.invalidateQueries({ queryKey: ['database-details'] });
    } catch (err) {
      onActionResult({ type: 'error', text: 'Error: ' + (err as Error).message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <Surface level="low" className="p-6 space-y-4">
      <SectionHeader>Scheduled Maintenance</SectionHeader>
      <div className="flex flex-wrap items-center gap-3 font-sans text-sm">
        <ScopedField
          path="maintenance.auto_optimize"
          label="Auto-optimize"
          defaultScope="local"
        >
          {({ value, onChange }) => (
            <Switch checked={value ?? false} onCheckedChange={onChange} />
          )}
        </ScopedField>
        <span className="text-on-surface-variant">every</span>
        <ScopedField
          path="maintenance.auto_optimize_interval_hours"
          label=""
          defaultScope="local"
        >
          {({ value, onChange }) => (
            <select
              value={value ?? 24}
              disabled={!enabled}
              onChange={(e) => onChange(Number(e.target.value))}
              className="rounded-md border border-outline bg-surface-container px-2 py-1 text-on-surface text-sm"
            >
              <option value={6}>6 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </select>
          )}
        </ScopedField>
      </div>
      <p className="font-sans text-sm text-on-surface-variant">
        Last run: {details.last_optimize_at ? formatTimeAgo(details.last_optimize_at) : 'never'}
        {enabled && lastRunMs !== null && <> · Next: {formatCountdown(nextRunMs)}</>}
      </p>
      <Button variant="secondary" size="sm" onClick={handleRunNow} disabled={running}>
        <Play className="mr-2 h-4 w-4" />
        {running ? 'Running...' : 'Run now'}
      </Button>
    </Surface>
  );
}

function DatabaseActions({
  onActionResult,
}: {
  onActionResult: (r: { type: 'success' | 'error'; text: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function handleIntegrityCheck() {
    setBusy(true);
    try {
      const result = await postJson<{
        status: string;
        issues: string[];
        fk_violations: number;
        duration_ms: number;
      }>('/database/integrity-check');
      if (result.status === 'ok') {
        onActionResult({ type: 'success', text: 'Integrity check OK (' + result.duration_ms + 'ms)' });
      } else {
        onActionResult({
          type: 'error',
          text: 'Integrity issues: ' + result.issues.length + ' problems, ' + result.fk_violations + ' FK violations',
        });
      }
      queryClient.invalidateQueries({ queryKey: ['database-details'] });
    } catch (err) {
      onActionResult({ type: 'error', text: 'Error: ' + (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleVacuum() {
    if (!confirm('VACUUM rebuilds the entire DB file and may take a while. Continue?')) return;
    setBusy(true);
    try {
      const result = await postJson<{
        size_before: number;
        size_after: number;
        freed_bytes: number;
        duration_ms: number;
      }>('/database/vacuum');
      onActionResult({
        type: 'success',
        text: 'Vacuum complete: freed ' + formatBytes(result.freed_bytes) + ' in ' + result.duration_ms + 'ms',
      });
      queryClient.invalidateQueries({ queryKey: ['database-details'] });
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; required_bytes?: number; free_bytes?: number };
        if (body?.error === VACUUM_INSUFFICIENT_DISK) {
          onActionResult({
            type: 'error',
            text: 'Insufficient disk: need ' + formatBytes(body.required_bytes ?? 0) + ', have ' + formatBytes(body.free_bytes ?? 0),
          });
          return;
        }
      }
      onActionResult({ type: 'error', text: 'Error: ' + (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleReindex() {
    if (!confirm('REINDEX rebuilds all indexes. Continue?')) return;
    setBusy(true);
    try {
      const result = await postJson<{ duration_ms: number }>('/database/reindex');
      onActionResult({ type: 'success', text: 'Reindex complete (' + result.duration_ms + 'ms)' });
      queryClient.invalidateQueries({ queryKey: ['database-details'] });
    } catch (err) {
      onActionResult({ type: 'error', text: 'Error: ' + (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Surface level="low" className="p-6 space-y-3">
      <SectionHeader>Actions</SectionHeader>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={handleIntegrityCheck} disabled={busy}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Integrity check
        </Button>
        <Button variant="destructive" size="sm" onClick={handleVacuum} disabled={busy}>
          <Trash2 className="mr-2 h-4 w-4" />
          Vacuum
        </Button>
        <Button variant="ghost" size="sm" onClick={handleReindex} disabled={busy}>
          <RotateCcw className="mr-2 h-4 w-4" />
          Reindex
        </Button>
      </div>
    </Surface>
  );
}

/* ---------- Embedding Tab ---------- */

function EmbeddingTab({ data }: { data: EmbeddingDetails }) {
  const queryClient = useQueryClient();
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // --- Sparkline history tracking ---
  const [totalHistory, setTotalHistory] = useState<number[]>([]);

  useEffect(() => {
    setTotalHistory((prev) => {
      const next = [...prev, data.total];
      return next.length > SPARKLINE_HISTORY_LENGTH
        ? next.slice(-SPARKLINE_HISTORY_LENGTH)
        : next;
    });
  }, [data]);

  // Log feed (shared hook)
  const {
    filteredEntries,
    scrollRef,
    autoScroll,
    setAutoScroll,
    hasNewEntries,
    handleScroll,
    scrollToBottom,
  } = useLogFeed(EMBEDDING_LOG_CATEGORY);

  // --- Action handlers ---

  async function handleReembedStale() {
    setActionResult(null);
    try {
      const result = await postJson<{ reembedded: number; passes: number; batch_size: number }>('/embedding/reembed-stale');
      setActionResult({
        type: 'success',
        text: `Re-embedded ${result.reembedded} stale vectors in ${result.passes} pass${result.passes !== 1 ? 'es' : ''} (batch ${result.batch_size})`,
      });
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${(err as Error).message}` });
    }
  }

  async function handleRebuild() {
    if (!confirm('This will re-embed all vectors. Continue?')) return;
    setActionResult(null);
    try {
      const result = await postJson<{
        queued: number;
        embedded: number;
        stale_reembedded: number;
        passes: number;
        batch_size: number;
        remaining_queue_depth: number;
      }>('/embedding/rebuild');
      setActionResult({
        type: 'success',
        text: `Rebuild cleared ${result.queued} vectors and re-embedded ${result.embedded} records in ${result.passes} pass${result.passes !== 1 ? 'es' : ''} (batch ${result.batch_size}, remaining ${result.remaining_queue_depth})`,
      });
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
      const result = await postJson<{ embedded: number; orphans_cleaned: number; duration_ms: number; batch_size: number }>(
        '/embedding/reconcile',
      );
      setActionResult({
        type: 'success',
        text: `Reconcile complete: ${result.embedded} embedded, ${result.orphans_cleaned} orphans cleaned (${result.duration_ms}ms, batch ${result.batch_size})`,
      });
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${(err as Error).message}` });
    }
  }

  // --- Aggregate totals ---
  const totalPending = Object.values(data.pending).reduce((a, b) => a + b, 0);
  const totalStale = Object.values(data.by_namespace).reduce((a, ns) => a + ns.stale, 0);

  return (
    <div className="space-y-6">
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Total Vectors" value={String(data.total)} sparklineData={totalHistory} accent="sage" />
        <StatCard label="Pending" value={String(totalPending)} accent={totalPending > 0 ? 'ochre' : 'outline'} />
        <StatCard label="Stale" value={String(totalStale)} accent={totalStale > 0 ? 'terracotta' : 'outline'} />
      </div>

      {/* Namespace breakdown */}
      <Surface level="low" className="p-6 space-y-4">
        <SectionHeader>Namespace Breakdown</SectionHeader>
        <NamespaceTable data={data} />
      </Surface>

      {/* Reconcile policy */}
      <Surface level="low" className="p-6 space-y-3">
        <SectionHeader>Reconcile Policy</SectionHeader>
        <ScopedField<'embedding.run_in_deep_sleep', boolean>
          path="embedding.run_in_deep_sleep"
          label="Continue embedding in deep sleep"
          defaultScope="local"
        >
          {({ value, onChange }) => (
            <div className="flex items-start gap-3">
              <Switch
                checked={value ?? true}
                onCheckedChange={onChange}
                aria-label="Continue embedding in deep sleep"
              />
              <p className="font-sans text-xs text-on-surface-variant max-w-xl">
                Keep the queue draining when the machine is idle long enough to
                deep sleep — recommended for repos with large embedding
                backlogs.
              </p>
            </div>
          )}
        </ScopedField>
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
              <table className="w-full border-collapse" aria-label="Embedding activity log">
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
  );
}

/* ---------- System Tab ---------- */

function SystemTab() {
  return (
    <div className="space-y-6">
      <UpdateCard />
      <BackupCard />
    </div>
  );
}

/* ---------- Database Tab ---------- */

function DatabaseTab() {
  const { data, isLoading, isError, error } = useDatabaseDetails();

  // Sparkline history for DB size
  const [sizeHistory, setSizeHistory] = useState<number[]>([]);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    setSizeHistory((prev) => {
      const next = [...prev, data.file.size_bytes];
      return next.length > SPARKLINE_HISTORY_LENGTH ? next.slice(-SPARKLINE_HISTORY_LENGTH) : next;
    });
  }, [data]);

  // Log feed (shared hook)
  const {
    filteredEntries,
    scrollRef,
    autoScroll,
    setAutoScroll,
    hasNewEntries,
    handleScroll,
    scrollToBottom,
  } = useLogFeed(DATABASE_LOG_CATEGORY);

  if (isLoading) return <div className="text-on-surface-variant">Loading database details...</div>;
  if (isError) return <div className="text-tertiary">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const fragmentationDisplay = data.file.fragmentation_pct.toFixed(1) + '%';
  const fragmentationAccent = data.file.fragmentation_pct > FRAGMENTATION_WARN_PCT ? 'ochre' : 'outline';

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-4 font-sans text-sm">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <span className="text-on-surface-variant">Database</span>
          <span className="font-mono text-on-surface">myco.db</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-on-surface-variant">Schema</span>
          <span className="font-mono text-on-surface">v{data.schema.version}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-on-surface-variant">Journal</span>
          <span className="font-mono text-on-surface uppercase">{data.schema.journal_mode}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-primary" />
          <span className="text-on-surface-variant">healthy</span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Database Size"
          value={formatBytes(data.file.size_bytes)}
          sparklineData={sizeHistory}
          accent="sage"
        />
        <StatCard
          label="Fragmentation"
          value={fragmentationDisplay}
          accent={fragmentationAccent}
        />
        <StatCard
          label="WAL Size"
          value={formatBytes(data.file.wal_size_bytes)}
          accent="outline"
        />
      </div>

      {/* Schema breakdown */}
      <Surface level="low" className="p-6 space-y-4">
        <SectionHeader>Schema Breakdown</SectionHeader>
        <TablesTable tables={data.tables} />
      </Surface>

      <IndexesPanel indexes={data.indexes} />

      <ScheduledMaintenanceCard details={data} onActionResult={setActionResult} />

      <DatabaseActions onActionResult={setActionResult} />

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
                No database log entries
              </div>
            ) : (
              <table className="w-full border-collapse" aria-label="Database activity log">
                <tbody>
                  {filteredEntries.map((entry, idx) => (
                    <LogRow key={entry.timestamp + '-' + idx} entry={entry} />
                  ))}
                </tbody>
              </table>
            )}
          </div>

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
  );
}

/* ---------- Operations Page ---------- */

const TAB_SUBTITLES: Record<ActiveTab, string> = {
  embedding: 'Embedding health, maintenance actions, and activity log',
  database: 'Schema inspection, maintenance actions, and scheduled optimization',
  system: 'Software updates and backup management',
};

export default function Operations() {
  const { data, isLoading, isError, error } = useEmbeddingDetails();
  const [activeTab, setActiveTab] = useState<ActiveTab>(readTabFromUrl);

  const handleTabChange = useCallback((tabId: string) => {
    const tab = tabId as ActiveTab;
    setActiveTab(tab);
    writeTabToUrl(tab);
  }, []);

  return (
    <PageLoading
      isLoading={isLoading}
      error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
      loadingText="Loading operations..."
    >
      {data && (
        <div className="flex h-full flex-col">
          {/* Header with tabs */}
          <div className="px-6 pt-6">
            <PageHeader
              title="Operations"
              subtitle={TAB_SUBTITLES[activeTab]}
              tabs={OPERATIONS_TABS}
              activeTab={activeTab}
              onTabChange={handleTabChange}
            />
          </div>

          <div className="flex-1 overflow-auto">
            <div className="px-6 pb-6">
              {activeTab === 'embedding' && <EmbeddingTab data={data} />}
              {activeTab === 'database' && <DatabaseTab />}
              {activeTab === 'system' && <SystemTab />}
            </div>
          </div>
        </div>
      )}
    </PageLoading>
  );
}
