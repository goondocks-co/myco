import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { WifiOff, RefreshCw, Copy, Check, Eye, EyeOff, ArrowUpCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useTeamStatus,
  useTeamQueueStats,
  useTeamDlq,
  isTokenMissing,
  type TeamStatusResponse,
  type DlqMessage,
} from '../hooks/use-team';
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
import type { Tab } from '../components/ui/tab-switcher';

/* ---------- Tabs ---------- */

type ActiveTab = 'status' | 'outbox' | 'synced';

const TEAM_TABS: Tab[] = [
  { id: 'status', label: 'Status' },
  { id: 'outbox', label: 'Outbox' },
  { id: 'synced', label: 'Synced data' },
];

const TAB_SUBTITLES: Record<ActiveTab, string> = {
  status: 'Connection, MCP endpoint, and team credentials',
  outbox: 'Local hand-off, Cloudflare queue depth, and dead-letter replay',
  synced: 'Per-table sync coverage and what stays local',
};

const VALID_TABS = new Set<ActiveTab>(['status', 'outbox', 'synced']);
const PARAM_TAB = 'tab';

function readTabFromUrl(): ActiveTab {
  const raw = new URLSearchParams(window.location.search).get(PARAM_TAB);
  return raw && VALID_TABS.has(raw as ActiveTab) ? (raw as ActiveTab) : 'status';
}

function writeTabToUrl(tab: ActiveTab): void {
  const params = new URLSearchParams();
  if (tab !== 'status') params.set(PARAM_TAB, tab);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, '', url);
}

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

function StoredSecretField({ label }: { label: string }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-on-surface-variant">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm text-on-surface font-mono">Configured</span>
        <span className="text-xs text-on-surface-variant">stored locally, not displayed</span>
      </div>
    </div>
  );
}

/* ---------- Sub-components ---------- */

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await postJson('/team/connect', { url, api_key: apiKey });
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
        <SectionHeader>Connect to team</SectionHeader>
      </div>
      <p className="text-sm text-on-surface-variant mb-4">
        Enter the URL and API key for your team's Cloudflare Worker to enable cross-machine knowledge sharing.
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
          <label className="block text-xs font-medium text-on-surface-variant mb-1">API Key</label>
          <Input
            type="password"
            placeholder="your-api-key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="text-sm text-tertiary">{error}</p>
        )}
        <Button type="submit" size="sm" disabled={loading || !url || !apiKey}>
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
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
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

  const handleSyncAll = useCallback(async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await postJson<{ enqueued: number }>('/team/backfill');
      setSyncMessage(
        res.enqueued > 0
          ? `Enqueued ${res.enqueued} records for sync. They'll push on the next flush cycle.`
          : 'All records are already synced or enqueued.',
      );
      queryClient.invalidateQueries({ queryKey: ['team-status'] });
    } catch {
      setSyncMessage('Backfill failed.');
    } finally {
      setSyncing(false);
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
      // Surface the "@goondocks/myco-team not installed" case with a direct
      // install instruction instead of the generic error toast. The daemon
      // returns a typed error code when it can't locate the package under
      // the npm global prefix.
      if (err instanceof ApiError && typeof err.body === 'object' && err.body !== null && 'error' in err.body
          && (err.body as { error: unknown }).error === 'myco_team_not_installed') {
        const message = 'message' in err.body ? String((err.body as { message: unknown }).message) : null;
        setUpgradeMessage(message ?? 'Install @goondocks/myco-team to enable Worker upgrades: npm install -g @goondocks/myco-team');
      } else {
        setUpgradeMessage(err instanceof Error ? err.message : 'Upgrade failed');
      }
    } finally {
      setUpgrading(false);
    }
  }, [queryClient]);

  return (
    <div className="space-y-4">
      {/* Worker update banner */}
      {status.worker_update_available && (
        <Surface level="low" ghostBorder className="p-4 border-l-2 border-l-ochre">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <ArrowUpCircle className="h-5 w-5 text-ochre shrink-0" />
              <div>
                <p className="text-sm font-medium text-on-surface">Worker update available</p>
                <p className="text-xs text-on-surface-variant">
                  Deployed: v{status.deployed_worker_version ?? '?'} — Local team package: v{status.local_team_package_version ?? '?'}
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
                'Update Worker'
              )}
            </Button>
          </div>
          {upgradeMessage && (
            <p className="text-xs text-on-surface-variant mt-2">{upgradeMessage}</p>
          )}
        </Surface>
      )}

      {/* Status overview — sync queue counters live on the Outbox tab. */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="Status"
          value={status.healthy ? 'Connected' : 'Unhealthy'}
          accent={status.healthy ? 'sage' : 'terracotta'}
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

      {/* Share with teammates */}
      <Surface level="low" ghostBorder className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <SectionHeader>Team Credentials</SectionHeader>
          <Badge variant={status.healthy ? 'default' : 'destructive'}>
            {status.healthy ? 'healthy' : 'unhealthy'}
          </Badge>
        </div>
        <p className="text-xs text-on-surface-variant">
          Share these with teammates so they can connect from the Team page.
        </p>

        <div className="space-y-3">
          {status.worker_url && (
            <CopyableField label="Worker URL" value={status.worker_url} />
          )}
          {status.has_api_key && (
            <StoredSecretField label="API Key" />
          )}
        </div>
      </Surface>

      {/* Cloud MCP Endpoint */}
      {status.mcp_token && status.mcp_endpoint && (
        <Surface level="low" ghostBorder className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <SectionHeader>Cloud MCP Endpoint</SectionHeader>
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
            Configure cloud agents with this endpoint to access project team intelligence.
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

      {/* Connection details */}
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

      {/* Collective status */}
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

      {/* Sync actions */}
      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <SectionHeader>Sync</SectionHeader>
          <Button
            variant="default"
            size="sm"
            onClick={handleSyncAll}
            disabled={syncing}
          >
            {syncing ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1.5" />
                Syncing...
              </>
            ) : (
              'Sync All'
            )}
          </Button>
        </div>
        <p className="text-xs text-on-surface-variant">
          Push all unsynced local knowledge to the team store. Records sync automatically on new writes,
          but historical data needs a one-time backfill.
        </p>
        {syncMessage && (
          <p className="text-sm text-primary">{syncMessage}</p>
        )}
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <SectionHeader>Remote Vector Index</SectionHeader>
          <Badge variant={status.vector_reindex_status === 'error' ? 'destructive' : status.vector_reindex_status === 'running' ? 'outline' : 'default'}>
            {status.vector_reindex_status ?? 'unknown'}
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

      {/* Disconnect */}
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

/* ---------- OutboxTab ---------- */

const SECONDS_PER_MIN = 60;
const SECONDS_PER_HOUR = 3600;

function formatAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < SECONDS_PER_MIN) return `${seconds}s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_MIN)}m`;
  return `${Math.floor(seconds / SECONDS_PER_HOUR)}h`;
}

