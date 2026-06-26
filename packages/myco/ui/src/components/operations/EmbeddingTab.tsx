/**
 * Embedding tab body: provider banner, total/pending/stale stat cards,
 * namespace breakdown table, and Grove-scoped action panel (re-embed
 * stale, clean orphans, force reconcile, rebuild all) with confirm
 * dialog wiring.
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, Play, Trash2, RefreshCw, RotateCcw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../lib/error';
import { useEmbeddingDetails, type EmbeddingDetails } from '../../hooks/use-embedding-details';
import { postJson } from '../../lib/api';
import { PageLoading } from '../ui/page-loading';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { SectionHeader } from '../ui/section-header';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';
import type { OperationsScope } from './OperationsScopePill';
import { buildActionScope } from './scope-helpers';
import {
  ActionConfirmDialog,
  actionRequiresConfirmation,
} from './ActionConfirmDialog';
import { useProjectSelection } from '../../hooks/use-project-selection';

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

/** Number of recent data points to show in stat card sparklines. */
const SPARKLINE_HISTORY_LENGTH = 20;

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
            const composed = data.namespace_breakdown?.[ns];
            const nsStats = data.by_namespace[ns];
            const embedded = composed?.embedded ?? nsStats?.embedded ?? 0;
            const pending = composed?.pending ?? data.pending[ns] ?? 0;
            const stale = composed?.stale ?? nsStats?.stale ?? 0;
            const total = composed?.total ?? embedded + pending;
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

/* ---------- Embedding Tab ---------- */

