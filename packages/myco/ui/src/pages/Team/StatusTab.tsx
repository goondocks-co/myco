import { useState } from 'react';
import { Copy, Key, Cloud, Terminal, Network, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { type TeamStatusResponse } from '../../hooks/use-team';
import { postJson } from '../../lib/api';
import { Panel } from '../../components/ui/panel';
import { IconEyebrow } from '../../components/ui/icon-eyebrow';
import { Eyebrow } from '../../components/ui/eyebrow';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { CopyableField } from '../../components/team/CopyableField';
import { RedactedField } from '../../components/team/RedactedField';

export function StatusTab({ status }: { status: TeamStatusResponse }) {
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);
  const [showMcpSnippet, setShowMcpSnippet] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await postJson('/team/disconnect');
      queryClient.invalidateQueries({ queryKey: ['team-status'] });
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 1. Team credentials */}
      <Panel
        tone="sage"
        eyebrow={<IconEyebrow Icon={Key}>Team Credentials</IconEyebrow>}
        title="Add a team member's machine"
        actions={
          <Button variant="ghost" size="sm" disabled title="Coming soon">
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Rotate team key
          </Button>
        }
      >
        <p className="text-xs text-on-surface-variant m-0 mb-3">
          Share the Worker URL and Team key with a teammate. They use them to connect their machine to the{' '}
          <span className="text-on-surface font-medium">{status.grove?.name ?? 'this'}</span> Grove and start syncing.
          Keep the Team key private — anyone who has it can write to this Grove.
        </p>
        <div className="flex flex-col gap-3">
          {status.worker_url && <CopyableField label="Worker URL" value={status.worker_url} />}
          {status.team_key && <RedactedField label="Team key" value={status.team_key} />}
        </div>
      </Panel>

      {/* 2. Cloud MCP endpoint */}
      {status.mcp_token && status.mcp_endpoint && (
        <Panel
          tone="sage"
          eyebrow={<IconEyebrow Icon={Cloud}>Cloud MCP endpoint</IconEyebrow>}
          title="For cloud agents"
          actions={
            <>
              <Badge variant={status.mcp_healthy ? 'default' : 'destructive'}>
                {status.mcp_healthy ? 'healthy' : 'unhealthy'}
              </Badge>
              <button
                onClick={() => setShowRotateConfirm(true)}
                className="text-xs text-on-surface-variant hover:text-terracotta-text transition-colors inline-flex items-center gap-1"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Rotate token
              </button>
            </>
          }
        >
          <p className="text-xs text-on-surface-variant m-0 mb-3">
            Configure cloud agents with this endpoint to access Grove team intelligence.
          </p>
          <div className="flex flex-col gap-3">
            <CopyableField label="MCP URL" value={status.mcp_endpoint} />
            <RedactedField label="MCP Access Token" value={status.mcp_token} />
          </div>

          <div className="text-xs mt-3">
            <button
              type="button"
              onClick={() => setShowMcpSnippet(!showMcpSnippet)}
              className="myco-eyebrow-sm text-on-surface-variant cursor-pointer hover:text-on-surface transition-colors"
            >
              {showMcpSnippet ? 'Hide snippet' : 'Config snippet'}
            </button>
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
                <div className="relative mt-2">
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
          </div>
        </Panel>
      )}

      {/* 3. This node */}
      <Panel
        tone="sage"
        eyebrow={<IconEyebrow Icon={Terminal}>This node</IconEyebrow>}
        title="Identity of this machine in the team"
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Eyebrow size="sm">Machine ID</Eyebrow>
            <code className="text-xs font-mono text-on-surface break-all">{status.machine_id}</code>
          </div>
          <div className="flex flex-col gap-1">
            <Eyebrow size="sm">Package version</Eyebrow>
            <code className="text-xs font-mono text-on-surface break-all">{status.package_version}</code>
          </div>
          <div className="flex flex-col gap-1">
            <Eyebrow size="sm">Protocol version</Eyebrow>
            <code className="text-xs font-mono text-on-surface">v{status.sync_protocol_version}</code>
          </div>
          <div className="flex flex-col gap-1">
            <Eyebrow size="sm">Schema version</Eyebrow>
            <code className="text-xs font-mono text-on-surface">v{status.schema_version}</code>
          </div>
        </div>
        {status.health_error && (
          <p className="text-sm text-terracotta m-0 mt-3">{status.health_error}</p>
        )}
      </Panel>

      {/* 4. Collective */}
      <Panel
        tone="sage"
        eyebrow={<IconEyebrow Icon={Network}>Collective</IconEyebrow>}
        title="Cross-team coordination"
        actions={
          <Badge variant={status.collective_connected ? 'default' : 'outline'}>
            {status.collective_connected ? 'connected' : 'not connected'}
          </Badge>
        }
      >
        {status.collective_connected ? (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {status.collective_url && (
                <div className="flex flex-col gap-1">
                  <Eyebrow size="sm">URL</Eyebrow>
                  <code className="text-xs font-mono text-on-surface break-all">{status.collective_url}</code>
                </div>
              )}
              {status.collective_project_id && (
                <div className="flex flex-col gap-1">
                  <Eyebrow size="sm">Project ID</Eyebrow>
                  <code className="text-xs font-mono text-on-surface break-all">{status.collective_project_id}</code>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <Eyebrow size="sm">Last settings sync</Eyebrow>
                <p className="text-xs font-mono text-on-surface m-0">
                  {status.collective_last_settings_sync ? new Date(status.collective_last_settings_sync * 1000).toLocaleString() : 'Never'}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Eyebrow size="sm">Last heartbeat</Eyebrow>
                <p className="text-xs font-mono text-on-surface m-0">
                  {status.collective_last_heartbeat ? new Date(status.collective_last_heartbeat * 1000).toLocaleString() : 'Never'}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Eyebrow size="sm">Capabilities</Eyebrow>
              <div className="flex flex-wrap gap-2">
                {status.collective_capabilities.map((capability) => (
                  <Badge key={capability} variant="outline">{capability}</Badge>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Eyebrow size="sm">Effective overrides</Eyebrow>
              <pre className="text-xs bg-surface-container p-3 rounded-lg overflow-x-auto text-on-surface-variant">
                {JSON.stringify(status.collective_settings, null, 2)}
              </pre>
            </div>
          </div>
        ) : (
          <p className="text-sm text-on-surface-variant m-0">
            This team worker is not currently connected to a Myco Collective.
          </p>
        )}
      </Panel>

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
          setRotateError(null);
          try {
            await postJson('/team/rotate-mcp-token');
            queryClient.invalidateQueries({ queryKey: ['team-status'] });
            setShowRotateConfirm(false);
          } catch (err) {
            setRotateError(err instanceof Error ? err.message : String(err));
          } finally {
            setRotating(false);
          }
        }}
        errorMessage={rotateError}
      />
      {disconnectError && (
        <p className="text-sm text-terracotta text-right m-0" data-testid="team-disconnect-error">
          Disconnect failed: {disconnectError}
        </p>
      )}
    </div>
  );
}
