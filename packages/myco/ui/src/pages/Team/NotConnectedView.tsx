import { useState } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { postJson } from '../../lib/api';
import { Panel } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { StepCircle } from '../../components/ui/step-circle';
import { cn } from '../../lib/cn';

type StepState = 'idle' | 'active' | 'complete';

function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li
      aria-current={state === 'active' ? 'step' : undefined}
      className={cn(
        'flex gap-3 rounded-md border border-[var(--ghost-border)] px-4 py-3 transition-colors',
        state === 'active' && 'bg-sage/[0.05] border-l-2 border-l-sage',
        state === 'complete' && 'opacity-70',
      )}
    >
      <StepCircle
        number={n}
        className={cn(
          state === 'active' && 'bg-sage/15 text-sage',
          state === 'complete' && 'bg-sage text-on-sage',
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <h4 className="text-sm font-medium text-on-surface m-0">{title}</h4>
        {children}
      </div>
    </li>
  );
}

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
    <Panel
      tone="sage"
      eyebrow={
        <span className="inline-flex items-center gap-1.5">
          <WifiOff className="h-3 w-3" />
          Connect Grove
        </span>
      }
      title="Paste credentials"
    >
      <p className="text-sm text-on-surface-variant m-0 mb-3">
        Provision {scopeName} with <code className="font-mono">myco-team install</code> first
        (<code className="font-mono">myco-team-dev install</code> in dev), then enter the Worker URL and Team key.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
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
        {error && <p className="text-sm text-terracotta m-0">{error}</p>}
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
    </Panel>
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
    <div className="flex flex-col gap-4">
      <Panel
        tone="ochre"
        eyebrow="Getting started"
        title="Connect this Grove to a team worker"
      >
        <p className="text-sm text-on-surface-variant m-0 mb-3">
          Team sync connects a Grove to shared knowledge infrastructure through a Cloudflare Worker.
          One team member provisions the worker, then shares the connection details.
        </p>
        <ol className="m-0 p-0 list-none flex flex-col gap-3">
          <Step n={1} state="active" title="Install prerequisites">
            <code className="block font-mono text-xs bg-surface-container rounded px-3 py-2 text-on-surface-variant">
              npm install -g @goondocks/myco-team wrangler && wrangler login
            </code>
          </Step>
          <Step n={2} state="idle" title="Provision the Grove worker">
            <code className="block font-mono text-xs bg-surface-container rounded px-3 py-2 text-on-surface-variant">
              myco-team install
            </code>
            <p className="text-xs text-on-surface-variant m-0 mt-1">
              Creates a D1 database, Vectorize index, and deploys the sync worker.
              Outputs a Worker URL and Team key for the Grove.
            </p>
          </Step>
          <Step n={3} state="idle" title="Connect">
            <p className="text-xs text-on-surface-variant m-0">
              Paste the Worker URL and Team key below, or if you ran <code className="font-mono">myco-team install</code>,
              you're already connected.
            </p>
          </Step>
        </ol>
      </Panel>

      <ConnectForm scopeName={scopeName} onConnected={onConnected} />
    </div>
  );
}
