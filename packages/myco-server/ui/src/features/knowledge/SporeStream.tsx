import { useMemo } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import {
  Button, COMPACT_QUERY, dayLabel, EmptyState, ErrorState, FacetList, FilterBar, focusRing, LoadingState, ShowMore, StatusChip, TypeChip,
  useFilterParams, useQueryDraft, type FacetRow,
} from '../../design';
import { useSporeStream } from '../../hooks/use-knowledge';
import { useMediaQuery } from '../../hooks/use-media-query';
import { useNow } from '../../hooks/use-today';
import { cn } from '../../lib/cn';
import { KNOWLEDGE_SUFFIX, keptFilters, projectPath } from '../../routes/nav';
import type { SporeFacets, SporeStreamRow } from './wire';
import {
  ago, count, DEFAULT_SPORE_STATUS, firstLine, SPORE_STATUS_FILTER, SPORE_WINDOW_FILTER, sporeHeadline, sporeStatusTone, sporeStatusWord, sporeTypePlural,
  sporeTypeWord, typeFacetRows, typeFilter, windowSince,
} from './words';

/** How long the search box waits after the last keystroke before the stream is read again. */
const FILTER_DEBOUNCE_MS = 250;

/** The filter keys the stream holds in the URL. */
export const SPORE_FILTER_KEYS = ['type', 'status', 'window'] as const;
const DEFAULTS: Readonly<Record<string, string>> = { status: DEFAULT_SPORE_STATUS };

export interface SporeStreamProps {
  /** The project the stream is narrowed to, or null for every project. */
  projectId: string | null;
  projectName: (projectId: string) => string | null;
}

/**
 * The spore stream: spores headlined by their one line, newest first, under
 * the day each was saved. One filter bar holds the search, the status and the
 * period; beside the stream the type and project facets say how many each
 * value holds, and on a narrow screen the type moves into the bar. Every value
 * lives in the query string and the server does the filtering; "Show more"
 * reads the next page.
 */
