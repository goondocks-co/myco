import { useState } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { postJson } from '../../lib/api';
import { Surface } from '../../components/ui/surface';
import { SectionHeader } from '../../components/ui/section-header';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

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

/**
 * Onboarding fallback shown on Team page when team sync isn't
 * connected yet — install command, provision command, paste-credentials
 * form. This is the entry point for first-time setup; once
 * connected, the user normally never visits this content again.
 */
export function NotConnectedView({ scopeName }: { scopeName: string }) {
  const queryClient = useQueryClient();
  const onConnected = () => queryClient.invalidateQueries({ queryKey: ['team-status'] });

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
