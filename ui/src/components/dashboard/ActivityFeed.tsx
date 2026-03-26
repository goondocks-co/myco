import { useNavigate } from 'react-router-dom';
import { MessageSquare, Bot, Sprout, Activity } from 'lucide-react';
import { type LucideIcon } from 'lucide-react';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { useActivity, type ActivityEvent } from '../../hooks/use-activity';
import { formatEpochAgo } from '../../lib/format';

/* ---------- Constants ---------- */

const DEFAULT_FEED_LIMIT = 20;
const FEED_MAX_HEIGHT = 'max-h-[32rem]';

/* ---------- Helpers ---------- */

function iconForType(eventType: string): LucideIcon {
  if (eventType.startsWith('session')) return MessageSquare;
  if (eventType.startsWith('agent')) return Bot;
  if (eventType.startsWith('spore')) return Sprout;
  return Activity;
}

function labelForType(eventType: string): string {
  return eventType.replace(/_/g, ' ');
}

function badgeVariant(eventType: string): 'default' | 'warning' | 'destructive' | 'secondary' {
  if (eventType.startsWith('session')) return 'default';
  if (eventType.startsWith('spore')) return 'warning';
  if (eventType.startsWith('error')) return 'destructive';
  return 'secondary';
}

/** Return the route path for a given activity event, or null if not navigable. */
function routeForEvent(event: ActivityEvent): string | null {
  if (event.type === 'session') return `/sessions/${event.id}`;
  if (event.type === 'agent_run') return '/agent';
  if (event.type === 'spore') return '/mycelium';
  return null;
}

/* ---------- Sub-components ---------- */

function EventRow({ event, onClick }: { event: ActivityEvent; onClick?: () => void }) {
  const Icon = iconForType(event.type);
  const isClickable = onClick !== undefined;

  return (
    <Surface
      level="low"
      interactive={isClickable}
      className="flex items-center gap-3 px-4 py-2.5"
      onClick={onClick}
      role={isClickable ? 'link' : undefined}
    >
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-container-high">
        <Icon className="h-3.5 w-3.5 text-on-surface-variant" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="font-sans text-sm text-on-surface truncate block">
          {event.summary}
        </span>
      </div>
      <Badge variant={badgeVariant(event.type)} className="shrink-0">
        {labelForType(event.type)}
      </Badge>
      <span className="font-mono text-xs text-on-surface-variant shrink-0">
        {formatEpochAgo(event.timestamp)}
      </span>
    </Surface>
  );
}

/* ---------- Component ---------- */

interface ActivityFeedProps {
  limit?: number;
  showHeader?: boolean;
}

export function ActivityFeed({ limit = DEFAULT_FEED_LIMIT, showHeader = true }: ActivityFeedProps) {
  const { data, isLoading } = useActivity(limit);
  const navigate = useNavigate();

  return (
    <div>
      {showHeader && (
        <h3 className="font-serif text-sm text-on-surface mb-3">Recent Activity</h3>
      )}
      {isLoading ? (
        <div className="space-y-0.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-surface-container-low" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <Surface level="low" className="px-6 py-8 text-center">
          <span className="font-sans text-sm text-on-surface-variant">No recent activity</span>
        </Surface>
      ) : (
        <div className={`${FEED_MAX_HEIGHT} overflow-y-auto space-y-0.5`}>
          {data.map((event) => {
            const route = routeForEvent(event);
            return (
              <EventRow
                key={event.id}
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
