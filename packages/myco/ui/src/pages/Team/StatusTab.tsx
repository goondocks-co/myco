import { useState } from 'react';
import { Copy } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { type TeamStatusResponse } from '../../hooks/use-team';
import { postJson } from '../../lib/api';
import { Surface } from '../../components/ui/surface';
import { SectionHeader } from '../../components/ui/section-header';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { StatCard } from '../../components/ui/stat-card';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { CopyableField } from '../../components/team/CopyableField';
import { RedactedField } from '../../components/team/RedactedField';

export function StatusTab({ status }: { status: TeamStatusResponse }) {
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
