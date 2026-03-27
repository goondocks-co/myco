import { AlertCircle, Sprout } from 'lucide-react';
import { Surface } from '../ui/surface';
import { ListToolbar, type FilterDefinition } from '../ui/list-toolbar';
import { Pagination } from '../ui/pagination';
import { useSpores, type SporeSummary } from '../../hooks/use-spores';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import { truncate } from '../../lib/format';
import { cn } from '../../lib/cn';
import { observationTypeClass, statusClass, formatLabel } from './helpers';

/* ---------- Constants ---------- */

/** Maximum content preview length. */
const CONTENT_PREVIEW_CHARS = 120;

/** Milliseconds per second for epoch conversion. */
const MS_PER_SECOND = 1_000;

/** Session ID preview length. */
const SESSION_ID_PREVIEW = 8;

const OBSERVATION_TYPES = [FILTER_ALL, 'gotcha', 'decision', 'discovery', 'trade_off', 'bug_fix'] as const;
const STATUS_OPTIONS = [FILTER_ALL, 'active', 'superseded', 'consolidated'] as const;

const SPORE_FILTERS: FilterDefinition[] = [
  {
    key: 'type',
    label: 'Type',
    options: OBSERVATION_TYPES.map((t) => ({
      value: t,
      label: t === FILTER_ALL ? 'All types' : formatLabel(t),
    })),
  },
  {
    key: 'status',
    label: 'Status',
    options: STATUS_OPTIONS.map((s) => ({
      value: s,
      label: s === FILTER_ALL ? 'All statuses' : formatLabel(s),
    })),
  },
];

/* ---------- Helpers ---------- */

function epochToDate(epoch: number): string {
  return new Date(epoch * MS_PER_SECOND).toLocaleDateString();
}

/* ---------- Sub-components ---------- */

function SporeRow({
  spore,
  onClick,
  isSelected,
}: {
  spore: SporeSummary;
  onClick: () => void;
  isSelected: boolean;
}) {
  return (
    <Surface
      level={isSelected ? 'high' : 'low'}
      className={cn(
        'p-4 cursor-pointer transition-all duration-150 hover:bg-surface-container-high hover:shadow-[inset_3px_0_0_var(--primary)] rounded-lg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        isSelected && 'ring-1 ring-primary/30',
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${formatLabel(spore.observation_type)} spore: ${truncate(spore.content, CONTENT_PREVIEW_CHARS)}`}
      aria-pressed={isSelected}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
                observationTypeClass(spore.observation_type),
              )}
            >
              {formatLabel(spore.observation_type)}
            </span>
            <span
              className={cn(
                'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
                statusClass(spore.status),
              )}
            >
              {formatLabel(spore.status)}
            </span>
            {spore.importance !== null && (
              <span className="font-mono text-xs text-on-surface-variant">
                {spore.importance.toFixed(1)}
              </span>
            )}
          </div>
          <p className="font-sans text-sm text-on-surface">
            {truncate(spore.content, CONTENT_PREVIEW_CHARS)}
          </p>
        </div>
        <div className="shrink-0 text-right space-y-1">
          {spore.session_id && (
            <div className="font-mono text-xs text-on-surface-variant">
              {spore.session_id.slice(0, SESSION_ID_PREVIEW)}
            </div>
          )}
          <div className="font-sans text-xs text-on-surface-variant">
            {epochToDate(spore.created_at)}
          </div>
        </div>
      </div>
    </Surface>
  );
}

function SkeletonRow() {
  return (
    <Surface level="low" className="p-4 rounded-lg">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <div className="h-5 w-16 animate-pulse rounded bg-surface-container" />
            <div className="h-5 w-14 animate-pulse rounded bg-surface-container" />
          </div>
          <div className="h-4 w-3/4 animate-pulse rounded bg-surface-container" />
        </div>
        <div className="shrink-0 space-y-1">
          <div className="h-3 w-14 animate-pulse rounded bg-surface-container" />
          <div className="h-3 w-16 animate-pulse rounded bg-surface-container" />
        </div>
      </div>
    </Surface>
  );
}

/* ---------- Component ---------- */

export interface SporeListProps {
  onSelectSpore: (spore: SporeSummary) => void;
  selectedSporeId?: string;
}

export function SporeList({ onSelectSpore, selectedSporeId }: SporeListProps) {
  const { searchInput, debouncedSearch, filterValues, offset, setOffset, handleSearchChange, handleFilterChange, activeFilter } = useListFilters({
    initialFilters: { type: FILTER_ALL, status: FILTER_ALL },
  });

  const activeType = activeFilter('type');
  const activeStatus = activeFilter('status');

  const { data, isLoading, isError, error } = useSpores({
    type: activeType,
    status: activeStatus,
    search: debouncedSearch,
    limit: DEFAULT_PAGE_SIZE,
    offset,
  });

  const spores = data?.spores ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-3">
      <ListToolbar
        searchPlaceholder="Search spores..."
        searchValue={searchInput}
        onSearchChange={handleSearchChange}
        filters={SPORE_FILTERS}
        filterValues={filterValues}
        onFilterChange={handleFilterChange}
      />

      {isError ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load spores</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {isLoading
            ? [1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)
            : spores.length === 0
            ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
                <Sprout className="h-8 w-8 opacity-30" />
                <span className="font-sans text-sm">
                  {total === 0 && !debouncedSearch && !activeType && !activeStatus
                    ? 'No spores yet'
                    : 'No matching spores'}
                </span>
                {total === 0 && !debouncedSearch && !activeType && !activeStatus && (
                  <span className="font-sans text-xs">Spores are extracted from session activity by the agent</span>
                )}
              </div>
            )
            : spores.map((spore) => (
              <SporeRow
                key={spore.id}
                spore={spore}
                onClick={() => onSelectSpore(spore)}
                isSelected={spore.id === selectedSporeId}
              />
            ))}
        </div>
      )}

      <Pagination
        total={total}
        offset={offset}
        limit={DEFAULT_PAGE_SIZE}
        onPageChange={setOffset}
      />
    </div>
  );
}
