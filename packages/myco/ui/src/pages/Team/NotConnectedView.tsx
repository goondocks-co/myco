import { WifiOff } from 'lucide-react';
import { Panel } from '../../components/ui/panel';
import { IconEyebrow } from '../../components/ui/icon-eyebrow';
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

/**
 * Onboarding fallback shown on Team page when team sync isn't
 * connected yet. Team sync is registry-owned: provisioning registers a Team,
 * and project membership is selected on the Teams tab.
 */
export function NotConnectedView({ scopeName }: { scopeName: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Panel
        tone="ochre"
        eyebrow={<IconEyebrow Icon={WifiOff} tone="ochre">Not syncing</IconEyebrow>}
        title={`Team sync for ${scopeName}`}
      >
        <p className="text-sm text-on-surface-variant m-0 mb-3">
          This project is not assigned to a registered team.
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
              Creates the worker and registers the team on this machine.
            </p>
          </Step>
          <Step n={3} state="idle" title="Add or join the team">
            <p className="text-xs text-on-surface-variant m-0">
              On the Teams tab, provision a new team with <code className="font-mono">myco-team install</code> — or, if a teammate shared a Worker URL and Team key, use "Join a team". Then assign this project to it.
            </p>
          </Step>
        </ol>
      </Panel>
    </div>
  );
}