function CfApiTokenForm({ onConfigured }: { onConfigured: () => void }) {
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await postJson('/team/cf-api-token', { token: token.trim(), account_id: accountId.trim() });
      setToken('');
      setAccountId('');
      onConfigured();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to configure token');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Surface level="low" ghostBorder className="p-5 space-y-3 border-l-2 border-l-ochre">
      <SectionHeader>Configure Cloudflare API token</SectionHeader>
      <p className="text-xs text-on-surface-variant">
        Queue depth + DLQ inspection require a Cloudflare API token with <code className="font-mono">queues:read</code> and <code className="font-mono">queues:write</code> scope. The token is stored in the worker's KV namespace and never sent back to the daemon.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs text-on-surface-variant">Account ID</label>
          <Input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="abcdef0123456789..." />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-on-surface-variant">API token</label>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste token" />
        </div>
        {error && <p className="text-sm text-tertiary">{error}</p>}
        <Button type="submit" size="sm" disabled={submitting || !token.trim() || !accountId.trim()}>
          {submitting ? 'Saving…' : 'Save token'}
        </Button>
      </form>
    </Surface>
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

function OutboxTab({ status }: { status: TeamStatusResponse }) {
  const queryClient = useQueryClient();
  const enabled = status.enabled && status.healthy;
  const { data: queueStats, isLoading: queueLoading } = useTeamQueueStats(enabled);
  const { data: dlq, isLoading: dlqLoading } = useTeamDlq(enabled);
  const [busy, setBusy] = useState(false);
  const [draining, setDraining] = useState(false);
  const [drainMessage, setDrainMessage] = useState<string | null>(null);

  const tokenMissing = isTokenMissing(queueStats) || isTokenMissing(dlq);

  const handleDrain = useCallback(async () => {
    setDraining(true);
    setDrainMessage(null);
    try {
      const res = await postJson<{ enqueued: number }>('/team/backfill');
      setDrainMessage(res.enqueued > 0 ? `Backfilled ${res.enqueued} unsynced records.` : 'Nothing to backfill.');
      queryClient.invalidateQueries({ queryKey: ['team-status'] });
    } catch {
      setDrainMessage('Backfill failed.');
    } finally {
      setDraining(false);
    }
  }, [queryClient]);

  const handleDlqAction = useCallback(async (action: 'retry' | 'discard', leaseId: string) => {
    setBusy(true);
    try {
      await postJson(`/team/dlq/${action}`, { lease_ids: [leaseId] });
      queryClient.invalidateQueries({ queryKey: ['team-dlq'] });
      queryClient.invalidateQueries({ queryKey: ['team-queue-stats'] });
    } finally {
      setBusy(false);
    }
  }, [queryClient]);

  const handleReplayAll = useCallback(async () => {
    if (!dlq || isTokenMissing(dlq) || dlq.messages.length === 0) return;
    setBusy(true);
    try {
      await postJson('/team/dlq/retry', { lease_ids: dlq.messages.map((m) => m.msg_id) });
      queryClient.invalidateQueries({ queryKey: ['team-dlq'] });
      queryClient.invalidateQueries({ queryKey: ['team-queue-stats'] });
    } finally {
      setBusy(false);
    }
  }, [dlq, queryClient]);

  const main = !isTokenMissing(queueStats) ? queueStats?.main : undefined;
  const dlqStats = !isTokenMissing(queueStats) ? queueStats?.dlq : undefined;
  const dlqMessages = !isTokenMissing(dlq) ? dlq?.messages ?? [] : [];

  return (
    <div className="space-y-4">
      {/* Local hand-off */}
      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <SectionHeader>Local hand-off</SectionHeader>
          <Button size="sm" variant="default" onClick={handleDrain} disabled={draining}>
            {draining ? 'Backfilling…' : 'Backfill now'}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard
            label="Pending sync"
            value={String(status.pending_sync_count)}
            accent={status.pending_sync_count > 0 ? 'sage' : 'outline'}
            href="/logs?component=team-sync"
          />
        </div>
        <p className="text-xs text-on-surface-variant">
          Records waiting to hand off to the team worker. Once accepted, Cloudflare Queues owns delivery, retries, and dead-lettering.
        </p>
        {drainMessage && <p className="text-sm text-primary">{drainMessage}</p>}
      </Surface>

      {/* Cloudflare-side: queue stats + DLQ */}
      {tokenMissing ? (
        <CfApiTokenForm onConfigured={() => {
          queryClient.invalidateQueries({ queryKey: ['team-queue-stats'] });
          queryClient.invalidateQueries({ queryKey: ['team-dlq'] });
        }} />
      ) : (
        <>
          <Surface level="low" ghostBorder className="p-5 space-y-3">
            <SectionHeader>Cloudflare queue</SectionHeader>
            {queueLoading ? (
              <p className="text-xs text-on-surface-variant">Loading…</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Main depth" value={main?.depth == null ? '—' : String(main.depth)} accent="outline" />
                <StatCard label="Main oldest" value={formatAge(main?.oldest_msg_age_s ?? null)} accent="outline" />
                <StatCard
                  label="DLQ depth"
                  value={dlqStats?.depth == null ? String(dlqMessages.length) : String(dlqStats.depth)}
                  accent={(dlqStats?.depth ?? dlqMessages.length) > 0 ? 'terracotta' : 'outline'}
                />
                <StatCard label="DLQ oldest" value={formatAge(dlqStats?.oldest_msg_age_s ?? null)} accent="outline" />
              </div>
            )}
            <p className="text-xs text-on-surface-variant">
              Live depth + age require a CF API token with the queues GraphQL Analytics scope. The DLQ list below uses the documented HTTP pull-consumer API and is reliable today.
            </p>
          </Surface>

          <Surface level="low" ghostBorder className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <SectionHeader>Dead letter</SectionHeader>
              {dlqMessages.length > 0 && (
                <Button size="sm" variant="outline" disabled={busy} onClick={handleReplayAll}>
                  Replay all ({dlqMessages.length})
                </Button>
              )}
            </div>
            {dlqLoading ? (
              <p className="text-xs text-on-surface-variant">Loading…</p>
            ) : dlqMessages.length === 0 ? (
              <p className="text-sm text-on-surface-variant">No messages in the dead-letter queue.</p>
            ) : (
              <div className="divide-y divide-outline-variant/10">
                {dlqMessages.map((message) => (
                  <DlqRow key={message.msg_id} message={message} onAction={handleDlqAction} busy={busy} />
                ))}
              </div>
            )}
          </Surface>
        </>
      )}
    </div>
  );
}

/* ---------- SyncedTab ---------- */

function SyncedTab({ status }: { status: TeamStatusResponse }) {
  const disclosures = status.local_only_disclosures ?? [];
  return (
    <div className="space-y-4">
      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <SectionHeader>Per-table sync</SectionHeader>
        <p className="text-xs text-on-surface-variant">
          A per-table progress view (synced / total per table) will land here once the daemon exposes the summary endpoint. Today the Status tab's pending-sync counter is the single number to watch — local rows enqueue immediately on write, so a healthy steady-state shows a small pending count and a moving sync-protocol version.
        </p>
        <div className="text-xs text-on-surface-variant grid gap-1 sm:grid-cols-2">
          <div>Sync protocol: <span className="text-on-surface font-mono">v{status.sync_protocol_version}</span></div>
          <div>Schema: <span className="text-on-surface font-mono">v{status.schema_version}</span></div>
          <div>Worker: <span className="text-on-surface font-mono">{status.deployed_worker_version ?? '—'}</span></div>
          <div>Machine ID: <span className="text-on-surface font-mono break-all">{status.machine_id}</span></div>
        </div>
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <SectionHeader>What stays local</SectionHeader>
        <p className="text-xs text-on-surface-variant">
          These tables and columns are intentionally excluded from team sync. Read this if you're surprised that something doesn't appear on a teammate's machine.
        </p>
        <div className="space-y-3">
          {disclosures.map((d) => (
            <div key={d.table} className="space-y-1">
              <div className="flex items-center gap-2">
                <code className="text-sm text-on-surface font-mono">{d.table}</code>
                <span className="text-xs text-on-surface-variant">({d.columns.length === 1 ? d.columns[0] : `${d.columns.length} columns`})</span>
              </div>
              <p className="text-xs text-on-surface-variant">{d.rationale}</p>
              {d.columns.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {d.columns.map((c) => (
                    <Badge key={c} variant="outline" className="font-mono text-xs">{c}</Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Surface>

      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <SectionHeader>Recent activity</SectionHeader>
        <p className="text-xs text-on-surface-variant">
          A live feed of recent sync events lives in <Link to="/logs?component=team-sync" className="underline hover:text-on-surface">team-sync logs</Link> for now. Per-record activity attribution will land here in a follow-up.
        </p>
      </Surface>
    </div>
  );
}

/* ---------- Page ---------- */

export default function Team() {
  const { data: status, isLoading } = useTeamStatus();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<ActiveTab>(readTabFromUrl);

  const handleTabChange = useCallback((tabId: string) => {
    const tab = tabId as ActiveTab;
    setActiveTab(tab);
    writeTabToUrl(tab);
  }, []);

  if (isLoading) return <PageLoading isLoading={true} error={null}><span /></PageLoading>;

  const isConnected = status?.enabled && status?.worker_url;

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title="Team"
          subtitle={isConnected && status ? TAB_SUBTITLES[activeTab] : 'Share knowledge across machines with team sync'}
          tabs={isConnected ? TEAM_TABS : undefined}
          activeTab={isConnected ? activeTab : undefined}
          onTabChange={isConnected ? handleTabChange : undefined}
        />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-6 pb-6">
          {isConnected && status ? (
            <>
              {activeTab === 'status' && <StatusTab status={status} />}
              {activeTab === 'outbox' && <OutboxTab status={status} />}
              {activeTab === 'synced' && <SyncedTab status={status} />}
            </>
          ) : (
            <div className="space-y-4">
              <Surface level="low" ghostBorder className="p-6 space-y-4">
                <SectionHeader>Getting Started</SectionHeader>
                <p className="text-sm text-on-surface-variant">
                  Team sync lets multiple machines share captured knowledge through a Cloudflare Worker.
                  One team member provisions the infrastructure, then shares the connection details.
                </p>

                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-on-surface mb-1">1. Install prerequisites</p>
                    <code className="block font-mono text-xs bg-surface-container rounded px-3 py-2 text-on-surface-variant">
                      npm install -g @goondocks/myco-team wrangler && wrangler login
                    </code>
                  </div>

                  <div>
                    <p className="text-sm font-medium text-on-surface mb-1">2. Provision the team</p>
                    <code className="block font-mono text-xs bg-surface-container rounded px-3 py-2 text-on-surface-variant">
                      myco-team install
                    </code>
                    <p className="text-xs text-on-surface-variant mt-1">
                      Creates a D1 database, Vectorize index, and deploys the sync worker.
                      Outputs a Worker URL and API key to share with teammates.
                    </p>
                  </div>

                  <div>
                    <p className="text-sm font-medium text-on-surface mb-1">3. Connect</p>
                    <p className="text-xs text-on-surface-variant">
                      Paste the Worker URL and API key below, or if you ran <code className="font-mono">myco-team install</code>,
                      you're already connected.
                    </p>
                  </div>
                </div>
              </Surface>

              <ConnectForm onConnected={() => queryClient.invalidateQueries({ queryKey: ['team-status'] })} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
