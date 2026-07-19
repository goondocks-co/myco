/**
 * Database tab body: status bar, size/fragmentation/WAL stat cards,
 * schema table breakdown, scheduled maintenance + release provenance
 * panels, and the optimize/vacuum/reindex/integrity-check action panel
 * with confirm dialog wiring.
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Database, Play, Trash2, RefreshCw, RotateCcw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../lib/error';
import { useDatabaseDetails, type DatabaseDetails } from '../../hooks/use-database-details';
import { useScopedConfig } from '../../hooks/use-scoped-config';
import { Badge } from '../ui/badge';
import { postJson, ApiError } from '../../lib/api';
import { formatBytes, formatTimeAgo, SECONDS_PER_HOUR } from '../../lib/format';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { SectionHeader } from '../ui/section-header';
import { Button } from '../ui/button';
import { HostedUnavailable } from '../ui/hosted-unavailable';
import { hostedDegradedInfo, type HostedDegradedInfo } from '../../lib/degrade';
import { cn } from '../../lib/cn';
import {
  OperationsScopePill,
  type OperationsScope,
} from './OperationsScopePill';
import {
  OPERATIONS_SCOPE_HELPER_TEXT,
  buildActionScope,
} from './scope-helpers';
import {
  ActionConfirmDialog,
  actionRequiresConfirmation,
} from './ActionConfirmDialog';
import { useProjectSelection } from '../../hooks/use-project-selection';

/* ---------- Constants ---------- */

/** Fragmentation percentage at or above which the stat card uses a warning accent. */
const FRAGMENTATION_WARN_PCT = 15;

/** Error-code discriminant returned by /api/database/vacuum on 409. */
const VACUUM_INSUFFICIENT_DISK = 'insufficient_disk_space';

/** Number of recent data points to show in stat card sparklines. */
const SPARKLINE_HISTORY_LENGTH = 20;

/**
 * Scope options on the Database tab. SQLite operations target a whole
 * `.sqlite` file; you can't narrow to a single project's rows for
 * optimize/vacuum/reindex/integrity-check, and the schema breakdown
 * counts entire tables. The pill therefore omits the project option
 * across every Database section.
 */
const DATABASE_SCOPE_AVAILABLE: ReadonlyArray<OperationsScope> = ['grove', 'all-groves'];

/* ---------- Helpers ---------- */

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
  onHosted,
}: {
  details: DatabaseDetails;
  onActionResult: (r: { type: 'success' | 'error'; text: string }) => void;
  onHosted: (info: HostedDegradedInfo) => void;
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
      const degraded = hostedDegradedInfo(err);
      if (degraded) onHosted(degraded);
      else onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
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

  const settingsHref = '/settings#maintenance';

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

interface ReleaseProvenanceReconcileResponse {
  ok: boolean;
  disabled?: boolean;
  results?: Array<{
    grove_id: string;
    project_id: string;
    reconciled: number;
    scanned: number;
    unchanged: number;
    failed: number;
    error?: string;
  }>;
}

function ReleaseProvenanceCard({
  onActionResult,
  onHosted,
}: {
  onActionResult: (r: { type: 'success' | 'error'; text: string }) => void;
  onHosted: (info: HostedDegradedInfo) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleReconcile() {
    setBusy(true);
    try {
      const result = await postJson<ReleaseProvenanceReconcileResponse>(
        '/api/maintenance/release-provenance/reconcile',
        {},
      );
      if (result.disabled) {
        onActionResult({ type: 'success', text: 'Release provenance reconciliation is disabled in config.' });
        return;
      }
      const results = result.results ?? [];
      const totals = results.reduce(
        (acc, r) => ({
          reconciled: acc.reconciled + r.reconciled,
          unchanged: acc.unchanged + r.unchanged,
          failed: acc.failed + r.failed,
          errors: acc.errors + (r.error ? 1 : 0),
        }),
        { reconciled: 0, unchanged: 0, failed: 0, errors: 0 },
      );
      const text = `Release reconcile: ${results.length} project(s), ${totals.reconciled} updated, ${totals.unchanged} unchanged${totals.failed ? `, ${totals.failed} rows failed` : ''}${totals.errors ? `, ${totals.errors} project errors` : ''}.`;
      onActionResult({ type: totals.errors > 0 ? 'error' : 'success', text });
    } catch (err) {
      const degraded = hostedDegradedInfo(err);
      if (degraded) onHosted(degraded);
      else onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Surface level="low" className="p-6 space-y-3">
      <SectionHeader>Release provenance</SectionHeader>
      <p className="font-sans text-sm text-on-surface-variant">
        Re-runs ancestry, patch-id, and (when configured) GitHub PR squash
        evidence checks for every served project. Reconciliation is idempotent
        — safe to invoke repeatedly. Status counts surface in each
        Grove&apos;s maintenance summary.
      </p>
      <div className="flex justify-end">
        <Button onClick={handleReconcile} disabled={busy} variant="outline" size="sm">
          {busy ? 'Reconciling...' : 'Reconcile now'}
        </Button>
      </div>
    </Surface>
  );
}

function DatabaseActions({
  onActionResult,
  onHosted,
}: {
  onActionResult: (r: { type: 'success' | 'error'; text: string }) => void;
  onHosted: (info: HostedDegradedInfo) => void;
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
      const degraded = hostedDegradedInfo(err);
      if (degraded) onHosted(degraded);
      else onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
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
      const degraded = hostedDegradedInfo(err);
      if (degraded) onHosted(degraded);
      else onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
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
      const degraded = hostedDegradedInfo(err);
      if (degraded) onHosted(degraded);
      else onActionResult({ type: 'error', text: 'Error: ' + errorMessage(err) });
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

/* ---------- Database Tab ---------- */

export function DatabaseTab() {
  const { data, isLoading, isError, error } = useDatabaseDetails();

  // Sparkline history for DB size
  const [sizeHistory, setSizeHistory] = useState<number[]>([]);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Database maintenance mutations are degrade-stamped for attached (hosted)
  // projects — they 409 capability_unavailable_hosted. When that's the failure,
  // the child cards signal `onHosted` and the parent renders the uniform
  // HostedUnavailable strip in the shared action-result slot instead of a raw
  // "Error: …". The two setters are mutually exclusive.
  const [hostedInfo, setHostedInfo] = useState<HostedDegradedInfo | null>(null);
  const reportActionResult = (r: { type: 'success' | 'error'; text: string }) => {
    setHostedInfo(null);
    setActionResult(r);
  };
  const reportHosted = (info: HostedDegradedInfo) => {
    setActionResult(null);
    setHostedInfo(info);
  };
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

      <ScheduledMaintenanceCard details={data} onActionResult={reportActionResult} onHosted={reportHosted} />

      <ReleaseProvenanceCard onActionResult={reportActionResult} onHosted={reportHosted} />

      <DatabaseActions onActionResult={reportActionResult} onHosted={reportHosted} />

      {hostedInfo ? (
        <HostedUnavailable info={hostedInfo} variant="inline" />
      ) : actionResult ? (
        <p
          className={cn(
            'font-sans text-sm',
            actionResult.type === 'success' ? 'text-primary' : 'text-tertiary',
          )}
        >
          {actionResult.text}
        </p>
      ) : null}

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
