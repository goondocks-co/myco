import { forwardRef, type ReactNode, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { focusRing, selectedRow } from '../lib/classes';

export interface ListRowProps {
  /** A short label above the title naming what kind of row it is, such as a TypeChip. */
  kicker?: ReactNode;
  /** The headline: a title or a spore's one line, never an id. */
  title: ReactNode;
  /** The second line: a summary, or the kicker of project, agent, machine and size. */
  meta?: ReactNode;
  /** Something before the text, such as a HealthDot or an Avatar. */
  leading?: ReactNode;
  /** Something at the far end, such as a time or a StatusChip. */
  trailing?: ReactNode;
  /** Makes the whole row a link to this path. */
  to?: string;
  /** The row the keyboard cursor sits on. */
  cursor?: boolean;
  /** The row whose detail is open. */
  selected?: boolean;
  /** The tight row height, for dense lists. */
  tight?: boolean;
  /** The title and secondary line wrap instead of truncating, for rows whose words are the content. */
  wrap?: boolean;
  className?: string;
}

/** A two-line row whose whole area is the target: the headline, then the secondary line, with an optional kicker above the headline. */
export const ListRow = forwardRef<HTMLAnchorElement | HTMLDivElement, ListRowProps>(
  ({ kicker, title, meta, leading, trailing, to, cursor = false, selected = false, tight = false, wrap = false, className }, ref) => {
    const body = (
      <>
        {leading != null && <span className="flex shrink-0 items-center">{leading}</span>}
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          {kicker != null && <span className="flex min-w-0 items-center gap-s2">{kicker}</span>}
          <span className={cn(wrap ? 'break-words' : 'truncate', 't-body font-medium text-ink')}>{title}</span>
          {meta != null && <span className={cn(wrap ? 'break-words' : 'truncate', 't-small text-muted')}>{meta}</span>}
        </span>
        {trailing != null && <span className="flex shrink-0 items-center gap-s2 t-small text-muted">{trailing}</span>}
      </>
    );
    const classes = cn(
      // A divider under every row another row follows, whether the rows are siblings or each sits in its own list item.
      'flex w-full items-center gap-s3 border-line px-s4 py-s2 text-left not-last:border-b [li:not(:last-child)>&]:border-b transition-colors duration-120',
      tight ? 'min-h-row-tight' : 'min-h-row',
      to != null && 'hover:bg-surface-2',
      selected && selectedRow,
      cursor && !selected && 'bg-surface-2',
      focusRing,
      'focus-visible:-outline-offset-2',
      className,
    );
    if (to != null) {
      return (
        <Link ref={ref as Ref<HTMLAnchorElement>} to={to} className={classes} aria-current={selected ? 'true' : undefined} data-cursor={cursor || undefined}>
          {body}
        </Link>
      );
    }
    return <div ref={ref as Ref<HTMLDivElement>} className={classes} data-cursor={cursor || undefined}>{body}</div>;
  },
);
ListRow.displayName = 'ListRow';
