import { type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { ActionLink, tapTarget, focusRing, TypeChip } from '../../design';
import { cn } from '../../lib/cn';

/** What an item's node on the line marks: something live, Myco's learning, a failure, or anything else. */
export type TimelineTone = 'live' | 'learn' | 'bad' | 'plain';

const NODE: Record<TimelineTone, string> = {
  live: 'before:border-ok before:bg-ok',
  learn: 'before:border-primary before:bg-bg',
  bad: 'before:border-bad before:bg-bg',
  plain: 'before:border-faint before:bg-bg',
};

export interface TimelineItemProps {
  /** The time column: "now", or the time of day. */
  time: string;
  /** The instant the time column names, for the machine-readable `<time>`. */
  at: number;
  tone: TimelineTone;
  /** The line above the title: project, agent, machine and size, or Myco's outcome. */
  kicker: ReactNode;
  /** The headline; left out for an item whose kicker says it all. */
  title?: ReactNode;
  /** One line of summary. */
  summary?: ReactNode;
  /** Nested lines: the spores a run wrote, the sessions it titled, a failure note. */
  children?: ReactNode;
}

/** One moment of the day on the timeline: its time, a node on the line, and what happened. */
export function TimelineItem({ time, at, tone, kicker, title, summary, children }: TimelineItemProps) {
  return (
    <li className="grid grid-timeline gap-s2 sm:grid-timeline-wide sm:gap-s3" data-timeline-item={tone}>
      <time dateTime={new Date(at).toISOString()} className="pt-s4 text-right t-small tabular-nums text-faint">{time}</time>
      <div
        className={cn(
          'relative flex min-w-0 flex-col border-l border-line-strong pb-s4 pl-s4 pt-s4 sm:pl-s5',
          'before:absolute before:-left-s1 before:top-s5 before:size-s2 before:rounded-pill before:border-2 before:content-[""]',
          NODE[tone],
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-s2 gap-y-s1 t-small text-muted">{kicker}</div>
        {title != null && <div className="mt-s1 t-body font-medium text-ink">{title}</div>}
        {summary != null && <p className="line-clamp-1 hidden t-small text-muted sm:block">{summary}</p>}
        {children}
      </div>
    </li>
  );
}

/** The project an item belongs to, as the kicker leads with it. */
export function KickerProject({ children }: { children: ReactNode }) {
  return <span className="font-medium text-ink-2">{children}</span>;
}

/** The dot between the kicker's parts. */
export function KickerSep() {
  return <span aria-hidden>·</span>;
}

/**
 * A headline that opens its record: ink, underlined on hover, never the link
 * colour. `inline` keeps it in a run of text, so a long headline wraps as a
 * sentence; either way it is a fingertip tall on a touch-sized screen.
 */
export function TitleLink({ to, children, className, inline = false }: { to: string; children: ReactNode; className?: string; inline?: boolean }) {
  return (
    <RouterLink to={to} className={cn(inline ? 'tap-inline' : tapTarget, 'rounded-chip hover:underline hover:decoration-line-strong hover:underline-offset-3', focusRing, className)}>
      {children}
    </RouterLink>
  );
}

export interface NestedLine {
  key: string;
  /** A chip before the line, such as the spore's type. */
  chip?: string;
  text: string;
  to?: string;
}

/** The lines an item carries under it, the first `shown`, then "and N more" for the rest `total` counts. */
export function NestedLines({ lines, total, label }: { lines: readonly NestedLine[]; total: number; label: string }) {
  const more = Math.max(0, total - lines.length);
  if (lines.length === 0 && more === 0) return null;
  return (
    <ul aria-label={label} className="mt-s2 flex flex-col gap-s2">
      {lines.map((line) => (
        <li key={line.key} className="flex min-w-0 items-baseline gap-s3 t-small text-ink-2">
          {line.chip !== undefined && <TypeChip>{line.chip}</TypeChip>}
          {line.to === undefined
            ? <span className="line-clamp-2 min-w-0 sm:line-clamp-1">{line.text}</span>
            : <TitleLink to={line.to} className="min-w-0"><span className="line-clamp-2 sm:line-clamp-1">{line.text}</span></TitleLink>}
        </li>
      ))}
      {more > 0 && <li className="t-small text-muted">and {more.toLocaleString()} more</li>}
    </ul>
  );
}

/** A failure written beside its outcome: the cause, what to do, and where to look. */
export function FailureNote({ tone, cause, next, action }: { tone: 'bad' | 'quiet'; cause: string; next: string; action?: { to: string; label: string } }) {
  return (
    <div className={cn('mt-s2 flex max-w-measure flex-col gap-s1 rounded-control border px-s3 py-s2 t-small', tone === 'bad' ? 'border-line bg-bad-bg text-ink-2' : 'border-line bg-surface-2 text-ink-2')}>
      <p><span className={cn('font-medium', tone === 'bad' ? 'text-bad' : 'text-ink')}>{tone === 'bad' ? 'Why: ' : 'Stopped early: '}</span>{cause}</p>
      <p>{next}</p>
      {action !== undefined && (
        <ActionLink to={action.to}>{action.label} →</ActionLink>
      )}
    </div>
  );
}
