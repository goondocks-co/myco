import { useNavigate } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import { useActivity, type ActivityEvent } from '../../hooks/use-activity';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const LOG_FEED_LIMIT = 12;
const LOG_FEED_DISPLAY = 8;

/* ---------- Helpers ---------- */

type LogLevel = 'ok' | 'warn' | 'error';

function levelForType(eventType: string): LogLevel {
  if (eventType.includes('error') || eventType.includes('fail')) return 'error';
  if (eventType === 'agent_run') return 'warn';
  return 'ok';
}

const LEVEL_TAG: Record<LogLevel, string> = {
  ok: '[OK]',
  warn: '[WRN]',
  error: '[ERR]',
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  ok: 'text-sage',
  warn: 'text-ochre',
  error: 'text-terracotta',
};

function formatLogTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function routeForEvent(event: ActivityEvent): string | null {
  if (event.type === 'session') return `/sessions/${event.id}`;
  if (event.type === 'agent_run') return '/agent';
  if (event.type === 'spore') return '/mycelium';
  return null;
}

/* ---------- Sub-components ---------- */

function LogEntry({ event, onClick }: { event: ActivityEvent; onClick?: () => void }) {
  const level = levelForType(event.type);

  return (
    <div
      className={cn(
        'flex gap-4 items-start border-b border-outline-variant/5 pb-2 font-mono text-[11px] transition-all duration-150',
        onClick && 'cursor-pointer hover:bg-surface-container-high/50 hover:translate-x-1 -mx-2 px-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
      )}
      onClick={onClick}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      } : undefined}
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? 'link' : undefined}
      aria-label={onClick ? `${event.type.replace(/_/g, ' ')}: ${event.summary}` : undefined}
    >
      <span className="text-outline shrink-0 tabular-nums">
        {formatLogTime(event.timestamp)}
      </span>
      <span className={cn('shrink-0 font-bold', LEVEL_COLOR[level])}>
        {LEVEL_TAG[level]}
      </span>
      <span className="text-on-surface/70 truncate">
        {event.summary}
      </span>
    </div>
  );
}

/* ---------- Component ---------- */

export function ActivityLogFeed() {
  const { data, isLoading } = useActivity(LOG_FEED_LIMIT);
  const navigate = useNavigate();

  const events = data?.slice(0, LOG_FEED_DISPLAY) ?? [];

  return (
    <div className="glass-panel p-6 rounded-xl border border-outline-variant/10 transition-[border-color] duration-200 hover:border-outline-variant/25">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h4 className="font-serif text-xl text-on-surface">System Integrity Logs</h4>
        <span className="text-[10px] font-mono text-sage px-2 py-1 bg-sage-muted rounded">
          LIVE
        </span>
      </div>

      {/* Log entries */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-4 items-start pb-2 animate-pulse">
              <div className="h-3 w-14 rounded bg-surface-container-high/50" />
              <div className="h-3 w-8 rounded bg-surface-container-high/50" />
              <div className="h-3 flex-1 rounded bg-surface-container-high/40" />
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <ScrollText className="h-8 w-8 text-outline/20" />
          <p className="font-sans text-xs text-on-surface-variant">No log entries yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((event) => {
            const route = routeForEvent(event);
            return (
              <LogEntry
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
