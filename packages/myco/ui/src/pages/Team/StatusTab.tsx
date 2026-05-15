import { useState } from 'react';
import { Copy, Key, Cloud, Terminal, Network, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { type TeamStatusResponse } from '../../hooks/use-team';
import { postJson } from '../../lib/api';
import { Surface } from '../../components/ui/surface';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { CopyableField } from '../../components/team/CopyableField';
import { RedactedField } from '../../components/team/RedactedField';

const eyebrowClass = 'text-[10px] uppercase tracking-wider text-on-surface-variant';

function PanelHeader({
  icon,
  eyebrow,
  title,
  action,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-on-surface-variant">{icon}</div>
        <div className="space-y-0.5">
          <div className={eyebrowClass}>{eyebrow}</div>
          <h3 className="text-sm font-medium text-on-surface">{title}</h3>
        </div>
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

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
      {/* 1. Grove credentials */}
      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <PanelHeader
          icon={<Key className="h-4 w-4" />}
          eyebrow="Grove Credentials"
          title="Share these to add a machine"
          action={
            <Button
              variant="ghost"
              size="sm"
              disabled
              title="Coming soon"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              Rotate team key
            </Button>
          }
        />
        <p className="text-xs text-on-surface-variant">
          Use these to add a machine to this Grove team. The Team key is sensitive — share only with people who should write to this Grove.
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

      {/* 2. Cloud MCP endpoint */}
      {status.mcp_token && status.mcp_endpoint && (
        <Surface level="low" ghostBorder className="p-5 space-y-3">
          <PanelHeader
            icon={<Cloud className="h-4 w-4" />}
            eyebrow="Cloud MCP endpoint"
            title="For cloud agents"
            action={
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
          />
          <p className="text-xs text-on-surface-variant">
            Configure cloud agents with this endpoint to access Grove team intelligence.
          </p>
          <div className="space-y-3">
            <CopyableField label="MCP URL" value={status.mcp_endpoint} />
            <RedactedField label="MCP Access Token" value={status.mcp_token} />
          </div>

          <details className="text-xs">
            <summary
              onClick={(e) => {
                // Preserve the existing showMcpSnippet state for parity, even
                // though <details> manages its own open state. Toggling here
                // keeps the snippet copy button mounted whenever open.
                e.preventDefault();
                setShowMcpSnippet(!showMcpSnippet);
              }}
              className={`${eyebrowClass} cursor-pointer hover:text-on-surface transition-colors list-none`}
            >
              {showMcpSnippet ? 'Hide snippet' : 'Config snippet'}
            </summary>
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
          </details>
        </Surface>
      )}

      {/* 3. This node */}
      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <PanelHeader
          icon={<Terminal className="h-4 w-4" />}
          eyebrow="This node"
          title="Identity of this machine in the team"
        />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="space-y-1">
            <div className={eyebrowClass}>Machine ID</div>
            <code className="text-xs font-mono text-on-surface break-all">{status.machine_id}</code>
          </div>
          <div className="space-y-1">
            <div className={eyebrowClass}>Package version</div>
            <code className="text-xs font-mono text-on-surface break-all">{status.package_version}</code>
          </div>
          <div className="space-y-1">
            <div className={eyebrowClass}>Protocol version</div>
            <code className="text-xs font-mono text-on-surface">v{status.sync_protocol_version}</code>
          </div>
          <div className="space-y-1">
            <div className={eyebrowClass}>Schema version</div>
            <code className="text-xs font-mono text-on-surface">v{status.schema_version}</code>
          </div>
        </div>

        {status.health_error && (
          <p className="text-sm text-tertiary">
            {status.health_error}
          </p>
        )}
      </Surface>

      {/* 4. Collective */}
      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <PanelHeader
          icon={<Network className="h-4 w-4" />}
          eyebrow="Collective"
          title="Cross-team coordination"
          action={
            <Badge variant={status.collective_connected ? 'default' : 'outline'}>
              {status.collective_connected ? 'connected' : 'not connected'}
            </Badge>
          }
        />
        {status.collective_connected ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {status.collective_url && (
                <div className="space-y-1">
                  <div className={eyebrowClass}>URL</div>
                  <code className="text-xs font-mono text-on-surface break-all">{status.collective_url}</code>
                </div>
              )}
              {status.collective_project_id && (
                <div className="space-y-1">
                  <div className={eyebrowClass}>Project ID</div>
                  <code className="text-xs font-mono text-on-surface break-all">{status.collective_project_id}</code>
                </div>
              )}
              <div className="space-y-1">
                <div className={eyebrowClass}>Last settings sync</div>
                <p className="text-xs font-mono text-on-surface">
                  {status.collective_last_settings_sync ? new Date(status.collective_last_settings_sync * 1000).toLocaleString() : 'Never'}
                </p>
              </div>
              <div className="space-y-1">
                <div className={eyebrowClass}>Last heartbeat</div>
                <p className="text-xs font-mono text-on-surface">
                  {status.collective_last_heartbeat ? new Date(status.collective_last_heartbeat * 1000).toLocaleString() : 'Never'}
                </p>
              </div>
            </div>
            <div className="space-y-1">
              <div className={eyebrowClass}>Capabilities</div>
              <div className="flex flex-wrap gap-2">
                {status.collective_capabilities.map((capability) => (
                  <Badge key={capability} variant="outline">{capability}</Badge>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <div className={eyebrowClass}>Effective overrides</div>
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
