import { useNavigate } from 'react-router-dom';
import { MessageSquare, Bot, Sprout, Activity } from 'lucide-react';
import { type LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useActivity, type ActivityEvent } from '../../hooks/use-activity';
import { formatEpochAgo } from '../../lib/format';

/* ---------- Constants ---------- */

const ACTIVITY_FEED_LIMIT = 20;
const FEED_MAX_HEIGHT = 'max-h-96';

/* ---------- Helpers ---------- */

function iconForType(eventType: string): LucideIcon {
  if (eventType.startsWith('session')) return MessageSquare;
  if (eventType.startsWith('agent') || eventType.startsWith('curator')) return Bot;
  if (eventType.startsWith('spore')) return Sprout;
  return Activity;
}

function labelForType(eventType: string): string {
  return eventType.replace(/_/g, ' ');
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
    <div
      className={`flex items-start gap-3 py-2.5 border-b border-border last:border-0 ${isClickable ? 'cursor-pointer hover:bg-accent/50 transition-colors rounded-md px-1 -mx-1' : ''}`}
      onClick={onClick}
      role={isClickable ? 'link' : undefined}
    >
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm text-foreground">{event.summary}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatEpochAgo(event.timestamp)}
          </span>
        </div>
        <span className="text-xs text-muted-foreground/70">{labelForType(event.type)}</span>
      </div>
    </div>
  );
}

/* ---------- Component ---------- */

export function ActivityFeed() {
  const { data, isLoading } = useActivity(ACTIVITY_FEED_LIMIT);
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-primary" />
          Recent Activity
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="px-6 py-4 text-sm text-muted-foreground">Loading...</div>
        ) : !data || data.length === 0 ? (
          <div className="px-6 py-4 text-sm text-muted-foreground">No recent activity</div>
        ) : (
          <div className={`${FEED_MAX_HEIGHT} overflow-y-auto px-6`}>
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
      </CardContent>
    </Card>
  );
}
