import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useRunEvents } from '../../hooks/use-agent';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { cn } from '../../lib/cn';
import { formatEpochRelative } from '../../lib/format';
import type { RunEventRow } from '../../hooks/use-agent';

/* ---------- Props ---------- */

export interface EventsPanelProps {
  runId: string;
  runStatus?: string;
  className?: string;
}

/* ---------- Helpers ---------- */

/** Payload is truncated at render time so a pathological tool result never lands whole in the DOM. */
const PAYLOAD_PREVIEW_CHARS = 2_048;

function eventTypeBadgeVariant(eventType: string): 'default' | 'warning' | 'destructive' | 'secondary' | 'outline' {
  switch (eventType) {
    case 'phase_start':
    case 'phase_end':
      return 'secondary';
    case 'pre_tool_use':
    case 'post_tool_use':
      return 'default';
    default:
      // Unrecognized event_type values (the column is open TEXT) still render — just with a neutral variant.
      return 'outline';
  }
}

function outcomeBadgeVariant(outcome: string | null): 'default' | 'warning' | 'destructive' | 'secondary' {
  if (outcome === 'error') return 'destructive';
  if (outcome === 'success') return 'default';
  return 'secondary';
}

/** Pretty-print the payload for display, truncated so a large tool result never lands whole in the DOM. */
function formatPayloadPreview(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  if (text.length <= PAYLOAD_PREVIEW_CHARS) return text;
  return `${text.slice(0, PAYLOAD_PREVIEW_CHARS)}\n… (truncated)`;
}

/* ---------- Event row ---------- */

function EventItem({ event }: { event: RunEventRow }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = event.payload !== null && event.payload !== undefined;

  return (
    <div
      role={hasPayload ? 'button' : undefined}
      tabIndex={hasPayload ? 0 : undefined}
      className={cn(
        'px-4 py-2.5 border-b border-outline-variant/10 last:border-b-0 transition-colors',
        hasPayload && 'hover:bg-surface-container-high/30 cursor-pointer',
      )}
      onClick={hasPayload ? () => setExpanded(!expanded) : undefined}
      onKeyDown={hasPayload ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded(!expanded);
        }
      } : undefined}
      aria-expanded={hasPayload ? expanded : undefined}
    >
      <div className="flex items-start gap-3">
        <span className="font-mono text-xs text-on-surface-variant shrink-0 pt-0.5 min-w-[100px]">
          {formatEpochRelative(event.recorded_at)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {hasPayload && (
              expanded
                ? <ChevronDown className="h-3 w-3 shrink-0 text-on-surface-variant" />
                : <ChevronRight className="h-3 w-3 shrink-0 text-on-surface-variant" />
            )}
            <Badge variant={eventTypeBadgeVariant(event.event_type)} className="font-mono">
              {event.event_type}
            </Badge>
            {event.phase_name && (
              <span className="font-sans text-xs text-on-surface-variant">{event.phase_name}</span>
            )}
            {event.tool_name && (
              <span className="font-mono text-xs font-medium text-on-surface">{event.tool_name}</span>
            )}
            {event.outcome && (
              <Badge variant={outcomeBadgeVariant(event.outcome)}>{event.outcome}</Badge>
            )}
            {event.duration_ms !== null && (
              <span className="font-mono text-xs text-on-surface-variant">{event.duration_ms}ms</span>
            )}
          </div>

          {expanded && hasPayload && (
            <pre className="mt-1.5 rounded-md bg-surface-container-lowest p-2.5 font-mono text-xs whitespace-pre-wrap overflow-x-auto max-h-48 text-on-surface-variant">
              {formatPayloadPreview(event.payload)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- EventsPanel ---------- */

/**
 * Harness lifecycle event stream for a run — pre/post tool-use and
 * phase-start/phase-end rows in recorded order. Pre/post pairing is purely
 * visual: rows render in insertion order, with no attempt to nest or
 * correlate matching pairs. Runs captured before the event stream shipped
 * (pre-#611) have no rows here; that renders as a quiet empty state rather
 * than an error.
 */
export function EventsPanel({ runId, runStatus, className }: EventsPanelProps) {
  const { events, isPending, isError } = useRunEvents(runId, runStatus);

  if (isPending) {
    return (
      <div className={cn('flex items-center gap-2 text-on-surface-variant py-4', className)}>
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="font-sans text-sm">Loading events...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <Surface level="low" className={cn('flex h-20 items-center justify-center', className)}>
        <span className="font-sans text-sm text-tertiary">Failed to load events</span>
      </Surface>
    );
  }

  if (events.length === 0) {
    return (
      <div className={cn('space-y-3', className)}>
        <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant">
          Events
        </p>
        <Surface level="low" className="flex h-20 items-center justify-center">
          <span className="font-sans text-sm text-on-surface-variant italic">
            No lifecycle events recorded for this run.
          </span>
        </Surface>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <p className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant">
        Events
        <span className="ml-2 text-on-surface normal-case font-normal">
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </span>
      </p>
      <Surface level="low" className="overflow-hidden">
        {events.map((event) => (
          <EventItem key={event.id} event={event} />
        ))}
      </Surface>
    </div>
  );
}
