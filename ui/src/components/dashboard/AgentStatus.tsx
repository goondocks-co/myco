import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Play } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bot className="h-4 w-4 text-primary" />
          Agent
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!agent ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={isPending ? 'default' : 'secondary'} className="text-xs">
                {isPending ? 'Running' : 'Idle'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last run</span>
              <Badge variant={statusVariant(agent.last_run_status)} className="text-xs">
                {statusLabel(agent.last_run_status)}
              </Badge>
            </div>
            {agent.last_run_at && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">When</span>
                <span className="font-mono text-foreground">
                  {formatEpochAgo(agent.last_run_at)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total runs</span>
              <span className="font-mono text-foreground">{agent.total_runs}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2"
              disabled={isPending}
              onClick={() => runNow()}
            >
              <Play className="h-3.5 w-3.5" />
              {isPending ? 'Running...' : 'Run Now'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
