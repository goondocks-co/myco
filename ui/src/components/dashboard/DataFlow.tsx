import { useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { type StatsResponse } from '../../hooks/use-daemon';

/* ---------- Types ---------- */

type NodeStatus = 'green' | 'amber' | 'gray';

interface FlowNode {
  label: string;
  count: string;
  status: NodeStatus;
  route: string;
}

/* ---------- Helpers ---------- */

function statusColor(status: NodeStatus): string {
  switch (status) {
    case 'green':
      return 'bg-emerald-500/20 border-emerald-500/40 text-emerald-600 dark:text-emerald-400';
    case 'amber':
      return 'bg-amber-500/20 border-amber-500/40 text-amber-600 dark:text-amber-400';
    case 'gray':
      return 'bg-muted border-border text-muted-foreground';
  }
}

function statusDot(status: NodeStatus): string {
  switch (status) {
    case 'green':
      return 'bg-emerald-500';
    case 'amber':
      return 'bg-amber-500';
    case 'gray':
      return 'bg-muted-foreground/40';
  }
}

function buildNodes(stats: StatsResponse): FlowNode[] {
  const agentStatus: NodeStatus =
    stats.agent.last_run_status === 'success'
      ? 'green'
      : stats.agent.last_run_status === 'error'
        ? 'amber'
        : 'gray';

  return [
    {
      label: 'Sessions',
      count: String(stats.vault.session_count),
      status: stats.daemon.active_sessions.length > 0 ? 'green' : 'gray',
      route: '/sessions',
    },
    {
      label: 'Batches',
      count: String(stats.vault.batch_count),
      status: stats.unprocessed_batches > 0 ? 'amber' : 'green',
      route: '/sessions',
    },
    {
      label: 'Embedding',
      count: `${stats.embedding.embedded_count}/${stats.embedding.total_embeddable}`,
      status: stats.embedding.queue_depth > 0 ? 'amber' : 'green',
      route: '/settings',
    },
    {
      label: 'Agent',
      count: `${stats.agent.total_runs} runs`,
      status: agentStatus,
      route: '/agent',
    },
    {
      label: 'Mycelium',
      count: String(stats.vault.spore_count),
      status: stats.vault.spore_count > 0 ? 'green' : 'gray',
      route: '/mycelium',
    },
    {
      label: 'Digest',
      count: `${stats.digest.tiers_available.length} tiers`,
      status: stats.digest.tiers_available.length > 0 ? 'green' : 'gray',
      route: '/mycelium',
    },
  ];
}

/* ---------- Sub-components ---------- */

function FlowArrow() {
  return (
    <div className="flex items-center text-border shrink-0">
      <div className="h-px w-4 bg-border" />
      <svg className="h-3 w-3 text-muted-foreground/60" viewBox="0 0 12 12" fill="currentColor">
        <path d="M4 2l5 4-5 4V2z" />
      </svg>
    </div>
  );
}

function FlowNodeCard({
  node,
  onClick,
}: {
  node: FlowNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-lg border px-4 py-3 text-center transition-opacity hover:opacity-80 cursor-pointer shrink-0',
        statusColor(node.status),
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('h-2 w-2 rounded-full shrink-0', statusDot(node.status))} />
        <span className="text-xs font-semibold">{node.label}</span>
      </div>
      <span className="font-mono text-sm font-bold">{node.count}</span>
    </button>
  );
}

/* ---------- Component ---------- */

export function DataFlow({ stats }: { stats: StatsResponse }) {
  const navigate = useNavigate();
  const nodes = buildNodes(stats);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Data Flow
      </h2>
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {nodes.map((node, i) => (
          <div key={node.label} className="flex items-center">
            <FlowNodeCard node={node} onClick={() => navigate(node.route)} />
            {i < nodes.length - 1 && <FlowArrow />}
          </div>
        ))}
      </div>
    </div>
  );
}
