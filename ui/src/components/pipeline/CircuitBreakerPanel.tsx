import { useState } from 'react';
import {
  Loader2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import { fetchJson, postJson } from '../../lib/api';
import { usePowerQuery } from '../../hooks/use-power-query';
import { POLL_INTERVALS } from '../../lib/constants';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const PROVIDER_LABELS: Record<string, string> = {
  extraction: 'LLM (Extraction)',
  embedding: 'Embedding',
  consolidation: 'LLM (Consolidation)',
  digest: 'LLM (Digest)',
};

const STATE_ICON: Record<string, typeof ShieldCheck> = {
  closed: ShieldCheck,
  open: ShieldAlert,
  'half-open': ShieldQuestion,
};

const STATE_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  closed: 'default',
  open: 'destructive',
  'half-open': 'outline',
};

const STATE_BADGE_CLASS: Record<string, string> = {
  closed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  open: '',
  'half-open': 'border-amber-400/50 text-amber-600 dark:text-amber-400',
};

const STATE_CARD_BORDER: Record<string, string> = {
  closed: 'border-border',
  open: 'border-red-500/40',
  'half-open': 'border-amber-400/40',
};

/* ---------- Types ---------- */

interface CircuitState {
  provider_role: string;
  state: 'closed' | 'open' | 'half-open';
  failure_count: number;
  last_failure: string | null;
  last_error: string | null;
  opens_at: string | null;
  updated_at: string;
}

/* ---------- Helpers ---------- */

function formatCooldownRemaining(opensAt: string | null): string | null {
  if (!opensAt) return null;
  const remaining = new Date(opensAt).getTime() - Date.now();
  if (remaining <= 0) return null;
  const seconds = Math.ceil(remaining / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

function suggestedAction(circuit: CircuitState): string | null {
  if (circuit.state === 'closed') return null;
  if (!circuit.last_error) {
    return circuit.state === 'open'
      ? 'Circuit is open. Reset to resume processing.'
      : 'Circuit is testing. Next request will determine state.';
  }

  const errorLower = circuit.last_error.toLowerCase();
  if (errorLower.includes('timeout') || errorLower.includes('timed out')) {
    return 'Provider may be overloaded. Check model server responsiveness before resetting.';
  }
  if (errorLower.includes('connection') || errorLower.includes('econnrefused')) {
    return 'Provider unreachable. Verify the server is running and the URL is correct.';
  }
  if (errorLower.includes('401') || errorLower.includes('403') || errorLower.includes('auth')) {
    return 'Authentication failure. Check your API key or credentials.';
  }
  if (errorLower.includes('rate') || errorLower.includes('429')) {
    return 'Rate limited. Wait for cooldown or switch to a different provider.';
  }
  return circuit.state === 'open'
    ? 'Review the error and reset when ready to retry.'
    : 'Half-open: next request will probe the provider.';
}

/* ---------- Circuit Card ---------- */

function CircuitCard({
  circuit,
  onReset,
}: {
  circuit: CircuitState;
  onReset: () => void;
}) {
  const [resetting, setResetting] = useState(false);
  const StateIcon = STATE_ICON[circuit.state] ?? ShieldCheck;
  const badgeVariant = STATE_BADGE_VARIANT[circuit.state] ?? 'secondary';
  const badgeClass = STATE_BADGE_CLASS[circuit.state] ?? '';
  const cardBorder = STATE_CARD_BORDER[circuit.state] ?? 'border-border';
  const cooldown = circuit.state === 'open' ? formatCooldownRemaining(circuit.opens_at) : null;
  const suggestion = suggestedAction(circuit);

  const handleReset = async () => {
    setResetting(true);
    try {
      await postJson(`/pipeline/circuit/${encodeURIComponent(circuit.provider_role)}/reset`, {});
      onReset();
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className={cn('rounded-lg border p-4 transition-colors', cardBorder)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <StateIcon
            className={cn(
              'h-5 w-5 shrink-0',
              circuit.state === 'closed' && 'text-emerald-500',
              circuit.state === 'open' && 'text-red-500',
              circuit.state === 'half-open' && 'text-amber-500',
            )}
          />
          <div>
            <span className="text-sm font-medium">
              {PROVIDER_LABELS[circuit.provider_role] ?? circuit.provider_role}
            </span>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge
                variant={badgeVariant}
                className={cn('text-[10px] px-1.5 py-0', badgeClass)}
              >
                {circuit.state}
              </Badge>
              {circuit.failure_count > 0 && (
                <span className="text-xs font-mono text-muted-foreground">
                  {circuit.failure_count} failure{circuit.failure_count !== 1 ? 's' : ''}
                </span>
              )}
              {cooldown && (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  cooldown: {cooldown}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Reset button — only for open/half-open */}
        {circuit.state !== 'closed' && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 h-7 gap-1.5 text-xs"
            disabled={resetting}
            onClick={handleReset}
          >
            {resetting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            Reset
          </Button>
        )}
      </div>

      {/* Last error */}
      {circuit.last_error && (
        <p className="mt-2 text-xs text-destructive/80 break-words">
          {circuit.last_error}
        </p>
      )}

      {/* Suggested action */}
      {suggestion && (
        <p className="mt-1.5 text-xs text-muted-foreground italic">
          {suggestion}
        </p>
      )}
    </div>
  );
}

/* ---------- Main Component ---------- */

export function CircuitBreakerPanel() {
  const { data: circuits, isLoading, isError, refetch } = usePowerQuery<CircuitState[]>({
    queryKey: ['pipeline-circuits'],
    queryFn: ({ signal }) => fetchJson<CircuitState[]>('/pipeline/circuits', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading circuit breakers...
      </div>
    );
  }

  if (isError || !circuits) {
    return (
      <div className="py-4 text-sm text-muted-foreground">
        Circuit breaker data unavailable
      </div>
    );
  }

  if (circuits.length === 0) {
    return (
      <div className="py-4 text-sm text-muted-foreground">
        No circuit breakers registered yet. They appear after the first pipeline tick.
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {circuits.map((c) => (
        <CircuitCard key={c.provider_role} circuit={c} onReset={() => refetch()} />
      ))}
    </div>
  );
}
