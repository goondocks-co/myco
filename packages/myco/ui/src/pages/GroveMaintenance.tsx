import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, Database, Play, Trash2, RefreshCw, RotateCcw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { CONFIG_SECTION_IDS } from '@myco/config/focus';
import { errorMessage } from '../lib/error';
import { useEmbeddingDetails, type EmbeddingDetails } from '../hooks/use-embedding-details';
import { useDatabaseDetails, type DatabaseDetails } from '../hooks/use-database-details';
import { useScopedConfig } from '../hooks/use-scoped-config';
import { ScopedField } from '../components/config/ScopedField';
import { Switch } from '../components/ui/switch';
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
import {
  OperationsScopePill,
  type OperationsScope,
} from '../components/operations/OperationsScopePill';
import {
  OPERATIONS_SCOPE_HELPER_TEXT,
  buildActionScope,
} from '../components/operations/scope-helpers';
import {
  ActionConfirmDialog,
  actionRequiresConfirmation,
} from '../components/operations/ActionConfirmDialog';
import { useProjectSelection } from '../hooks/use-project-selection';
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


/** Fragmentation percentage at or above which the stat card uses a warning accent. */
const FRAGMENTATION_WARN_PCT = 15;

/** Error-code discriminant returned by /api/database/vacuum on 409. */
const VACUUM_INSUFFICIENT_DISK = 'insufficient_disk_space';

/** Number of recent data points to show in stat card sparklines. */
const SPARKLINE_HISTORY_LENGTH = 20;

/* ---------- Tabs ---------- */

type ActiveTab = 'embedding' | 'database';

const MAINTENANCE_TABS: Tab[] = [
  { id: 'embedding', label: 'Embedding' },
  { id: 'database', label: 'Database' },
];

const VALID_TABS = new Set<ActiveTab>(['embedding', 'database']);

/**
 * Scope options on the Database tab. SQLite operations target a whole
 * `.sqlite` file; you can't narrow to a single project's rows for
 * optimize/vacuum/reindex/integrity-check, and the schema breakdown
 * counts entire tables. The pill therefore omits the project option
 * across every Database section.
 */
const DATABASE_SCOPE_AVAILABLE: ReadonlyArray<OperationsScope> = ['grove', 'all-groves'];

/**
 * Scope options on Backup. A backup file is a per-Grove SQLite dump;
 * project narrowing isn't a thing. The pill offers Grove and All-Groves.
 */
const BACKUP_SCOPE_AVAILABLE: ReadonlyArray<OperationsScope> = ['grove', 'all-groves'];
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

/**
 * Section header that renders a live OperationsScopePill instead of the
 * read-only ScopeBadge — lets users widen the action target from project
 * (default) to grove or all-groves. The pill state lives in the calling
 * section so different sections can hold different scopes concurrently.
 */
function PillSectionTitle({
  title,
  value,
  onChange,
  available,
}: {
  title: string;
  value: OperationsScope;
  onChange: (next: OperationsScope) => void;
  available?: ReadonlyArray<OperationsScope>;
}) {
  return (
    <div className="flex items-center gap-3">
      <SectionHeader>{title}</SectionHeader>
      <OperationsScopePill value={value} onChange={onChange} available={available} />
    </div>
  );
}

