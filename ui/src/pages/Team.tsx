import { useState, useCallback } from 'react';
import { Users, Wifi, WifiOff, RefreshCw, Copy, Check, Eye, EyeOff } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTeamStatus, type TeamStatusResponse } from '../hooks/use-team';
import { postJson } from '../lib/api';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { StatCard } from '../components/ui/stat-card';

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
          className="flex-shrink-0 p-1 rounded text-on-surface-variant hover:text-on-surface opacity-0 group-hover:opacity-100 transition-opacity"
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
          className="flex-shrink-0 p-1 rounded text-on-surface-variant hover:text-on-surface transition-opacity"
          title={visible ? 'Hide' : 'Reveal'}
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="flex-shrink-0 p-1 rounded text-on-surface-variant hover:text-on-surface opacity-0 group-hover:opacity-100 transition-opacity"
          title="Copy to clipboard"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
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

function ConnectedStatus({ status }: { status: TeamStatusResponse }) {
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

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

  return (
    <div className="space-y-4">
      {/* Status overview */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Status"
          value={status.healthy ? 'Connected' : 'Unhealthy'}
          icon={status.healthy ? Wifi : WifiOff}
        />
        <StatCard
          label="Pending sync"
          value={status.pending_sync_count}
        />
        <StatCard
          label="Protocol"
          value={`v${status.sync_protocol_version}`}
        />
        <StatCard
          label="Schema"
          value={`v${status.schema_version}`}
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
          {status.api_key && (
            <RedactedField label="API Key" value={status.api_key} />
          )}
        </div>
      </Surface>

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
    </div>
  );
}

/* ---------- Page ---------- */

export default function Team() {
  const { data: status, isLoading } = useTeamStatus();
  const queryClient = useQueryClient();

  if (isLoading) return <PageLoading />;

  const isConnected = status?.enabled && status?.worker_url;

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Team"
        subtitle="Share knowledge across machines with team sync"
      />

      {isConnected && status ? (
        <ConnectedStatus status={status} />
      ) : (
        <div className="space-y-4">
          {/* Setup guide */}
          <Surface level="low" ghostBorder className="p-6 space-y-4">
            <SectionHeader>Getting Started</SectionHeader>
            <p className="text-sm text-on-surface-variant">
              Team sync lets multiple machines share captured knowledge through a Cloudflare Worker.
              One team member provisions the infrastructure, then shares the connection details.
            </p>

            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-on-surface mb-1">1. Install Wrangler</p>
                <code className="block font-mono text-xs bg-surface-container rounded px-3 py-2 text-on-surface-variant">
                  npm install -g wrangler && wrangler login
                </code>
              </div>

              <div>
                <p className="text-sm font-medium text-on-surface mb-1">2. Provision the team</p>
                <code className="block font-mono text-xs bg-surface-container rounded px-3 py-2 text-on-surface-variant">
                  myco team init
                </code>
                <p className="text-xs text-on-surface-variant mt-1">
                  Creates a D1 database, Vectorize index, and deploys the sync worker.
                  Outputs a Worker URL and API key to share with teammates.
                </p>
              </div>

              <div>
                <p className="text-sm font-medium text-on-surface mb-1">3. Connect</p>
                <p className="text-xs text-on-surface-variant">
                  Paste the Worker URL and API key below, or if you ran <code className="font-mono">myco team init</code>,
                  you're already connected.
                </p>
              </div>
            </div>
          </Surface>

          {/* Connect form */}
          <ConnectForm onConnected={() => queryClient.invalidateQueries({ queryKey: ['team-status'] })} />
        </div>
      )}
    </div>
  );
}
