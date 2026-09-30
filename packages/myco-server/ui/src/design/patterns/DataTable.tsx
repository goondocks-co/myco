import { type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useMediaQuery } from '../../hooks/use-media-query';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';
import { COMPACT_QUERY } from '../shell/AppShell';

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Numbers and times sit at the end of their cell. */
  align?: 'start' | 'end';
  /** A fixed width for a narrow column; the first column takes what is left. */
  width?: 'sm' | 'md' | 'lg';
}

export interface DataTableGroup<T> {
  key: string;
  /** The group's heading, such as a day: "Today", "Thursday, September 24". */
  label: string;
  rows: readonly T[];
}

export interface DataTableProps<T> {
  /** Names the table, as in "Sessions". */
  label: string;
  /**
   * The columns, in order. The first is the row's headline: its cell is the
   * link that opens the row, and the whole row is that link's target.
   */
  columns: readonly DataTableColumn<T>[];
  groups: readonly DataTableGroup<T>[];
  rowKey: (row: T) => string;
  rowHref: (row: T) => string;
  /** A second line under the headline, such as a summary's first line. */
  detail?: (row: T) => ReactNode;
  /** On a phone or tablet, the line under the headline and its detail that stands in for the other columns. */
  phoneMeta?: (row: T) => ReactNode;
  /** Data attributes a row carries, for a state such as live. */
  rowData?: (row: T) => Readonly<Record<`data-${string}`, string | undefined>>;
}

const WIDTH: Record<NonNullable<DataTableColumn<unknown>['width']>, string> = {
  sm: 'w-[104px]',
  md: 'w-[136px]',
  lg: 'w-[168px]',
};

/** A link whose target is the whole row: its box is stretched over the row, which is the positioned ancestor. */
const rowLink = cn('rounded-chip text-ink after:absolute after:inset-0 after:content-[""] hover:underline hover:decoration-line-strong hover:underline-offset-[3px]', focusRing);

/**
 * A table of records grouped under headings, each row a link to its record:
 * a column spec, a quiet header, a heading row per group, and whole-row
 * targets. On a phone or tablet the rows become two-line cards under the same
 * headings.
 */
export function DataTable<T>({ label, columns, groups, rowKey, rowHref, detail, phoneMeta, rowData }: DataTableProps<T>) {
  // Under 1024px the columns beside the headline would leave it too narrow to read, so rows become cards.
  const narrow = useMediaQuery(COMPACT_QUERY);
  const [primary, ...rest] = columns;
  if (primary === undefined) return null;
  if (narrow) {
    return (
      <div data-table={label} className="overflow-hidden rounded-card border border-line bg-surface-1">
        {groups.map((group) => (
          <section key={group.key} aria-label={group.label}>
            <h2 className="border-b border-line bg-surface-2 px-s4 py-s2 t-small font-medium text-muted">{group.label}</h2>
            <ul className="flex flex-col">
              {group.rows.map((row) => (
                <li key={rowKey(row)} {...rowData?.(row)} className="relative flex flex-col gap-s1 border-b border-line px-s4 py-s3 last:border-b-0 hover:bg-surface-2">
                  <RouterLink to={rowHref(row)} className={cn(rowLink, 't-body font-medium')}>{primary.cell(row)}</RouterLink>
                  {detail !== undefined && <DetailLine>{detail(row)}</DetailLine>}
                  {phoneMeta !== undefined && <div className="t-small text-muted">{phoneMeta(row)}</div>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div data-table={label} className="overflow-hidden rounded-card border border-line bg-surface-1">
      <table aria-label={label} className="w-full table-fixed border-collapse">
        <thead>
          <tr className="h-s10 border-b border-line">
            {columns.map((column, i) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'px-s4 t-kicker text-faint',
                  i === 0 ? 'text-left' : column.width !== undefined && WIDTH[column.width],
                  i > 0 && (column.align === 'end' ? 'text-right' : 'text-left'),
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key}>
            <tr>
              <th scope="rowgroup" colSpan={columns.length} className="border-b border-line bg-surface-2 px-s4 py-s2 text-left t-small font-medium text-muted">
                {group.label}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={rowKey(row)} {...rowData?.(row)} className="relative border-b border-line transition-colors duration-120 last:border-b-0 hover:bg-surface-2">
                <td className="min-w-0 px-s4 py-s3 align-baseline">
                  <div className="flex min-w-0 flex-col gap-s1">
                    <RouterLink to={rowHref(row)} className={cn(rowLink, 'line-clamp-1 t-body font-medium')}>{primary.cell(row)}</RouterLink>
                    {detail !== undefined && <DetailLine>{detail(row)}</DetailLine>}
                  </div>
                </td>
                {rest.map((column) => (
                  <td key={column.key} className={cn('truncate px-s4 py-s3 align-baseline t-small text-ink-2', column.align === 'end' && 'text-right tabular-nums text-muted')}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function DetailLine({ children }: { children: ReactNode }) {
  if (children == null || children === false) return null;
  return <p className="line-clamp-1 t-small text-muted">{children}</p>;
}
