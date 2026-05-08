import { useState, useCallback } from 'react';
import { WifiOff, RefreshCw, Copy, Check, Eye, EyeOff, ArrowUpCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useTeamStatus,
  useTeamQueueStats,
  useTeamSyncSummary,
  useTeamDlq,
  isTokenMissing,
  type TeamStatusResponse,
  type DlqMessage,
  type TeamSyncSummaryResponse,
} from '../hooks/use-team';
import { useDaemon } from '../hooks/use-daemon';
import { postJson, ApiError } from '../lib/api';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { StatCard } from '../components/ui/stat-card';
import { ConfirmDialog } from '../components/ui/confirm-dialog';

/* ---------- Helpers ---------- */

function CopyableField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <div className="space-y-1">
      <span className="text-xs text-on-surface-variant">{label}</span>
      <div className="flex items-center gap-2 group">
        <span className={`text-sm text-on-surface break-all ${mono ? 'font-mono' : ''}`}>
          {value}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 p-1 rounded text-on-surface-variant hover:text-on-surface opacity-0 group-hover:opacity-100 transition-opacity"
          title="Copy to clipboard"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function RedactedField({ label, value }: { label: string; value: string }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  const redacted = `${value.slice(0, 8)}${'*'.repeat(Math.max(0, value.length - 12))}${value.slice(-4)}`;

  return (
    <div className="space-y-1">
      <span className="text-xs text-on-surface-variant">{label}</span>
      <div className="flex items-center gap-2 group">
        <span className="text-sm text-on-surface font-mono break-all">
          {visible ? value : redacted}
        </span>
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="shrink-0 p-1 rounded text-on-surface-variant hover:text-on-surface transition-opacity"
          title={visible ? 'Hide' : 'Reveal'}
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 p-1 rounded text-on-surface-variant hover:text-on-surface opacity-0 group-hover:opacity-100 transition-opacity"
          title="Copy to clipboard"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

/* ---------- Sub-components ---------- */

function ConnectForm({
  onConnected,
  scopeName,
}: {
  onConnected: () => void;
  scopeName: string;
}) {
  const [url, setUrl] = useState('');
  const [teamKey, setTeamKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await postJson('/team/connect', { url, api_key: teamKey });
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Surface level="low" ghostBorder className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <WifiOff className="h-4 w-4 text-on-surface-variant" />
        <SectionHeader>Connect Grove</SectionHeader>
      </div>
      <p className="text-sm text-on-surface-variant mb-4">
        Provision {scopeName} with <code className="font-mono">myco-team install</code> first
        (<code className="font-mono">myco-team-dev install</code> in dev), then enter the Worker URL and Team key.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-on-surface-variant mb-1">Worker URL</label>
          <Input
            type="url"
            placeholder="https://myco-team.your-account.workers.dev"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-on-surface-variant mb-1">Team key</label>
          <Input
            type="password"
            placeholder="paste team key"
            value={teamKey}
            onChange={(e) => setTeamKey(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="text-sm text-tertiary">{error}</p>
        )}
        <Button type="submit" size="sm" disabled={loading || !url || !teamKey}>
          {loading ? (
            <>
              <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1.5" />
              Connecting...
            </>
          ) : (
            'Connect'
          )}
        </Button>
      </form>
    </Surface>
  );
}

function StatusTab({ status }: { status: TeamStatusResponse }) {
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);
  const [showMcpSnippet, setShowMcpSnippet] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [rotating, setRotating] = useState(false);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await postJson('/team/disconnect');
      queryClient.invalidateQueries({ queryKey: ['team-status'] });
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Status"
          value={status.healthy ? 'Connected' : 'Unhealthy'}
          accent={status.healthy ? 'sage' : 'terracotta'}
        />
        <StatCard
          label="Grove"
          value={status.grove?.name ?? status.project.name}
          accent="outline"
        />
        <StatCard
          label="Protocol"
          value={`v${status.sync_protocol_version}`}
          accent="outline"
        />
        <StatCard
          label="Schema"
          value={`v${status.schema_version}`}
          accent="outline"
        />
      </div>

      <Surface level="low" ghostBorder className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <SectionHeader>Grove Credentials</SectionHeader>
          <Badge variant={status.healthy ? 'default' : 'destructive'}>
            {status.healthy ? 'healthy' : 'unhealthy'}
          </Badge>
        </div>
        <p className="text-xs text-on-surface-variant">
          Use these to connect another machine to this team Grove.
        </p>

        <div className="space-y-3">
          {status.worker_url && (
            <CopyableField label="Worker URL" value={status.worker_url} />
          )}
          {status.team_key && (
            <RedactedField label="Team key" value={status.team_key} />
          )}
        </div>
      </Surface>

      {status.mcp_token && status.mcp_endpoint && (
        <Surface level="low" ghostBorder className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <SectionHeader>Cloud MCP Endpoint</SectionHeader>
              <Badge variant={status.mcp_healthy ? 'default' : 'destructive'}>
                {status.mcp_healthy ? 'healthy' : 'unhealthy'}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowMcpSnippet(!showMcpSnippet)}
                className="text-xs text-on-surface-variant hover:text-on-surface transition-colors"
              >
                {showMcpSnippet ? 'Hide snippet' : 'Config snippet'}
              </button>
              <button
                onClick={() => setShowRotateConfirm(true)}
                className="text-xs text-on-surface-variant hover:text-terracotta-text transition-colors"
              >
                Rotate token
              </button>
            </div>
          </div>
          <p className="text-xs text-on-surface-variant">
            Configure cloud agents with this endpoint to access Grove team intelligence.
          </p>
          <div className="space-y-3">
            <CopyableField label="MCP URL" value={status.mcp_endpoint} />
            <RedactedField label="MCP Access Token" value={status.mcp_token} />
          </div>

          {showMcpSnippet && (() => {
            const snippet = JSON.stringify({
              mcp_servers: [{
                type: 'url',
                url: status.mcp_endpoint,
                name: 'myco',
                authorization_token: status.mcp_token,
              }],
            }, null, 2);
            return (
              <div className="relative">
                <pre className="text-xs bg-surface-container p-3 rounded-lg overflow-x-auto text-on-surface-variant">
                  {snippet}
                </pre>
                <button
                  onClick={() => navigator.clipboard.writeText(snippet)}
                  className="absolute top-2 right-2 p-1 rounded hover:bg-surface-container-high transition-colors"
                >
                  <Copy className="h-3.5 w-3.5 text-on-surface-variant" />
                </button>
              </div>
            );
          })()}
        </Surface>
      )}

      <Surface level="low" ghostBorder className="p-5 space-y-4">
        <SectionHeader>This Node</SectionHeader>
        <div className="grid gap-3">
          <CopyableField label="Machine ID" value={status.machine_id} />
          <CopyableField label="Package Version" value={status.package_version} />
        </div>

        {status.health_error && (
          <p className="text-sm text-tertiary mt-2">
            {status.health_error}
          </p>
        )}
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <SectionHeader>Collective</SectionHeader>
          <Badge variant={status.collective_connected ? 'default' : 'outline'}>
            {status.collective_connected ? 'connected' : 'not connected'}
          </Badge>
        </div>
        {status.collective_connected ? (
          <div className="space-y-3">
            {status.collective_url && (
              <CopyableField label="Collective URL" value={status.collective_url} />
            )}
            {status.collective_project_id && (
              <CopyableField label="Project ID" value={status.collective_project_id} />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <span className="text-xs text-on-surface-variant">Last settings sync</span>
                <p className="text-sm text-on-surface">
                  {status.collective_last_settings_sync ? new Date(status.collective_last_settings_sync * 1000).toLocaleString() : 'Never'}
                </p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-on-surface-variant">Last heartbeat</span>
                <p className="text-sm text-on-surface">
                  {status.collective_last_heartbeat ? new Date(status.collective_last_heartbeat * 1000).toLocaleString() : 'Never'}
                </p>
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-on-surface-variant">Capabilities</span>
              <div className="flex flex-wrap gap-2">
                {status.collective_capabilities.map((capability) => (
                  <Badge key={capability} variant="outline">{capability}</Badge>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-on-surface-variant">Effective overrides</span>
              <pre className="text-xs bg-surface-container p-3 rounded-lg overflow-x-auto text-on-surface-variant">
                {JSON.stringify(status.collective_settings, null, 2)}
              </pre>
            </div>
          </div>
        ) : (
          <p className="text-sm text-on-surface-variant">
            This team worker is not currently connected to a Myco Collective.
          </p>
        )}
      </Surface>
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? 'Disconnecting...' : 'Disconnect'}
        </Button>
      </div>

      <ConfirmDialog
        open={showRotateConfirm}
        onOpenChange={setShowRotateConfirm}
        title="Rotate MCP Access Token"
        description="This will invalidate the current MCP token. Any cloud agents using it will lose access until reconfigured with the new token."
        confirmLabel="Rotate Token"
        variant="destructive"
        isPending={rotating}
        onConfirm={async () => {
          setRotating(true);
          try {
            await postJson('/team/rotate-mcp-token');
            queryClient.invalidateQueries({ queryKey: ['team-status'] });
            setShowRotateConfirm(false);
          } catch {
            // Error visible via status refetch
          } finally {
            setRotating(false);
          }
        }}
      />
    </div>
  );
}

/* ---------- SyncTab ---------- */

const SECONDS_PER_MIN = 60;
const SECONDS_PER_HOUR = 3600;

function formatAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < SECONDS_PER_MIN) return `${seconds}s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_MIN)}m`;
  return `${Math.floor(seconds / SECONDS_PER_HOUR)}h`;
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return '<1s';
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return 'Never';
  return time.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatDateLabel(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return undefined;
  return time.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTableName(table: string): string {
  return table.replace(/_/g, ' ');
}

function tableDelta(local: number, remote: number | undefined): string {
  if (remote === undefined) return '—';
  const delta = remote - local;
  if (delta === 0) return '0';
  return delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();
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

function SyncStoreTable({ summary }: { summary: TeamSyncSummaryResponse }) {
  const remoteTables = summary.remote?.tables ?? {};
  const tableNames = Array.from(new Set([
    ...Object.keys(summary.local.tables),
    ...Object.keys(remoteTables),
  ])).sort();

  return (
    <div className="overflow-hidden rounded-md border border-outline-variant/10">
      <table className="w-full text-sm">
        <thead className="bg-surface-container/40 text-xs uppercase text-outline">
          <tr>
            <th className="px-3 py-2 text-left font-mono">Table</th>
            <th className="px-3 py-2 text-right font-mono">Local</th>
            <th className="px-3 py-2 text-right font-mono">Remote</th>
            <th className="px-3 py-2 text-right font-mono">Delta</th>
          </tr>
        </thead>
        <tbody>
          {tableNames.map((table) => {
            const local = summary.local.tables[table] ?? 0;
            const remote = remoteTables[table];
            return (
              <tr key={table} className="border-t border-outline-variant/10">
                <td className="px-3 py-2 text-on-surface">{formatTableName(table)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-on-surface">{formatNumber(local)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-on-surface">{formatNumber(remote)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-on-surface-variant">{tableDelta(local, remote)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DlqRow({ message, onAction, busy }: { message: DlqMessage; onAction: (action: 'retry' | 'discard', leaseId: string) => void; busy: boolean }) {
  const body = message.body as { table?: string; id?: string; machine_id?: string };
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-outline-variant/10 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-on-surface font-mono truncate">
          {body.table ?? '?'} / {body.id ?? '?'}
        </p>
        <p className="text-xs text-on-surface-variant truncate">
          machine={body.machine_id ?? '?'} attempts={message.attempts} {message.last_failure ? `· ${message.last_failure}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('retry', message.msg_id)}>Retry</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('discard', message.msg_id)}>Discard</Button>
      </div>
    </div>
  );
}

function SyncTab({ status }: { status: TeamStatusResponse }) {
  const queryClient = useQueryClient();
  const enabled = status.enabled && status.healthy;
  const { data: queueStats, isLoading: queueLoading } = useTeamQueueStats(enabled);
  const { data: syncSummary, isLoading: summaryLoading } = useTeamSyncSummary(enabled);
  const { data: daemonStats } = useDaemon();
  const dlqEnabled = enabled && Boolean(queueStats) && !isTokenMissing(queueStats);
  const { data: dlq, isLoading: dlqLoading } = useTeamDlq(dlqEnabled);
  const [busy, setBusy] = useState(false);
  const [dlqMessage, setDlqMessage] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);
  const [drainMessage, setDrainMessage] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);

  const queueUnavailable = !enabled || isTokenMissing(queueStats) || (!queueLoading && !queueStats);
  const failedSyncsLoading = queueLoading || (dlqEnabled && dlqLoading);
  const failedSyncsUnavailable = !enabled || isTokenMissing(queueStats) || isTokenMissing(dlq) || (!failedSyncsLoading && dlqEnabled && !dlq);
  const unavailableMessage = enabled ? 'Not available from this node.' : 'Team connection is unhealthy.';

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
    if (!dlq || isTokenMissing(dlq) || dlq.messages.length === 0) return;
    setBusy(true);
    setDlqMessage(null);
    try {
      const res = await postJson<{ retried?: number }>('/team/dlq/retry', { lease_ids: dlq.messages.map((m) => m.msg_id) });
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

  const handleRefreshDlq = useCallback(async () => {
    setBusy(true);
    setDlqMessage(null);
    try {
      await queryClient.refetchQueries({ queryKey: ['team-dlq'] });
    } finally {
      setBusy(false);
    }
  }, [queryClient]);

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

  const main = !isTokenMissing(queueStats) ? queueStats?.main : undefined;
  const dlqStats = !isTokenMissing(queueStats) ? queueStats?.dlq : undefined;
  const dlqMessages = !isTokenMissing(dlq) ? dlq?.messages ?? [] : [];
  const lastHandoff = syncSummary?.last_handoff ?? null;
  const remoteTotal = syncSummary?.remote?.total_records ?? null;
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
  const hasVectorIndexStatus = Boolean(
    status.vector_reindex_status
    || status.vector_reindex_last_table
    || status.vector_reindex_last_run_at
    || status.vector_reindex_last_error,
  );

  return (
    <div className="space-y-4">
      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <SectionHeader>Worker</SectionHeader>
          <Badge variant={status.worker_update_available ? 'outline' : 'default'}>
            {status.worker_update_available ? 'update available' : workerVersionKnown ? 'current' : 'deployed'}
          </Badge>
        </div>
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
          <p className="text-xs text-on-surface-variant">{upgradeMessage}</p>
        )}
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <SectionHeader>Backfill</SectionHeader>
          <Button size="sm" variant="default" onClick={handleDrain} disabled={draining}>
            {draining ? 'Backfilling...' : 'Backfill existing records'}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard
            label="Left to sync"
            value={formatNumber(syncSummary?.local.pending_sync_count ?? status.pending_sync_count)}
            accent={(syncSummary?.local.pending_sync_count ?? status.pending_sync_count) > 0 ? 'sage' : 'outline'}
            href="/logs?component=team-sync"
          />
        </div>
        {drainMessage && <p className="text-sm text-primary">{drainMessage}</p>}
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <SectionHeader>Sync status</SectionHeader>
        {summaryLoading && !syncSummary ? (
          <p className="text-xs text-on-surface-variant">Loading...</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label="Last handoff"
                value={formatTime(lastHandoff?.completed_at)}
                sublabel={formatDateLabel(lastHandoff?.completed_at)}
                accent={lastHandoff?.error ? 'terracotta' : 'outline'}
              />
              <StatCard
                label="Accepted"
                value={formatNumber(lastHandoff?.accepted)}
                accent="outline"
              />
              <StatCard
                label="Batches"
                value={formatNumber(lastHandoff?.batches)}
                accent="outline"
              />
              <StatCard
                label="Duration"
                value={formatDuration(lastHandoff?.duration_ms)}
                accent="outline"
              />
            </div>
            {lastHandoff?.error && (
              <p className="text-sm text-tertiary break-words">{lastHandoff.error}</p>
            )}
          </>
        )}
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <SectionHeader>Remote store</SectionHeader>
          {syncSummary?.remote && (
            <Badge variant="default">v{syncSummary.remote.package_version}</Badge>
          )}
        </div>
        {summaryLoading && !syncSummary ? (
          <p className="text-xs text-on-surface-variant">Loading...</p>
        ) : syncSummary?.remote_error ? (
          <p className="text-sm text-tertiary break-words">{syncSummary.remote_error}</p>
        ) : syncSummary ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Local records" value={formatNumber(localTotal)} accent="outline" />
              <StatCard label="Remote records" value={formatNumber(remoteTotal)} accent="outline" />
              <StatCard
                label="Delta"
                value={remoteTotal === null || localTotal === null ? '—' : tableDelta(localTotal, remoteTotal)}
                accent={remoteTotal !== null && localTotal !== null && remoteTotal !== localTotal ? 'ochre' : 'outline'}
              />
              <VectorsTile remote={syncSummary.remote} localEmbedded={daemonStats?.embedding.embedded_count ?? null} />
            </div>
            <SyncStoreTable summary={syncSummary} />
          </div>
        ) : (
          <p className="text-sm text-on-surface-variant">{unavailableMessage}</p>
        )}
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <SectionHeader>Queue health</SectionHeader>
        {queueLoading ? (
          <p className="text-xs text-on-surface-variant">Loading...</p>
        ) : queueUnavailable ? (
          <p className="text-sm text-on-surface-variant">{unavailableMessage}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Waiting" value={main?.depth == null ? '—' : String(main.depth)} accent="outline" />
            <StatCard label="Oldest" value={formatAge(main?.oldest_msg_age_s ?? null)} accent="outline" />
            <StatCard
              label="Failed"
              value={dlqStats?.depth == null ? String(dlqMessages.length) : String(dlqStats.depth)}
              accent={(dlqStats?.depth ?? dlqMessages.length) > 0 ? 'terracotta' : 'outline'}
            />
            <StatCard label="Oldest failed" value={formatAge(dlqStats?.oldest_msg_age_s ?? null)} accent="outline" />
          </div>
        )}
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <SectionHeader>Failed syncs</SectionHeader>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || failedSyncsUnavailable}
              onClick={handleRefreshDlq}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || failedSyncsUnavailable || dlqMessages.length === 0}
              onClick={handleReplayAll}
            >
              {dlqMessages.length > 0 ? `Retry all (${dlqMessages.length})` : 'Retry all'}
            </Button>
          </div>
        </div>
        {dlqMessage && (
          <p className="text-xs font-mono text-on-surface-variant">{dlqMessage}</p>
        )}
        {failedSyncsLoading ? (
          <p className="text-xs text-on-surface-variant">Loading...</p>
        ) : failedSyncsUnavailable ? (
          <p className="text-sm text-on-surface-variant">{unavailableMessage}</p>
        ) : dlqMessages.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No failed syncs.</p>
        ) : (
          <div className="divide-y divide-outline-variant/10">
            {dlqMessages.map((message) => (
              <DlqRow key={message.msg_id} message={message} onAction={handleDlqAction} busy={busy} />
            ))}
          </div>
        )}
      </Surface>

      {hasVectorIndexStatus && (
        <Surface level="low" ghostBorder className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <SectionHeader>Remote Vector Index</SectionHeader>
            <Badge variant={status.vector_reindex_status === 'error' ? 'destructive' : status.vector_reindex_status === 'running' ? 'outline' : 'default'}>
              {status.vector_reindex_status ?? 'ready'}
            </Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="text-xs text-on-surface-variant">Last table</span>
              <p className="text-sm text-on-surface">{status.vector_reindex_last_table ?? 'None'}</p>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-on-surface-variant">Last run</span>
              <p className="text-sm text-on-surface">
                {status.vector_reindex_last_run_at ? new Date(status.vector_reindex_last_run_at * 1000).toLocaleString() : 'Never'}
              </p>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-on-surface-variant">Processed</span>
              <p className="text-sm text-on-surface">{status.vector_reindex_last_processed ?? 0}</p>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-on-surface-variant">Updated / deleted</span>
              <p className="text-sm text-on-surface">{status.vector_reindex_last_reindexed ?? 0} / {status.vector_reindex_last_deleted ?? 0}</p>
            </div>
          </div>
          {status.vector_reindex_last_error && (
            <div className="space-y-1 border-t border-outline-variant/10 pt-3">
              <span className="text-xs text-on-surface-variant">Last error</span>
              <p className="text-xs text-tertiary break-words">{status.vector_reindex_last_error}</p>
            </div>
          )}
        </Surface>
      )}
    </div>
  );
}

/* ---------- Page wrappers ---------- */

/**
 * Onboarding fallback shown on Team Dashboard when team sync isn't
 * connected yet — install command, provision command, paste-credentials
 * form. Dashboard is the entry point for first-time setup; once
 * connected, the user normally never visits this content again.
 */
function NotConnectedView({ scopeName, onConnected }: { scopeName: string; onConnected: () => void }) {
  return (
    <div className="space-y-4">
      <Surface level="low" ghostBorder className="p-6 space-y-4">
        <SectionHeader>Getting Started</SectionHeader>
        <p className="text-sm text-on-surface-variant">
          Team sync connects a Grove to shared knowledge infrastructure through a Cloudflare Worker.
          One team member provisions the worker, then shares the connection details.
        </p>

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-on-surface mb-1">1. Install prerequisites</p>
            <code className="block font-mono text-xs bg-surface-container rounded px-3 py-2 text-on-surface-variant">
              npm install -g @goondocks/myco-team wrangler && wrangler login
            </code>
          </div>

          <div>
            <p className="text-sm font-medium text-on-surface mb-1">2. Provision the Grove worker</p>
            <code className="block font-mono text-xs bg-surface-container rounded px-3 py-2 text-on-surface-variant">
              myco-team install
            </code>
            <p className="text-xs text-on-surface-variant mt-1">
              Creates a D1 database, Vectorize index, and deploys the sync worker.
              Outputs a Worker URL and Team key for the Grove.
            </p>
          </div>

          <div>
            <p className="text-sm font-medium text-on-surface mb-1">3. Connect</p>
            <p className="text-xs text-on-surface-variant">
              Paste the Worker URL and Team key below, or if you ran <code className="font-mono">myco-team install</code>,
              you're already connected.
            </p>
          </div>
        </div>
      </Surface>

      <ConnectForm scopeName={scopeName} onConnected={onConnected} />
    </div>
  );
}

/**
 * Team Dashboard — connection state, credentials, MCP endpoint,
 * worker version. The Disconnect button lives here; this is also
 * where the not-connected onboarding flow renders.
 */
export function TeamDashboard() {
  const { data: status, isLoading } = useTeamStatus();
  const queryClient = useQueryClient();

  if (isLoading) return <PageLoading isLoading={true} error={null}><span /></PageLoading>;

  const isConnected = status?.enabled && status?.worker_url;
  const scopeName = status?.grove?.name ?? status?.project.name ?? 'this Grove';

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title="Team"
          subtitle={isConnected && status
            ? 'Connection and team credentials'
            : `Connect ${scopeName} to team sync`}
        />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-6 pb-6">
          {isConnected && status ? (
            <StatusTab status={status} />
          ) : (
            <NotConnectedView
              scopeName={scopeName}
              onConnected={() => queryClient.invalidateQueries({ queryKey: ['team-status'] })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Team Maintenance — sync metrics, queue health, DLQ retry/discard,
 * remote vector index status, backfill controls. Renamed from "Sync"
 * tab; "Sync" is implementation detail, "Maintenance" matches the
 * dashboard/settings/maintenance shape used across every section.
 */
export function TeamMaintenance() {
  const { data: status, isLoading } = useTeamStatus();
  const queryClient = useQueryClient();

  if (isLoading) return <PageLoading isLoading={true} error={null}><span /></PageLoading>;

  const isConnected = status?.enabled && status?.worker_url;
  const scopeName = status?.grove?.name ?? status?.project.name ?? 'this Grove';

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title="Team maintenance"
          subtitle={isConnected
            ? 'Backlog, queue health, and failed syncs'
            : `Connect ${scopeName} to team sync to access maintenance`}
        />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-6 pb-6">
          {isConnected && status ? (
            <SyncTab status={status} />
          ) : (
            <NotConnectedView
              scopeName={scopeName}
              onConnected={() => queryClient.invalidateQueries({ queryKey: ['team-status'] })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
