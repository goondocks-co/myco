import type { ReactNode } from 'react';
import { EmptyState, ErrorState, ListRow, LoadingState, ShowMore, TypeChip } from '../../design';
import { SEARCH_MIN_CHARS, searchResultPath, useSearchPages, type SearchFilters, type SearchScope } from '../../hooks/use-search';
import { ago } from '../knowledge/words';

export interface SearchMatchesProps {
  scope: SearchScope;
  /** What to search and every structured filter the surface has selected; the query is the search box's text. */
  filters: Omit<SearchFilters, 'order' | 'cursor' | 'mode'>;
  /** The plural noun the matches are, as in "spores". */
  noun: string;
  /** A project's name by its id, to name each match's project when the search spans every project. */
  projectName?: (projectId: string) => string | null;
  /** A chip naming what each match is, when the list mixes kinds. */
  kind?: (hit: { type: string }) => string | null;
  /** What the list offers when nothing matches. */
  emptyAction?: ReactNode;
  now: number;
}

/**
 * What a search box finds: the best matches first, each leading to its own page, and "Show more" reading the next
 * matches until none follow. A search ranks what it finds and never counts it, so the list says how many it shows.
 */
export function SearchMatches({ scope, filters, noun, projectName, kind, emptyAction, now }: SearchMatchesProps) {
  const query = filters.query.trim();
  const enabled = query.length >= SEARCH_MIN_CHARS;
  const search = useSearchPages(scope, { ...filters, query }, enabled);
  if (!enabled) return <p className="t-small text-muted" data-search-short="">Type at least {SEARCH_MIN_CHARS} characters to search.</p>;
  if (search.isPending) return <LoadingState label={`Searching ${noun}`} count={3} />;
  if (search.error && search.hits.length === 0) return <ErrorState error={search.error} onRetry={search.retry} />;
  if (search.hits.length === 0) return <EmptyState title={`No ${noun} match “${query}”.`} action={emptyAction} />;
  return (
    <div className="flex flex-col gap-s2" data-search-matches={noun}>
      <p className="t-small text-muted" aria-live="polite">Best matches first</p>
      <ul aria-label={`Matching ${noun}`} className="overflow-hidden rounded-card border border-line bg-surface-1">
        {search.hits.map((hit) => {
          const chip = kind?.(hit) ?? null;
          const project = scope === 'all' ? projectName?.(hit.projectId) ?? null : null;
          return (
            <li key={`${hit.projectId}/${hit.type}/${hit.id}`} data-search-match={hit.type}>
              <ListRow
                leading={<time className="t-meta text-muted" dateTime={new Date(hit.created_at).toISOString()}>{ago(hit.created_at, now)}</time>}
                kicker={chip === null && project === null ? undefined : <>{chip !== null && <TypeChip>{chip}</TypeChip>}{project !== null && <span className="t-meta text-ink-2"> {project}</span>}</>}
                title={hit.title}
                meta={hit.preview === '' ? undefined : hit.preview}
                to={searchResultPath(hit.projectId, hit) ?? undefined}
              />
            </li>
          );
        })}
      </ul>
      {search.error && <ErrorState error={search.error} onRetry={search.retry} />}
      <ShowMore shown={search.hits.length} noun={noun} onMore={search.more} pending={search.isFetchingMore} hasMore={search.hasMore} />
    </div>
  );
}
