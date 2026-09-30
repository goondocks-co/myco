import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

export interface FacetRow {
  key: string;
  label: ReactNode;
  /** How many the value holds under the other filters; left out while unknown. */
  count?: number;
  /** Whether this value is the one picked. */
  active: boolean;
  /** A value that is a place, such as a project, is a link. */
  to?: string;
  /** A value that is a filter on this page is a button. */
  onSelect?: () => void;
}

export interface FacetListProps {
  /** Names the facet: "Type", "Project". */
  label: string;
  rows: readonly FacetRow[];
  className?: string;
}

const rowClass = (active: boolean) => cn(
  'flex h-control w-full min-w-0 items-center gap-s3 rounded-control px-s3 text-left t-control transition-colors duration-120',
  active ? 'bg-primary-bg font-medium text-primary' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  focusRing,
);

/** One facet of a list: its values with their counts, the picked one marked. A value is a link or a button, never both. */
export function FacetList({ label, rows, className }: FacetListProps) {
  return (
    <section aria-label={label} className={cn('flex flex-col gap-s1', className)} data-facet={label}>
      <h2 className="px-s3 pb-s1 t-kicker text-faint">{label}</h2>
      <ul className="flex flex-col gap-[2px]">
        {rows.map((row) => {
          const body = (
            <>
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.count != null && <span className={cn('shrink-0 t-meta', row.active ? 'text-primary' : 'text-faint')}>{row.count.toLocaleString()}</span>}
            </>
          );
          return (
            <li key={row.key}>
              {row.to !== undefined
                ? <Link to={row.to} aria-current={row.active ? 'true' : undefined} className={rowClass(row.active)}>{body}</Link>
                : <button type="button" aria-pressed={row.active} onClick={row.onSelect} className={rowClass(row.active)}>{body}</button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
