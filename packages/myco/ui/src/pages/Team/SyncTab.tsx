import { useState, useCallback } from 'react';
import { RefreshCw, ArrowUpCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useTeamQueueStats,
  useTeamSyncSummary,
  useTeamDlq,
  type TeamStatusResponse,
  type DlqMessage,
  type TeamSyncSummaryResponse,
  type TeamDriftRow,
} from '../../hooks/use-team';
import { useDaemon } from '../../hooks/use-daemon';
import { postJson, ApiError } from '../../lib/api';
import { type ReactNode } from 'react';
import { Panel } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { StatCard } from '../../components/ui/stat-card';
import { QueueTile } from '../../components/team/QueueTile';
import { RefreshIndicator } from '../../components/ui/refresh-indicator';
import { POLL_INTERVALS } from '../../lib/constants';

function SyncPanel({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel tone="sage" eyebrow="Sync" title={title} actions={actions}>
      {children}
    </Panel>
  );
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
}

function formatTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return 'Never';
  return time.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatTableName(table: string): string {
  return table.replace(/_/g, ' ');
}

function formatDelta(delta: number): string {
  return delta === 0 ? '0' : delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();
}

function tableDelta(local: number, remote: number | undefined): string {
  if (remote === undefined) return '—';
  return formatDelta(remote - local);
}

function VectorsTile({
  remote,
}: {
  remote: TeamSyncSummaryResponse['remote'];
  /** Local-embedded count is intentionally unused: it counts rows in
   * the local SQLite vectors.db (Canopy + everything else) and isn't
   * apples-to-apples with the team Vectorize index, which only holds
   * the embeddable + remote-synced subset. Comparing them produced a
   * misleading "missing 1100+ vectors" reading that wasn't real. The
   * authoritative target is `remote.embeddable_count` — exactly the
   * rows the consumer would embed if reindexed. */
  localEmbedded?: number | null;
}) {
  if (!remote) {
    return <StatCard label="Vectors" value="—" accent="outline" />;
  }
  if (!remote.vector_index_healthy) {
    return (
      <StatCard
        label="Vectors"
        value="error"
        sublabel={remote.vector_index_error ?? 'index unavailable'}
        accent="terracotta"
      />
    );
  }
  const remoteCount = remote.vector_count ?? 0;
  const target = remote.embeddable_count;
  const valueLabel = formatNumber(remoteCount);

  if (target === null || target === undefined) {
    return <StatCard label="Vectors" value={valueLabel} accent="sage" />;
  }

  // Allowed slack: residual vectors from older ID schemes can leave
  // remoteCount slightly above target without being a problem. Treat
  // anything within 10% above target as healthy.
  const upperBound = target + Math.ceil(target * 0.1);
  if (remoteCount >= target && remoteCount <= upperBound) {
    return (
      <StatCard
        label="Vectors"
        value={valueLabel}
        sublabel={`indexed (target ${formatNumber(target)})`}
        accent="sage"
      />
    );
  }
  if (remoteCount > upperBound) {
    return (
      <StatCard
        label="Vectors"
        value={valueLabel}
        sublabel={`+${formatNumber(remoteCount - target)} stale vs target ${formatNumber(target)}`}
        accent="ochre"
      />
    );
  }
  // remoteCount < target — genuine gap.
  const missing = target - remoteCount;
  const isBroken = target > 0 && remoteCount < Math.max(1, target * 0.05);
  return (
    <StatCard
      label="Vectors"
      value={valueLabel}
      sublabel={isBroken
        ? `index empty — run reindex (target ${formatNumber(target)})`
        : `${formatNumber(missing)} missing of ${formatNumber(target)}`}
      accent={isBroken ? 'terracotta' : 'ochre'}
    />
  );
}

