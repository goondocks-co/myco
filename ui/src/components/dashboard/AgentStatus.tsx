import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Play } from 'lucide-react';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { useDaemon } from '../../hooks/use-daemon';
import { postJson } from '../../lib/api';
import { formatEpochAgo } from '../../lib/format';

/* ---------- Helpers ---------- */

function statusVariant(status: string | null): 'default' | 'secondary' | 'destructive' {
  if (status === 'success') return 'default';
  if (status === 'error') return 'destructive';
  return 'secondary';
}

function statusLabel(status: string | null): string {
  if (!status) return 'Never run';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/* ---------- Component ---------- */

export function AgentStatus() {
  const { data: stats } = useDaemon();
  const queryClient = useQueryClient();

  const { mutate: runNow, isPending } = useMutation({
    mutationFn: () => postJson<{ status: string }>('/agent/run'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['daemon-stats'] });
    },
  });

  const agent = stats?.agent;

  return (
    <Surface level="low" className="p-4 space-y-3">
      <h3 className="font-serif text-sm text-on-surface flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary" />
        Agent
      </h3>
      {!agent ? (
        <p className="font-sans text-sm text-on-surface-variant">Loading...</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-sans text-xs text-on-surface-variant">Status</span>
            <Badge variant={isPending ? 'default' : 'secondary'}>
              {isPending ? 'Running' : 'Idle'}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-sans text-xs text-on-surface-variant">Last run</span>
            <Badge variant={statusVariant(agent.last_run_status)}>
              {statusLabel(agent.last_run_status)}
            </Badge>
          </div>
          {agent.last_run_at && (
            <div className="flex items-center justify-between">
              <span className="font-sans text-xs text-on-surface-variant">When</span>
              <span className="font-mono text-xs text-on-surface">
                {formatEpochAgo(agent.last_run_at)}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="font-sans text-xs text-on-surface-variant">Total runs</span>
            <span className="font-mono text-xs text-on-surface">{agent.total_runs}</span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="w-full gap-2"
            disabled={isPending}
            onClick={() => runNow()}
          >
            <Play className="h-3.5 w-3.5" />
            {isPending ? 'Running...' : 'Run Now'}
          </Button>
        </div>
      )}
    </Surface>
  );
}
