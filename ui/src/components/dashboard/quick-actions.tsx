import { useState, useCallback } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { type StatsResponse } from '../../hooks/use-daemon';
import { postJson } from '../../lib/api';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const ACTION_FEEDBACK_DURATION_MS = 2_000;

/* ---------- Action button hook ---------- */

type ActionState = 'idle' | 'loading' | 'success' | 'error';

function useAction(fn: () => Promise<unknown>) {
  const [state, setState] = useState<ActionState>('idle');

  const execute = useCallback(async () => {
    setState('loading');
    try {
      await fn();
      setState('success');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), ACTION_FEEDBACK_DURATION_MS);
  }, [fn]);

  return { state, execute };
}

/* ---------- Sub-components ---------- */

function ActionButton({
  label,
  icon,
  state,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  state: ActionState;
  onClick: () => void;
}) {
  const stateLabel =
    state === 'loading'
      ? 'Running...'
      : state === 'success'
        ? 'Done'
        : state === 'error'
          ? 'Failed'
          : label;

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'gap-2 transition-colors',
        state === 'success' && 'border-primary/50 text-primary',
        state === 'error' && 'border-destructive/50 text-destructive',
      )}
      disabled={state === 'loading'}
      onClick={onClick}
    >
      {state === 'loading' ? (
        <RefreshCw className="h-4 w-4 animate-spin" />
      ) : (
        icon
      )}
      {stateLabel}
    </Button>
  );
}

/* ---------- QuickActions ---------- */

export function QuickActions({ stats: _stats }: { stats: StatsResponse }) {
  const runDigest = useAction(
    useCallback(() => postJson('/digest', {}), []),
  );
  const runCuration = useAction(
    useCallback(() => postJson('/curate', { dry_run: true }), []),
  );

  return (
    <div className="flex flex-wrap gap-2">
      <ActionButton
        label="Run Digest"
        icon={<Sparkles className="h-4 w-4" />}
        state={runDigest.state}
        onClick={runDigest.execute}
      />
      <ActionButton
        label="Run Curation"
        icon={<RefreshCw className="h-4 w-4" />}
        state={runCuration.state}
        onClick={runCuration.execute}
      />
    </div>
  );
}