function DriftTable({ rows }: { rows: TeamDriftRow[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-outline-variant/10">
      <table className="w-full text-sm">
        <thead className="bg-surface-container/40 text-xs uppercase text-outline">
          <tr>
            <th className="px-3 py-2 text-left font-mono">Table</th>
            <th className="px-3 py-2 text-right font-mono">Local</th>
            <th className="px-3 py-2 text-right font-mono">Cloud</th>
            <th className="px-3 py-2 text-right font-mono">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.table}
              className={row.delta !== 0
                ? 'border-t border-outline-variant/10 bg-terracotta/[0.04]'
                : 'border-t border-outline-variant/10'}
            >
              <td className="px-3 py-2 text-on-surface">{formatTableName(row.table)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-on-surface">{formatNumber(row.local)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-on-surface">{formatNumber(row.cloud)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${row.delta !== 0 ? 'text-terracotta' : 'text-on-surface-variant'}`}>
                {formatDelta(row.delta)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DlqRow({ message, onAction, busy }: { message: DlqMessage; onAction: (action: 'retry' | 'discard', leaseId: string) => void; busy: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-outline-variant/10 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-on-surface font-mono truncate">
          {message.table_name} / {message.row_id}
        </p>
        <p className="text-xs text-on-surface-variant truncate">
          machine={message.machine_id} op={message.operation}{message.reason ? ` · ${message.reason}` : ''}
        </p>
        <p className="text-xs text-on-surface-variant/60">
          {new Date(message.created_at * 1000).toLocaleString()}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('retry', message.lease_id)}>Retry</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('discard', message.lease_id)}>Discard</Button>
      </div>
    </div>
  );
}

export function SyncTab({ status }: { status: TeamStatusResponse }) {
  const queryClient = useQueryClient();
  const enabled = status.enabled && status.healthy;
  const { data: queueStats, isLoading: queueLoading, isFetching: queueFetching, refetch: refetchQueue } = useTeamQueueStats(enabled);
  const { data: syncSummary, isLoading: summaryLoading, isFetching: summaryFetching, refetch: refetchSummary } = useTeamSyncSummary(enabled);
  const { data: daemonStats } = useDaemon();
  const dlqEnabled = enabled;
  const { data: dlq, isLoading: dlqLoading, isFetching: dlqFetching, refetch: refetchDlq } = useTeamDlq(dlqEnabled);
  const [busy, setBusy] = useState(false);
  const [dlqMessage, setDlqMessage] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);
  const [drainMessage, setDrainMessage] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMessage, setRebuildMessage] = useState<string | null>(null);

  const queueUnavailable = !enabled || (!queueLoading && !queueStats);
  const failedSyncsLoading = queueLoading || (dlqEnabled && dlqLoading);
  const failedSyncsUnavailable = !enabled || (!failedSyncsLoading && dlqEnabled && !dlq);
  const unavailableMessage = 'Team connection is unhealthy.';
  const syncFetching = queueFetching || summaryFetching || dlqFetching;
  const handleRefreshAll = useCallback(() => {
    void refetchQueue();
    void refetchSummary();
    void refetchDlq();
  }, [refetchQueue, refetchSummary, refetchDlq]);

  const handleDrain = useCallback(async () => {
    setDraining(true);
    setDrainMessage(null);
    try {
      const res = await postJson<{
        enqueued: number;
        flushed?: number;
        rejected?: number;
        batches?: number;
        duration_ms?: number;
        flush_error?: string | null;
        mode?: string;
        vector_enqueued?: number | null;
        vector_error?: string | null;
      }>('/team/backfill', { mode: 'all' });
      const vectorSuffix = res.vector_error
        ? `; vector reindex failed: ${res.vector_error}`
        : res.vector_enqueued
          ? ` and queued ${formatNumber(res.vector_enqueued)} vectors for reindex`
          : '';
      if (res.flush_error) {
        setDrainMessage(`Backfilled ${res.enqueued} records, but sync failed: ${res.flush_error}`);
      } else if (res.enqueued > 0 || (res.flushed ?? 0) > 0) {
        setDrainMessage(`Backfilled ${formatNumber(res.enqueued)} records and handed off ${formatNumber(res.flushed)} in ${res.batches ?? 0} batches${vectorSuffix}.`);
      } else if (res.vector_enqueued) {
        setDrainMessage(`No eligible Grove records found${vectorSuffix}.`);
      } else {
        setDrainMessage('No eligible Grove records found.');
      }
      queryClient.invalidateQueries({ queryKey: ['team-status'] });
      queryClient.invalidateQueries({ queryKey: ['team-sync-summary'] });
      queryClient.invalidateQueries({ queryKey: ['team-queue-stats'] });
      queryClient.invalidateQueries({ queryKey: ['team-dlq'] });
    } catch {
      setDrainMessage('Backfill failed.');
    } finally {
      setDraining(false);
    }
  }, [queryClient]);

  const handleDlqAction = useCallback(async (action: 'retry' | 'discard', leaseId: string) => {
    setBusy(true);
    setDlqMessage(null);
    try {
      const res = await postJson<{ retried?: number; discarded?: number }>(`/team/dlq/${action}`, { lease_ids: [leaseId] });
      const count = (action === 'retry' ? res.retried : res.discarded) ?? 0;
      setDlqMessage(count > 0
        ? `${action === 'retry' ? 'Retried' : 'Discarded'} 1 message.`
        : `${action === 'retry' ? 'Retry' : 'Discard'} returned 0 — lease may have expired. Refresh and try again.`);
      // Await refetch so the row disappears (or reappears with a fresh
      // lease_id) before we clear busy state.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['team-dlq'] }),
        queryClient.refetchQueries({ queryKey: ['team-queue-stats'] }),
        queryClient.refetchQueries({ queryKey: ['team-sync-summary'] }),
      ]);
    } catch (err) {
      setDlqMessage(`${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [queryClient]);

  const handleReplayAll = useCallback(async () => {
    if (!dlq || dlq.messages.length === 0) return;
    setBusy(true);
    setDlqMessage(null);
    try {
      const res = await postJson<{ retried?: number }>('/team/dlq/retry', { lease_ids: dlq.messages.map((m) => m.lease_id) });
      setDlqMessage(`Retried ${res.retried ?? 0} of ${dlq.messages.length} messages.`);
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['team-dlq'] }),
        queryClient.refetchQueries({ queryKey: ['team-queue-stats'] }),
        queryClient.refetchQueries({ queryKey: ['team-sync-summary'] }),
      ]);
    } catch (err) {
      setDlqMessage(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [dlq, queryClient]);

  const handleUpgradeWorker = useCallback(async () => {
    setUpgrading(true);
    setUpgradeMessage(null);
    try {
      const res = await postJson<{ success: boolean; worker_url?: string; version?: string; error?: string }>('/team/upgrade-worker');
      if (res.success) {
        setUpgradeMessage(`Worker updated to v${res.version}`);
        queryClient.invalidateQueries({ queryKey: ['team-status'] });
      } else {
        setUpgradeMessage(res.error ?? 'Upgrade failed');
      }
    } catch (err) {
      if (err instanceof ApiError && typeof err.body === 'object' && err.body !== null && 'error' in err.body
          && (err.body as { error: unknown }).error === 'myco_team_not_installed') {
        const message = 'message' in err.body ? String((err.body as { message: unknown }).message) : null;
        setUpgradeMessage(message ?? 'Install @goondocks/myco-team to enable Worker upgrades, or use myco-team-dev after make dev-link in a dev checkout.');
      } else {
        setUpgradeMessage(err instanceof Error ? err.message : 'Upgrade failed');
      }
    } finally {
      setUpgrading(false);
    }
  }, [queryClient]);

  const handleRebuild = useCallback(async () => {
    setRebuilding(true);
    setRebuildMessage(null);
    try {
      const res = await postJson<{ ok: boolean; handedOff: number; rejected: number; batches: number; error?: string }>('/team/rebuild');
      if (res.error) {
        setRebuildMessage(`Rebuild failed: ${res.error}`);
      } else {
        setRebuildMessage(`Rebuilt: handed off ${formatNumber(res.handedOff)} records in ${res.batches} batch${res.batches === 1 ? '' : 'es'}.`);
      }
      queryClient.invalidateQueries({ queryKey: ['team-status'] });
      queryClient.invalidateQueries({ queryKey: ['team-sync-summary'] });
      queryClient.invalidateQueries({ queryKey: ['team-queue-stats'] });
      queryClient.invalidateQueries({ queryKey: ['team-dlq'] });
    } catch (err) {
      setRebuildMessage(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRebuilding(false);
    }
  }, [queryClient]);

  const dlqMessages = dlq?.messages ?? [];
  const remoteTotal = syncSummary?.remote_machine_total ?? null;
  const localTotal = syncSummary?.local.total_records ?? null;
  const workerVersionKnown = Boolean(status.deployed_worker_version && status.local_team_package_version);
  const localTeamPackageSourceLabel =
    status.local_team_package_source === 'dev-linked'
      ? 'Dev linked'
      : status.local_team_package_source === 'installed'
        ? 'Installed'
        : status.local_team_package_source === 'path'
          ? 'On PATH'
          : 'Available';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <RefreshIndicator
          intervalMs={enabled ? POLL_INTERVALS.TEAM : undefined}
          isFetching={syncFetching}
          onManualRefresh={handleRefreshAll}
        />
      </div>
      <SyncPanel
        title="Worker"
        actions={
          <Badge variant={status.worker_update_available ? 'outline' : 'default'}>
            {status.worker_update_available ? 'update available' : workerVersionKnown ? 'current' : 'deployed'}
          </Badge>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Deployed"
            value={status.deployed_worker_version ? `v${status.deployed_worker_version}` : 'Unknown'}
            accent={status.worker_update_available ? 'ochre' : 'outline'}
          />
          <StatCard
            label={localTeamPackageSourceLabel}
            value={status.local_team_package_version ? `v${status.local_team_package_version}` : 'Not found'}
            accent="outline"
          />
          <StatCard
            label="Protocol"
            value={`v${status.sync_protocol_version}`}
            accent="outline"
          />
        </div>
        {status.worker_update_available && (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <ArrowUpCircle className="h-5 w-5 text-ochre shrink-0" />
              <div>
                <p className="text-sm font-medium text-on-surface">Worker update available</p>
                <p className="text-xs text-on-surface-variant">
                  Deployed: v{status.deployed_worker_version ?? '?'} · Available: v{status.local_team_package_version ?? '?'}
                </p>
              </div>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={handleUpgradeWorker}
              disabled={upgrading}
            >
              {upgrading ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  Deploying...
                </>
              ) : (
                'Update worker'
              )}
            </Button>
          </div>
        )}
        {upgradeMessage && (
          <p className="text-xs text-on-surface-variant m-0 mt-3">{upgradeMessage}</p>
        )}
      </SyncPanel>

      <SyncPanel
        title="Remote store"
        actions={
          syncSummary?.remote ? (
            <Badge variant="default">v{syncSummary.remote.package_version}</Badge>
          ) : null
        }
      >
        {summaryLoading && !syncSummary ? (
          <p className="text-xs text-on-surface-variant m-0">Loading...</p>
        ) : syncSummary?.remote_error ? (
          <p className="text-sm text-terracotta break-words m-0">{syncSummary.remote_error}</p>
        ) : syncSummary ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Local records" value={formatNumber(localTotal)} sublabel="this machine" accent="outline" />
              <StatCard label="Remote records" value={formatNumber(remoteTotal)} sublabel="this machine" accent="outline" />
              <StatCard
                label="Delta"
                value={remoteTotal === null || localTotal === null ? '—' : tableDelta(localTotal, remoteTotal)}
                accent={remoteTotal !== null && localTotal !== null && remoteTotal !== localTotal ? 'ochre' : 'outline'}
              />
              <VectorsTile remote={syncSummary.remote} localEmbedded={daemonStats?.embedding.embedded_count ?? null} />
            </div>
            {syncSummary.drift && syncSummary.drift.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-on-surface-variant m-0">Local vs cloud (this machine)</p>
                <DriftTable rows={syncSummary.drift} />
              </div>
            ) : syncSummary.total_delta === 0 ? (
              <p className="text-xs text-sage m-0">In sync</p>
            ) : null}
            <p className="text-xs text-on-surface-variant m-0">
              Last synced {formatTime(syncSummary.last_handoff?.completed_at)}
            </p>
            {(syncSummary.total_delta ?? 0) > 0 && (
              <div className="flex flex-col gap-2 border-t border-outline-variant/10 pt-3">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-xs text-on-surface-variant m-0">
                    Replaces this machine's cloud data with your local Grove. One-way; no reconciliation.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRebuild}
                    disabled={rebuilding}
                  >
                    {rebuilding ? (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1.5" />
                        Rebuilding...
                      </>
                    ) : (
                      'Rebuild from local'
                    )}
                  </Button>
                </div>
                {rebuildMessage && (
                  <p className="text-xs text-on-surface-variant m-0">{rebuildMessage}</p>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-on-surface-variant m-0">{unavailableMessage}</p>
        )}
      </SyncPanel>

      <SyncPanel title="Queue health">
        {queueLoading ? (
          <p className="text-xs text-on-surface-variant m-0">Loading...</p>
        ) : queueUnavailable ? (
          <p className="text-sm text-on-surface-variant m-0">{unavailableMessage}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Operational signals only: the queue draining to zero, and any
                failures. Lifetime enqueued/processed counters are intentionally
                not shown — the proof of work is the Remote-store sync state
                (drift → in sync), and Cloudflare observability covers throughput. */}
            <div className="grid grid-cols-3 gap-3">
              <QueueTile
                label="In flight"
                value={queueStats?.backlog ?? 0}
                tone={(queueStats?.backlog ?? 0) > 0 ? 'ochre' : 'outline'}
                pulse={(queueStats?.backlog ?? 0) > 0}
                sub={(queueStats?.backlog ?? 0) > 0 ? 'draining' : undefined}
              />
              <QueueTile
                label="Failed"
                value={queueStats?.failed ?? 0}
                tone={(queueStats?.failed ?? 0) > 0 ? 'terracotta' : 'outline'}
              />
              <QueueTile
                label="Embeds failed"
                value={queueStats?.embed_failed ?? 0}
                tone={(queueStats?.embed_failed ?? 0) > 0 ? 'terracotta' : 'outline'}
              />
            </div>
            {queueStats?.last_run_at != null && (
              <p className="text-xs text-on-surface-variant m-0">
                Last run {new Date(queueStats.last_run_at * 1000).toLocaleString()}
              </p>
            )}
            {queueStats?.last_error && (
              <p className="text-xs text-terracotta break-words m-0">{queueStats.last_error}</p>
            )}
            {(queueStats?.embed_failed ?? 0) > 0 && queueStats?.last_embed_error && (
              <p className="text-xs text-terracotta break-words m-0">{queueStats.last_embed_error}</p>
            )}
          </div>
        )}
      </SyncPanel>

      <SyncPanel
        title="Failed syncs"
        actions={
          dlqMessages.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || failedSyncsUnavailable}
              onClick={handleReplayAll}
            >
              {`Retry all (${dlqMessages.length})`}
            </Button>
          ) : null
        }
      >
        {dlqMessage && (
          <p className="text-xs font-mono text-on-surface-variant m-0 mb-3">{dlqMessage}</p>
        )}
        {failedSyncsLoading ? (
          <p className="text-xs text-on-surface-variant m-0">Loading...</p>
        ) : failedSyncsUnavailable ? (
          <p className="text-sm text-on-surface-variant m-0">{unavailableMessage}</p>
        ) : dlqMessages.length === 0 ? (
          <p className="text-sm text-on-surface-variant m-0">No failed syncs.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-on-surface-variant m-0">
              These records couldn't reach the cloud after repeated tries. Retry to attempt again, or discard to drop them.
            </p>
            <div className="divide-y divide-outline-variant/10">
              {dlqMessages.map((message) => (
                <DlqRow key={message.lease_id} message={message} onAction={handleDlqAction} busy={busy} />
              ))}
            </div>
          </div>
        )}
      </SyncPanel>

      <SyncPanel
        title="Backfill"
        actions={
          <Button size="sm" variant="default" onClick={handleDrain} disabled={draining}>
            {draining ? 'Backfilling...' : 'Backfill existing records'}
          </Button>
        }
      >
        {drainMessage && <p className="text-sm text-sage m-0">{drainMessage}</p>}
      </SyncPanel>
    </div>
  );
}
