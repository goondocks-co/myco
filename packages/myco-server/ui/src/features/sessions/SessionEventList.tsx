import type { ReactNode } from 'react';
import {
  ANY, EmptyState, ErrorState, FilterBar, ListRow, LoadingState, ShowMore, TypeChip, useFilterParams, useQueryDraft,
  type FilterParams, type QueryDraft, type SelectOption,
} from '../../design';
import { clockTime, shortDay } from '../today/words';

/** The URL key of the list's one filter; switching tabs drops it with `q`. */
export const EVENT_TYPE_KEY = 'type';
const FILTER_KEYS = [EVENT_TYPE_KEY] as const;
const FILTER_DEBOUNCE_MS = 250;

/** One thing the session holds, as its list shows it. */
export interface SessionEventRow {
  key: string;
  /** When it happened, shown first. */
  at: number;
  /** What kind of thing it is, in words: "Gotcha", "In progress". */
  kind: string;
  title: ReactNode;
  /** The line under the title. */
  detail?: ReactNode;
  /** Its own page, when it has one. */
  to?: string;
  /** A control at the row's far end, on a row with no page of its own. */
  trailing?: ReactNode;
}

/** A read the list shows: its rows so far, and how to get the rest. */
export interface SessionEventRead {
  rows: readonly SessionEventRow[];
  /** How many rows match in all, when the server counts them. */
  total?: number;
  isPending: boolean;
  error: unknown;
  retry: () => void;
  hasMore: boolean;
  isFetchingMore: boolean;
  more: () => void;
}

export interface SessionEventFilters {
  params: FilterParams;
  draft: QueryDraft;
  /** The kind picked, or null for every kind. */
  type: string | null;
  /** The search, trimmed. */
  q: string;
}

/** The list's filter and search, held in the URL as `?type=` and `?q=`. */
export function useSessionEventFilters(): SessionEventFilters {
  const params = useFilterParams(FILTER_KEYS);
  const draft = useQueryDraft(params.query, params.setQuery, FILTER_DEBOUNCE_MS);
  const picked = params.values[EVENT_TYPE_KEY] ?? ANY;
  return { params, draft, type: picked === ANY ? null : picked, q: params.query.trim() };
}

/** The filter and search above a list whose read takes them. */
export interface SessionEventFilter {
  filters: SessionEventFilters;
  /** Names the search field, as in "Search spores". */
  searchLabel: string;
  placeholder: string;
  /** Names the one select: "Type" or "Status". */
  typeLabel: string;
  /** The first option is the unfiltered one. */
  typeOptions: readonly SelectOption[];
}

export interface SessionEventListProps {
  /** Absent for a list too short to need one. */
  filter?: SessionEventFilter;
  /** Structured filters for lists with no body search. */
  filterBar?: ReactNode;
  filtered?: boolean;
  read: SessionEventRead;
  /** The plural noun the list counts, as in "spores". */
  noun: string;
  /** Countable words when the list name is collective. */
  countNoun?: string;
  /** Rows wrap their words instead of truncating them. */
  wrap?: boolean;
  /** What the list says when the session holds none at all. */
  emptyTitle: string;
  emptyFilteredTitle?: string;
  loadingLabel: string;
  now: number;
}

/**
 * The things a session holds of one kind, as one list: a filter of their kind
 * and a search above where the list takes them, then one row each with its
 * time first, its kind above its title and its detail under it, and "Show
 * more" at the foot. An empty list says whether the session holds none or the
 * filter matches none.
 */
export function SessionEventList({ filter, filterBar, filtered: structuredFiltered = false, read, noun, countNoun = noun, wrap = false, emptyTitle, emptyFilteredTitle, loadingLabel, now }: SessionEventListProps) {
  const filtered = structuredFiltered || (filter !== undefined && (filter.filters.type !== null || filter.filters.q !== ''));
  return (
    <div className="flex flex-col gap-s3" data-session-events={noun}>
      {filterBar}
      {filter !== undefined && <EventFilterBar filter={filter} />}
      {read.isPending ? <LoadingState label={loadingLabel} count={3} />
        : read.error ? <ErrorState error={read.error} onRetry={read.retry} />
        : read.rows.length === 0 ? (
          filtered
            ? <EmptyState title={emptyFilteredTitle ?? `No ${noun} in this session match this filter.`} />
            : <EmptyState title={emptyTitle} />
        ) : (
          <div>
            <ul aria-label={capitalized(noun)} className="overflow-hidden rounded-card border border-line bg-surface-1">
              {read.rows.map((row) => (
                <li key={row.key}>
                  <ListRow leading={<When at={row.at} now={now} />} kicker={<TypeChip>{row.kind}</TypeChip>} title={row.title} meta={row.detail} to={row.to} trailing={row.trailing} wrap={wrap} />
                </li>
              ))}
            </ul>
            {(read.hasMore || read.total !== undefined) && (
              <ShowMore shown={read.rows.length} total={read.total} noun={countNoun} onMore={read.more} pending={read.isFetchingMore} hasMore={read.hasMore} />
            )}
          </div>
        )}
    </div>
  );
}

function EventFilterBar({ filter }: { filter: SessionEventFilter }) {
  const { params, draft } = filter.filters;
  const clear = () => { draft.reset(); params.clear(); };
  return (
    <FilterBar
      searchLabel={filter.searchLabel}
      placeholder={filter.placeholder}
      query={draft.text}
      onQueryChange={draft.setText}
      filters={[{ key: EVENT_TYPE_KEY, label: filter.typeLabel, options: filter.typeOptions }]}
      values={params.values}
      onFilterChange={params.setFilter}
      onClear={clear}
    />
  );
}

/** The day above the time, so the column stays narrow. */
function When({ at, now }: { at: number; now: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} className="flex w-s12 flex-col t-meta tabular-nums text-muted sm:w-time-col">
      <span className="whitespace-nowrap">{shortDay(at, now)}</span>
      <span className="whitespace-nowrap">{clockTime(at)}</span>
    </time>
  );
}

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