export function EmbeddingTab() {
  const queryClient = useQueryClient();
  const selection = useProjectSelection();
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Per-section pill state — sections can hold different scopes concurrently.
  // Embedding namespace + actions are Grove-wide. There's no
  // project-narrowed path on the server (vector store doesn't carry
  // project_id) and the actions (rebuild/reconcile/clean) iterate
  // every namespace. Pinned to 'grove' instead of exposing a pill
  // that pretended to switch behavior.
  const namespaceScope: OperationsScope = 'grove';
  const actionScope: OperationsScope = 'grove';
  // The Namespace Breakdown pill drives the data query — switching to
  // 'grove' refetches without the project_id filter so counts span
  // every project in the active Grove.
  const { data, isLoading, isError, error } = useEmbeddingDetails(namespaceScope);
  const [pendingDialog, setPendingDialog] = useState<
    | null
    | {
        action: string;
        scopeKind: OperationsScope;
        run: () => Promise<void>;
        variant?: 'destructive';
      }
  >(null);
  const [dialogPending, setDialogPending] = useState(false);

  function confirmAndRun(
    actionKey: 'reconcile' | 'reembed-stale' | 'rebuild' | 'clean-orphans',
    label: string,
    run: () => Promise<void>,
    variant?: 'destructive',
  ) {
    const wireScope = buildActionScope(actionScope, selection);
    const requires = wireScope ? actionRequiresConfirmation(actionKey, wireScope) : false;
    if (!requires) {
      void run();
      return;
    }
    setPendingDialog({ action: label, scopeKind: actionScope, run, variant });
  }

  // --- Sparkline history tracking ---
  const [totalHistory, setTotalHistory] = useState<number[]>([]);
  const totalForSparkline = data?.total ?? null;

  useEffect(() => {
    if (totalForSparkline === null) return;
    setTotalHistory((prev) => {
      const next = [...prev, totalForSparkline];
      return next.length > SPARKLINE_HISTORY_LENGTH
        ? next.slice(-SPARKLINE_HISTORY_LENGTH)
        : next;
    });
  }, [totalForSparkline]);

  // Activity log moved to /logs?component=embedding — see the
  // link rendered at the bottom of the tab.

  // --- Action handlers ---

  async function doReembedStale() {
    setActionResult(null);
    try {
      const result = await postJson<{
        reembedded?: number;
        passes?: number;
        batch_size?: number;
        summary?: { ok: number; failed: number };
      }>(
        '/embedding/reembed-stale',
        { scope: buildActionScope(actionScope, selection) },
      );
      if (result.summary) {
        setActionResult({
          type: result.summary.failed > 0 ? 'error' : 'success',
          text: `Re-embed dispatched across ${result.summary.ok + result.summary.failed} Grove(s); ${result.summary.failed} failed`,
        });
      } else {
        setActionResult({
          type: 'success',
          text: `Re-embedded ${result.reembedded ?? 0} stale vectors in ${result.passes ?? 0} pass(es)`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${errorMessage(err)}` });
    }
  }
  function handleReembedStale() {
    confirmAndRun('reembed-stale', 'Re-embed stale vectors', doReembedStale);
  }

  async function doRebuild() {
    setActionResult(null);
    try {
      const result = await postJson<{
        queued?: number;
        embedded?: number;
        passes?: number;
        batch_size?: number;
        remaining_queue_depth?: number;
        results?: Array<{ grove_slug: string; ok: boolean; queued?: number; embedded?: number }>;
        summary?: { ok: number; failed: number };
      }>('/embedding/rebuild', { scope: buildActionScope(actionScope, selection) });
      if (result.summary) {
        setActionResult({
          type: result.summary.failed > 0 ? 'error' : 'success',
          text: `Rebuild dispatched across ${result.summary.ok + result.summary.failed} Grove(s); ${result.summary.failed} failed`,
        });
      } else {
        setActionResult({
          type: 'success',
          text: `Rebuild cleared ${result.queued ?? 0} vectors and re-embedded ${result.embedded ?? 0} records (passes ${result.passes ?? 0}, remaining ${result.remaining_queue_depth ?? 0})`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${errorMessage(err)}` });
    }
  }
  function handleRebuild() {
    confirmAndRun('rebuild', 'Rebuild all vectors', doRebuild, 'destructive');
  }

  async function doCleanOrphans() {
    setActionResult(null);
    try {
      const result = await postJson<{
        orphans_cleaned?: number;
        summary?: { ok: number; failed: number };
      }>('/embedding/clean-orphans', {
        scope: buildActionScope(actionScope, selection),
      });
      if (result.summary) {
        setActionResult({
          type: result.summary.failed > 0 ? 'error' : 'success',
          text: `Clean orphans dispatched across ${result.summary.ok + result.summary.failed} Grove(s); ${result.summary.failed} failed`,
        });
      } else {
        setActionResult({ type: 'success', text: `Cleaned ${result.orphans_cleaned ?? 0} orphan vectors` });
      }
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${errorMessage(err)}` });
    }
  }
  function handleCleanOrphans() {
    confirmAndRun('clean-orphans', 'Clean orphan vectors', doCleanOrphans);
  }

  async function doReconcile() {
    setActionResult(null);
    try {
      const result = await postJson<{
        embedded?: number;
        orphans_cleaned?: number;
        duration_ms?: number;
        batch_size?: number;
        summary?: { ok: number; failed: number };
      }>(
        '/embedding/reconcile',
        { scope: buildActionScope(actionScope, selection) },
      );
      if (result.summary) {
        setActionResult({
          type: result.summary.failed > 0 ? 'error' : 'success',
          text: `Reconcile dispatched across ${result.summary.ok + result.summary.failed} Grove(s); ${result.summary.failed} failed`,
        });
      } else {
        setActionResult({
          type: 'success',
          text: `Reconcile complete: ${result.embedded ?? 0} embedded, ${result.orphans_cleaned ?? 0} orphans cleaned (${result.duration_ms ?? 0}ms)`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${errorMessage(err)}` });
    }
  }
  function handleReconcile() {
    confirmAndRun('reconcile', 'Force reconcile embeddings', doReconcile);
  }

  async function doRetryStuck() {
    setActionResult(null);
    try {
      const result = await postJson<{ reset: number }>(
        '/canopy/describe/retry-stuck',
        { scope: buildActionScope(actionScope, selection) },
      );
      setActionResult({ type: 'success', text: `Reset ${result.reset ?? 0} stuck row(s) for re-processing` });
      queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    } catch (err) {
      setActionResult({ type: 'error', text: `Error: ${errorMessage(err)}` });
    }
  }

  if (!data) {
    return (
      <PageLoading
        isLoading={isLoading}
        error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
        loadingText="Loading embedding details..."
      >
        <div />
      </PageLoading>
    );
  }

  // --- Aggregate totals ---
  // Sum over namespace_breakdown so the header cards use the same composed
  // source as the grid rows (which add canopy undescribed to pending and
  // max content-staleness for canopy_entries). Fall back to the raw fields
  // when namespace_breakdown is absent (older daemon responses).
  const totalPending = EMBEDDABLE_NAMESPACES.reduce(
    (sum, ns) => sum + (data.namespace_breakdown?.[ns]?.pending ?? data.pending[ns] ?? 0), 0);
  const totalStale = EMBEDDABLE_NAMESPACES.reduce(
    (sum, ns) => sum + (data.namespace_breakdown?.[ns]?.stale ?? data.by_namespace[ns]?.stale ?? 0), 0);
  const canopyDescribePending = data.canopy_describe?.pending ?? 0;
  const canopyDescribeStuck = data.canopy_describe?.stuck ?? 0;
  const canopyDescribePendingLabel = canopyDescribePending > 0
    ? `${data.canopy_describe?.undescribed ?? 0} new, ${data.canopy_describe?.stale ?? 0} stale`
    : 'fresh';
  const canopyDescribeSublabel = canopyDescribeStuck > 0
    ? `⚠ stuck: ${canopyDescribeStuck} · ${canopyDescribePendingLabel}`
    : canopyDescribePendingLabel;

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
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Total Vectors" value={String(data.total)} sparklineData={totalHistory} accent="sage" />
        <StatCard label="Pending" value={String(totalPending)} accent={totalPending > 0 ? 'ochre' : 'outline'} />
        <StatCard label="Stale" value={String(totalStale)} accent={totalStale > 0 ? 'terracotta' : 'outline'} />
        <StatCard
          label="Canopy Scribe"
          value={String(canopyDescribePending)}
          sublabel={canopyDescribeSublabel}
          accent={canopyDescribeStuck > 0 ? 'terracotta' : canopyDescribePending > 0 ? 'ochre' : 'outline'}
        />
      </div>

      {/* Namespace breakdown — always Grove-wide (the vector store
          doesn't carry project_id, so project narrowing isn't a real
          option). */}
      <Surface level="low" className="p-6 space-y-4">
        <SectionHeader>Namespace Breakdown</SectionHeader>
        <NamespaceTable data={data} />
      </Surface>

      {/* Reconcile Policy moved to Grove Settings → Embedding
          (`run_in_deep_sleep`). Maintenance is action-only now;
          settings live with their categorical siblings. */}

      {/* Action toolbar — always Grove-wide. The action handlers
          iterate every embeddable namespace; there's no
          project-narrowed code path on the server side. */}
      <Surface level="low" className="p-6 space-y-3">
        <SectionHeader>Actions</SectionHeader>
        <div className="flex flex-wrap gap-2">
          {canopyDescribeStuck > 0 && (
            <Button variant="ghost" size="sm" onClick={doRetryStuck}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry stuck
            </Button>
          )}
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

      {/* Activity log replaced with a deep-link to the Logs page
          pre-filtered by the embedding component — keeps the page
          action-focused and avoids duplicating logs UI here. */}
      <div className="flex justify-end">
        <Link
          to="/logs?component=embedding"
          className="font-sans text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
        >
          View embedding activity in Logs →
        </Link>
      </div>
      {pendingDialog && (
        <ActionConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setPendingDialog(null); }}
          action={pendingDialog.action}
          scope={
            buildActionScope(pendingDialog.scopeKind, selection) ?? {
              kind: 'all-groves',
            }
          }
          variant={pendingDialog.variant}
          isPending={dialogPending}
          onConfirm={async () => {
            setDialogPending(true);
            try {
              await pendingDialog.run();
            } finally {
              setDialogPending(false);
              setPendingDialog(null);
            }
          }}
        />
      )}
    </div>
  );
}
