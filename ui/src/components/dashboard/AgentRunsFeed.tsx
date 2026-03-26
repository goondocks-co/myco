import { useNavigate } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { useAgentRuns, useAgentTasks, type RunRow } from '../../hooks/use-agent';
import { formatEpochAgo, formatDuration } from '../../lib/format';
import { cn } from '../../lib/cn';
import { resolveTaskName } from '../agent/helpers';

/* ---------- Constants ---------- */

/** Number of runs to display in the dashboard feed. */
const FEED_LIMIT = 5;

/** Status-to-dot-color mapping for run status indicators. */
const STATUS_DOT: Record<string, string> = {
  running: 'bg-sage animate-pulse',
  completed: 'bg-sage',
  failed: 'bg-terracotta',
  skipped: 'bg-outline/40',
  pending: 'bg-outline/40',
};

/* ---------- Sub-components ---------- */

function RunCard({
  run,
  taskName,
  onClick,
}: {
  run: RunRow;
  taskName: string;
  onClick: () => void;
}) {
  const dotClass = STATUS_DOT[run.status] ?? STATUS_DOT.pending;

  return (
    <div
      className="flex items-center justify-between gap-3 py-2.5 border-b border-outline-variant/5 last:border-0 cursor-pointer hover:bg-surface-container-high/50 -mx-2 px-2 rounded transition-colors"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      role="link"
      tabIndex={0}
      aria-label={`View run: ${taskName}`}
    >
      {/* Left: status dot + task name */}
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass)} />
        <span className="text-sm text-on-surface truncate">{taskName}</span>
      </div>

      {/* Right: relative time + duration */}
      <div className="flex items-center gap-3 shrink-0 font-mono text-[11px] text-outline">
        <span>{run.started_at !== null ? formatEpochAgo(run.started_at) : '\u2014'}</span>
        <span>{formatDuration(run.started_at, run.completed_at)}</span>
      </div>
    </div>
  );
}

/* ---------- Component ---------- */

export function AgentRunsFeed() {
  const { data, isLoading } = useAgentRuns({ limit: FEED_LIMIT });
  const { data: tasksData } = useAgentTasks();
  const navigate = useNavigate();

  const tasks = tasksData?.tasks ?? [];
  const runs = data?.runs ?? [];

  return (
    <div className="glass-panel p-6 rounded-xl border border-outline-variant/10">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h4 className="font-serif text-xl text-on-surface">Agent Runs</h4>
        <Bot className="h-5 w-5 text-outline" />
      </div>

      {/* Run list */}
      {isLoading ? (
        <div className="font-mono text-[11px] text-outline py-4">Loading runs...</div>
      ) : runs.length === 0 ? (
        <div className="font-mono text-[11px] text-outline py-4">No agent runs yet</div>
      ) : (
        <div>
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              taskName={resolveTaskName(run.task, tasks)}
              onClick={() => navigate('/agent')}
            />
          ))}
        </div>
      )}
    </div>
  );
}