export function SporeStream({ projectId, projectName }: SporeStreamProps) {
  const now = useNow();
  const wide = !useMediaQuery(COMPACT_QUERY);
  const filterParams = useFilterParams(SPORE_FILTER_KEYS, { defaults: DEFAULTS });
  const { values } = filterParams;
  const draft = useQueryDraft(filterParams.query, filterParams.setQuery, FILTER_DEBOUNCE_MS);
  const status = values.status ?? DEFAULT_SPORE_STATUS;
  const type = values.type ?? 'all';
  const since = windowSince(values.window ?? 'all', now);
  const stream = useSporeStream({
    projectId,
    type: type === 'all' ? undefined : type,
    status: status === 'all' ? undefined : status,
    q: filterParams.query === '' ? undefined : filterParams.query,
    since: since ?? undefined,
  });
  const filtered = filterParams.query !== '' || type !== 'all' || status !== DEFAULT_SPORE_STATUS || (values.window ?? 'all') !== 'all';
  const clear = () => { draft.reset(); filterParams.clear(); };
  const filters = wide ? [SPORE_STATUS_FILTER, SPORE_WINDOW_FILTER] : [typeFilter(stream.facets?.type, type), SPORE_STATUS_FILTER, SPORE_WINDOW_FILTER];
  const groups = useMemo(() => byDay(stream.rows, now), [stream.rows, now]);

  return (
    <div className="flex flex-col gap-s5" data-spore-stream="">
      <FilterBar
        searchLabel="Filter spores"
        placeholder="Search what the spores say"
        query={draft.text}
        onQueryChange={draft.setText}
        filters={filters}
        values={{ ...values, status, type }}
        onFilterChange={filterParams.setFilter}
        onClear={clear}
      />
      <div className={cn('grid items-start gap-s6', wide && 'grid-faceted')}>
        {wide && (
          <Facets
            facets={stream.facets}
            type={type}
            onType={(value) => filterParams.setFilter('type', value)}
            projectId={projectId}
            projectName={projectName}
          />
        )}
        <div className="flex min-w-0 flex-col gap-s4">
          {stream.total !== undefined && stream.rows.length > 0 && (
            <p className="t-small text-muted" aria-live="polite" data-spore-count="">{count(stream.total, filtered ? 'matching spore' : status === DEFAULT_SPORE_STATUS ? 'current spore' : 'spore')}</p>
          )}
          {stream.isPending ? <LoadingState shape="cards" count={4} label="Loading spores" />
            : stream.error ? <ErrorState error={stream.error} onRetry={stream.retry} />
            : stream.rows.length === 0 ? (filtered
              ? <EmptyState title="No spores match." action={<Button variant="ghost" size="sm" onClick={clear}>Clear the search and filters</Button>} />
              : <EmptyState title="No spores yet. Myco writes them as it learns from your sessions." />)
            : groups.map((group) => (
              <section key={group.label} aria-labelledby={`day-${group.key}`} className="flex flex-col gap-s3">
                <h2 id={`day-${group.key}`} className="t-kicker text-faint">{group.label}</h2>
                <ul className="flex flex-col gap-s2">
                  {group.rows.map((spore) => (
                    <SporeCard key={`${spore.projectId}/${spore.id}`} spore={spore} project={projectId === null ? projectName(spore.projectId) ?? 'A project' : null} now={now} />
                  ))}
                </ul>
              </section>
            ))}
          {stream.rows.length > 0 && (
            <ShowMore shown={stream.rows.length} total={stream.total} noun="spores" onMore={stream.more} pending={stream.isFetchingMore} hasMore={stream.hasMore} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The rows under the day each was saved, in the order the server gave them. */
function byDay(rows: readonly SporeStreamRow[], now: number): Array<{ key: string; label: string; rows: SporeStreamRow[] }> {
  const groups: Array<{ key: string; label: string; rows: SporeStreamRow[] }> = [];
  for (const row of rows) {
    const label = dayLabel(row.createdAt, now);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) last.rows.push(row);
    else groups.push({ key: String(groups.length), label, rows: [row] });
  }
  return groups;
}

/**
 * One spore in the stream: its one line as a whole-card link, then its type,
 * a status other than current, its project across projects, and when it was
 * saved. A spore without its line reads as its type and day, with the start of
 * what it says beneath.
 */
function SporeCard({ spore, project, now }: { spore: SporeStreamRow; project: string | null; now: number }) {
  const headline = sporeHeadline(spore, now);
  const current = spore.status === DEFAULT_SPORE_STATUS;
  const excerpt = headline.lined ? '' : firstLine(spore.content);
  return (
    <li
      className="relative flex min-h-row flex-col justify-center gap-s1 rounded-card border border-line bg-surface-1 px-s4 py-s3 transition-colors duration-120 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-s4"
      data-spore={spore.status}
      data-unlined={headline.lined ? undefined : ''}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-s1">
        <RouterLink
          to={projectPath(spore.projectId, `/spores/${encodeURIComponent(spore.id)}`)}
          className={cn(
            'rounded-chip t-body after:absolute after:inset-0 after:rounded-card',
            headline.lined ? (current ? 'text-ink' : 'text-ink-2') : 'font-medium text-ink-2',
            focusRing,
          )}
        >
          {headline.text}
        </RouterLink>
        {excerpt !== '' && <p className="line-clamp-1 t-small text-muted">{excerpt}</p>}
      </div>
      <p className="flex shrink-0 flex-wrap items-center gap-x-s2 gap-y-s1 t-meta text-muted sm:flex-nowrap sm:justify-end">
        <TypeChip>{sporeTypeWord(spore.observationType)}</TypeChip>
        {!current && <StatusChip tone={sporeStatusTone(spore.status)}>{sporeStatusWord(spore.status)}</StatusChip>}
        {project !== null && <span className="font-medium text-ink-2">{project}</span>}
        <span aria-hidden>·</span>
        <time className="whitespace-nowrap" dateTime={new Date(spore.createdAt).toISOString()}>{ago(spore.createdAt, now)}</time>
      </p>
    </li>
  );
}

interface FacetsProps {
  facets: SporeFacets | undefined;
  type: string;
  onType: (type: string) => void;
  projectId: string | null;
  projectName: (projectId: string) => string | null;
}

/**
 * The type and project facets. A type narrows the stream in place; a project
 * is the page's own scope, so picking one leads to that project's Knowledge,
 * the filters kept.
 */
function Facets({ facets, type, onType, projectId, projectName }: FacetsProps) {
  const { search } = useLocation();
  const kept = keptFilters(search);
  const typeRows = typeFacetRows(facets?.type).filter((row) => row.n === undefined || row.n > 0 || row.type === type);
  const everything = facets === undefined ? undefined : Object.values(facets.type).reduce((sum, n) => sum + n, 0);
  const types: FacetRow[] = [
    { key: 'all', label: 'Everything', count: everything, active: type === 'all', onSelect: () => onType('all') },
    ...typeRows.map((row) => ({ key: row.type, label: sporeTypePlural(row.type), count: row.n, active: row.type === type, onSelect: () => onType(row.type) })),
  ];
  const byProject = Object.entries(facets?.project ?? {}).filter(([id, n]) => n > 0 || id === projectId).sort(([a, x], [b, y]) => y - x || (projectName(a) ?? '').localeCompare(projectName(b) ?? ''));
  if (projectId !== null && !byProject.some(([id]) => id === projectId)) byProject.unshift([projectId, 0]);
  const allCount = facets === undefined ? undefined : Object.values(facets.project).reduce((sum, n) => sum + n, 0);
  const projects: FacetRow[] = [
    { key: '*', label: 'All projects', count: allCount, active: projectId === null, to: `${KNOWLEDGE_SUFFIX}${kept}` },
    ...byProject.map(([id, n]) => ({ key: id, label: projectName(id) ?? 'A project', count: facets === undefined ? undefined : n, active: id === projectId, to: `${projectPath(id, KNOWLEDGE_SUFFIX)}${kept}` })),
  ];
  return (
    <aside aria-label="Narrow the spores" className="flex flex-col gap-s6" data-facets="">
      <FacetList label="Type" rows={types} />
      <FacetList label="Project" rows={projects} />
    </aside>
  );
}
