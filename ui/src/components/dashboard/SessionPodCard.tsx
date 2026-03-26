import { useNavigate } from 'react-router-dom';
import { type ActivityEvent } from '../../hooks/use-activity';
import { formatEpochAgo } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const SESSION_ID_DISPLAY_LEN = 6;

/* ---------- Types ---------- */

type PodVariant = 'sage' | 'ochre' | 'terracotta';

/* ---------- Helpers ---------- */

function variantForType(eventType: string): PodVariant {
  if (eventType === 'agent_run') return 'ochre';
  if (eventType === 'spore') return 'sage';
  if (eventType.includes('error') || eventType.includes('fail')) return 'terracotta';
  if (eventType === 'session') return 'sage';
  return 'sage';
}

function statusForVariant(variant: PodVariant): { label: string; dotClass: string } {
  switch (variant) {
    case 'sage':
      return { label: 'STABLE', dotClass: 'bg-sage shadow-sage-glow' };
    case 'ochre':
      return { label: 'ACTIVE', dotClass: 'bg-ochre shadow-ochre-glow' };
    case 'terracotta':
      return { label: 'WARNING', dotClass: 'bg-terracotta shadow-terracotta-glow' };
  }
}

const BORDER_CLASSES: Record<PodVariant, string> = {
  sage: 'border-l-sage',
  ochre: 'border-l-ochre',
  terracotta: 'border-l-terracotta',
};

const ID_COLOR_CLASSES: Record<PodVariant, string> = {
  sage: 'text-sage',
  ochre: 'text-ochre',
  terracotta: 'text-terracotta',
};

const BADGE_COLOR_CLASSES: Record<PodVariant, string> = {
  sage: 'text-sage',
  ochre: 'text-ochre',
  terracotta: 'text-terracotta',
};

const RING_CLASSES: Record<PodVariant, string> = {
  sage: 'border-sage/20',
  ochre: 'border-ochre/20',
  terracotta: 'border-terracotta/20',
};

function shortId(id: string): string {
  return `#${id.slice(-SESSION_ID_DISPLAY_LEN).toUpperCase()}`;
}

function titleForEvent(event: ActivityEvent): string {
  /* Use summary as the title — it already contains the meaningful label */
  return event.summary;
}

/* ---------- Component ---------- */

export function SessionPodCard({ event }: { event: ActivityEvent }) {
  const navigate = useNavigate();
  const variant = variantForType(event.type);
  const status = statusForVariant(variant);
  const timeAgo = formatEpochAgo(event.timestamp);

  const route =
    event.type === 'session'
      ? `/sessions/${event.id}`
      : event.type === 'agent_run'
        ? '/agent'
        : event.type === 'spore'
          ? '/mycelium'
          : null;

  return (
    <div
      className={cn(
        'p-5 rounded-lg border-l-4 bg-surface-container/60 hover:bg-surface-container-high group hover-lift transition-colors',
        route && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        BORDER_CLASSES[variant],
      )}
      onClick={() => route && navigate(route)}
      onKeyDown={(e) => {
        if (route && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          navigate(route);
        }
      }}
      tabIndex={route ? 0 : undefined}
      role={route ? 'link' : undefined}
      aria-label={`${titleForEvent(event)} - ${status.label} - ${timeAgo}`}
    >
      {/* Header: ID + Status dot */}
      <div className="flex justify-between items-start mb-3">
        <div className="min-w-0">
          <p className={cn('font-mono text-xs font-bold', ID_COLOR_CLASSES[variant])}>
            {shortId(event.id)}
          </p>
          <h4 className="font-serif text-lg text-on-surface leading-tight mt-0.5 truncate">
            {titleForEvent(event)}
          </h4>
        </div>
        <div className={cn('w-8 h-8 rounded-full border-2 flex items-center justify-center shrink-0 ml-3', RING_CLASSES[variant])}>
          <div className={cn('w-3.5 h-3.5 rounded-full', status.dotClass)} />
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-on-surface/60 line-clamp-2 leading-relaxed italic mb-3">
        &gt; {event.type.replace(/_/g, ' ')} event recorded {timeAgo}
      </p>

      {/* Status badges */}
      <div className="flex gap-2">
        <span
          className={cn(
            'px-2 py-0.5 bg-surface-container-highest text-[10px] font-mono rounded',
            BADGE_COLOR_CLASSES[variant],
          )}
        >
          {status.label}
        </span>
        <span className="px-2 py-0.5 bg-surface-container-highest text-[10px] font-mono text-outline rounded">
          {timeAgo}
        </span>
      </div>
    </div>
  );
}