function PillScopeHelper({ scope }: { scope: OperationsScope }) {
  return (
    <p className="font-sans text-xs text-on-surface-variant">
      {OPERATIONS_SCOPE_HELPER_TEXT[scope]}
    </p>
  );
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


function ScheduledMaintenanceCard({
  details,
  onActionResult,
}: {
  details: DatabaseDetails;
  onActionResult: (r: { type: 'success' | 'error'; text: string }) => void;
}) {
  const { effective } = useScopedConfig();
  const queryClient = useQueryClient();
  const selection = useProjectSelection();
  const [running, setRunning] = useState(false);
  const [pillScope, setPillScope] = useState<OperationsScope>('grove');
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!effective) return null;

  const enabled = effective.maintenance.auto_optimize;
  const intervalHours = effective.maintenance.auto_optimize_interval_hours;

  const lastRunMs = details.last_optimize_at ? new Date(details.last_optimize_at).getTime() : null;
  const nextRunMs = lastRunMs !== null ? lastRunMs + intervalHours * SECONDS_PER_HOUR * 1000 - Date.now() : 0;

  async function doRunNow() {
    setRunning(true);
    try {
      const wireScope = buildActionScope(pillScope, selection);
      const result = await postJson<{
        actions_completed?: Array<{ name: string }>;
        actions_failed?: Array<{ name: string; error?: string }>;
        duration_ms?: number;
        summary?: { ok: number; failed: number };
      }>('/database/optimize', { scope: wireScope });
      if (result.summary) {
        onActionResult({
          type: result.summary.failed > 0 ? 'error' : 'success',
          text: `Optimize dispatched across ${result.summary.ok + result.summary.failed} Grove(s); ${result.summary.failed} failed`,
        });
      } else {
        const failed = result.actions_failed?.length ?? 0;
        onActionResult({
          type: failed > 0 ? 'error' : 'success',
          text: 'Optimize complete: ' + (result.actions_completed?.length ?? 0) + ' steps, ' + failed + ' failed (' + (result.duration_ms ?? 0) + 'ms)',
        });
      }
      queryClient.invalidateQueries({ queryKey: ['database-details'] });
    } catch (err) {
      onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
    } finally {
      setRunning(false);
    }
  }

  function handleRunNow() {
    const wireScope = buildActionScope(pillScope, selection);
    if (wireScope && actionRequiresConfirmation('optimize', wireScope)) {
      setConfirmOpen(true);
      return;
    }
    void doRunNow();
  }

  const groveSlug = selection?.grove.slug ?? '';
  const settingsHref = `/g/${groveSlug}/settings`;

  return (
    <Surface level="low" className="p-6 space-y-4">
      <PillSectionTitle title="Scheduled Maintenance" value={pillScope} onChange={setPillScope} available={DATABASE_SCOPE_AVAILABLE} />
      <PillScopeHelper scope={pillScope} />
      <p className="font-sans text-sm text-on-surface">
        <span className="font-medium">Auto-optimize</span>{' '}
        {enabled ? (
          <>
            <span className="text-primary">on</span>, every {intervalHours}h.
          </>
        ) : (
          <span className="text-on-surface-variant">off.</span>
        )}{' '}
        <Link to={settingsHref} className="text-primary hover:text-primary/80 transition-colors text-xs">
          Configure in Settings →
        </Link>
      </p>
      <p className="font-sans text-sm text-on-surface-variant">
        Last run: {details.last_optimize_at ? formatTimeAgo(details.last_optimize_at) : 'never'}
        {enabled && lastRunMs !== null && <> · Next: {formatCountdown(nextRunMs)}</>}
      </p>
      <Button variant="secondary" size="sm" onClick={handleRunNow} disabled={running}>
        <Play className="mr-2 h-4 w-4" />
        {running ? 'Running...' : 'Run now'}
      </Button>
      <ActionConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        action="Optimize database"
        scope={buildActionScope(pillScope, selection) ?? { kind: 'all-groves' }}
        isPending={running}
        onConfirm={async () => {
          await doRunNow();
          setConfirmOpen(false);
        }}
      />
    </Surface>
  );
}

