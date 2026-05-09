import { useNavigate } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { useActivity, type ActivityEvent } from '../../hooks/use-activity';
import { formatEpochAgo } from '../../lib/format';
import { cn } from '../../lib/cn';
import { useProjectPathBuilder } from '../../hooks/use-project-selection';

const FEED_LIMIT = 24;
const FEED_DISPLAY = 16;

const TYPE_LABEL: Record<string, string> = {
  session: 'Session',
  agent_run: 'Agent run',
  spore: 'Spore',
  plan: 'Plan',
};

const TYPE_DOT: Record<string, string> = {
  session: 'bg-sage',
  agent_run: 'bg-primary',
  spore: 'bg-ochre',
  plan: 'bg-terracotta',
};

function routeForEvent(
  event: ActivityEvent,
  projectPath: (suffix?: string) => string,
): string | null {
  if (event.type === 'session') return projectPath(`/sessions/${event.id}`);
  if (event.type === 'agent_run') return projectPath('/agent');
  if (event.type === 'spore') return projectPath(`/mycelium?tab=spores&spore=${event.id}`);
  if (event.type === 'plan') return projectPath('/sessions');
  return null;
}

function ActivityRow({ event, onClick }: { event: ActivityEvent; onClick?: () => void }) {
  const label = TYPE_LABEL[event.type] ?? event.type.replace(/_/g, ' ');
  const dotClass = TYPE_DOT[event.type] ?? 'bg-on-surface-variant/30';

  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b border-outline-variant/5 py-2 text-sm transition-colors',
        onClick
          && 'cursor-pointer hover:bg-surface-container-high/50 -mx-2 px-2 rounded focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
      )}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? 'link' : undefined}
      aria-label={onClick ? `${label}: ${event.summary}` : undefined}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)} />
      <span className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-wider text-outline">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-on-surface/85">{event.summary}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-on-surface-variant">
        {formatEpochAgo(event.timestamp)}
      </span>
    </div>
  );
}

export function RecentActivity() {
  const { data, isLoading } = useActivity(FEED_LIMIT);
  const navigate = useNavigate();
  const projectPath = useProjectPathBuilder();

  const events = data?.slice(0, FEED_DISPLAY) ?? [];

  return (
    <div className="glass-panel rounded-xl border border-outline-variant/10 p-6 transition-[border-color] duration-200 hover:border-outline-variant/25">
      <div className="mb-4 flex items-center justify-between">
        <h4 className="font-serif text-xl text-on-surface">Recent Activity</h4>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3 py-2 animate-pulse">
              <div className="h-1.5 w-1.5 rounded-full bg-surface-container-high/50" />
              <div className="h-3 w-20 rounded bg-surface-container-high/50" />
              <div className="h-3 flex-1 rounded bg-surface-container-high/40" />
              <div className="h-3 w-12 rounded bg-surface-container-high/50" />
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8">
          <Activity className="h-8 w-8 text-outline/20" />
          <p className="font-sans text-xs text-on-surface-variant">No activity yet</p>
        </div>
      ) : (
        <div>
          {events.map((event) => {
            const route = routeForEvent(event, projectPath);
            return (
              <ActivityRow
                key={`${event.type}-${event.id}`}
                event={event}
                onClick={route ? () => navigate(route) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