function DatabaseActions({
  onActionResult,
}: {
  onActionResult: (r: { type: 'success' | 'error'; text: string }) => void;
}) {
  const queryClient = useQueryClient();
  const selection = useProjectSelection();
  const [busy, setBusy] = useState(false);
  const [pillScope, setPillScope] = useState<OperationsScope>('grove');
  const [pendingDialog, setPendingDialog] = useState<
    | null
    | {
        action: string;
        run: () => Promise<void>;
        variant?: 'destructive';
      }
  >(null);

  function gatedRun(
    actionKey: 'integrity-check' | 'vacuum' | 'reindex',
    label: string,
    run: () => Promise<void>,
    variant?: 'destructive',
  ) {
    const wireScope = buildActionScope(pillScope, selection);
    const requires = wireScope ? actionRequiresConfirmation(actionKey, wireScope) : false;
    if (!requires) {
      void run();
      return;
    }
    setPendingDialog({ action: label, run, variant });
  }

  async function doIntegrityCheck() {
    setBusy(true);
    try {
      const result = await postJson<{
        status?: string;
        issues?: string[];
        fk_violations?: number;
        duration_ms?: number;
        summary?: { ok: number; failed: number };
      }>('/database/integrity-check', { scope: buildActionScope(pillScope, selection) });
      if (result.summary) {
        onActionResult({
          type: result.summary.failed > 0 ? 'error' : 'success',
          text: `Integrity check across ${result.summary.ok + result.summary.failed} Grove(s); ${result.summary.failed} failed`,
        });
      } else if (result.status === 'ok') {
        onActionResult({ type: 'success', text: 'Integrity check OK (' + (result.duration_ms ?? 0) + 'ms)' });
      } else {
        onActionResult({
          type: 'error',
          text: 'Integrity issues: ' + (result.issues?.length ?? 0) + ' problems, ' + (result.fk_violations ?? 0) + ' FK violations',
        });
      }
      queryClient.invalidateQueries({ queryKey: ['database-details'] });
    } catch (err) {
      onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  function handleIntegrityCheck() {
    gatedRun('integrity-check', 'Run integrity check', doIntegrityCheck);
  }

  async function doVacuum() {
    setBusy(true);
    try {
      const result = await postJson<{
        size_before?: number;
        size_after?: number;
        freed_bytes?: number;
        duration_ms?: number;
        summary?: { ok: number; failed: number };
      }>('/database/vacuum', { scope: buildActionScope(pillScope, selection) });
      if (result.summary) {
        onActionResult({
          type: result.summary.failed > 0 ? 'error' : 'success',
          text: `Vacuum across ${result.summary.ok + result.summary.failed} Grove(s); ${result.summary.failed} failed`,
        });
      } else {
        onActionResult({
          type: 'success',
          text: 'Vacuum complete: freed ' + formatBytes(result.freed_bytes ?? 0) + ' in ' + (result.duration_ms ?? 0) + 'ms',
        });
      }
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
      onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  function handleVacuum() {
    gatedRun('vacuum', 'Vacuum database', doVacuum, 'destructive');
  }

  async function doReindex() {
    setBusy(true);
    try {
      const result = await postJson<{
        duration_ms?: number;
        summary?: { ok: number; failed: number };
      }>('/database/reindex', {
        scope: buildActionScope(pillScope, selection),
      });
      if (result.summary) {
        onActionResult({
          type: result.summary.failed > 0 ? 'error' : 'success',
          text: `Reindex across ${result.summary.ok + result.summary.failed} Grove(s); ${result.summary.failed} failed`,
        });
      } else {
        onActionResult({ type: 'success', text: 'Reindex complete (' + (result.duration_ms ?? 0) + 'ms)' });
      }
      queryClient.invalidateQueries({ queryKey: ['database-details'] });
    } catch (err) {
      onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  function handleReindex() {
    gatedRun('reindex', 'Reindex database', doReindex);
  }

  return (
    <Surface level="low" className="p-6 space-y-3">
      <PillSectionTitle title="Actions" value={pillScope} onChange={setPillScope} available={DATABASE_SCOPE_AVAILABLE} />
      <PillScopeHelper scope={pillScope} />
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
      {pendingDialog && (
        <ActionConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setPendingDialog(null); }}
          action={pendingDialog.action}
          scope={buildActionScope(pillScope, selection) ?? { kind: 'all-groves' }}
          variant={pendingDialog.variant}
          isPending={busy}
          onConfirm={async () => {
            await pendingDialog.run();
            setPendingDialog(null);
          }}
        />
      )}
    </Surface>
  );
}

/* ---------- Embedding Tab ---------- */

function EmbeddingTab() {
  const queryClient = useQueryClient();
  const selection = useProjectSelection();
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Per-section pill state — sections can hold different scopes concurrently.
  const [namespaceScope, setNamespaceScope] = useState<OperationsScope>('project');
  const [actionScope, setActionScope] = useState<OperationsScope>('project');
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
        <PillSectionTitle
          title="Namespace Breakdown"
          value={namespaceScope}
          onChange={setNamespaceScope}
        />
        <PillScopeHelper scope={namespaceScope} />
        <NamespaceTable data={data} />
      </Surface>

      {/* Reconcile Policy moved to Grove Settings → Embedding
          (`run_in_deep_sleep`). Maintenance is action-only now;
          settings live with their categorical siblings. */}

      {/* Action toolbar */}
      <Surface level="low" className="p-6 space-y-3">
        <PillSectionTitle title="Actions" value={actionScope} onChange={setActionScope} />
        <PillScopeHelper scope={actionScope} />
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


/* ---------- Database Tab ---------- */

function DatabaseTab() {
  const { data, isLoading, isError, error } = useDatabaseDetails();

  // Sparkline history for DB size
  const [sizeHistory, setSizeHistory] = useState<number[]>([]);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Database operations target a whole SQLite file — there's no
  // project-narrowed path. Pill omits the project option.
  const [schemaScope, setSchemaScope] = useState<OperationsScope>('grove');
  useEffect(() => {
    if (!data) return;
    setSizeHistory((prev) => {
      const next = [...prev, data.file.size_bytes];
      return next.length > SPARKLINE_HISTORY_LENGTH ? next.slice(-SPARKLINE_HISTORY_LENGTH) : next;
    });
  }, [data]);

  // Activity log moved to /logs?component=database — see the
  // link rendered at the bottom of the tab.

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
        <PillSectionTitle
          title="Schema Breakdown"
          value={schemaScope}
          onChange={setSchemaScope}
          available={DATABASE_SCOPE_AVAILABLE}
        />
        <PillScopeHelper scope={schemaScope} />
        <TablesTable tables={data.tables} />
      </Surface>

      {/* Index summary moved to Grove Dashboard — it's read-only
          information, not an action surface, so it lives next to
          the database stats. */}

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

      {/* Activity log moved to Logs (deep-link with database
          component pre-filtered) — keeps Maintenance focused on
          actions. */}
      <div className="flex justify-end">
        <Link
          to="/logs?component=database"
          className="font-sans text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
        >
          View database activity in Logs →
        </Link>
      </div>
    </div>
  );
}

/* ---------- Grove Maintenance Page ---------- */

const TAB_SUBTITLES: Record<ActiveTab, string> = {
  embedding: 'Embedding actions for this Grove',
  database: 'Database actions and scheduled maintenance',
};

export default function GroveMaintenance() {
  const [activeTab, setActiveTab] = useState<ActiveTab>(readTabFromUrl);

  const handleTabChange = useCallback((tabId: string) => {
    const tab = tabId as ActiveTab;
    setActiveTab(tab);
    writeTabToUrl(tab);
  }, []);

  // Each tab owns its own data fetch — Embedding fetches namespace
  // counts (scope-driven), Database fetches schema details, Backup
  // queries the backup list. Lifting them used to share a loading
  // gate at the page level but kept the Embedding fetch tied to
  // 'project' scope no matter what the namespace pill was set to.
  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title="Grove maintenance"
          subtitle={TAB_SUBTITLES[activeTab]}
          tabs={MAINTENANCE_TABS}
          activeTab={activeTab}
          onTabChange={handleTabChange}
        />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-6 pb-6">
          {activeTab === 'embedding' && <EmbeddingTab />}
          {activeTab === 'database' && <DatabaseTab />}
        </div>
      </div>
    </div>
  );
}
