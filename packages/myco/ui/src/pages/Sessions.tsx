import { useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { EmptyDetailHint } from '../components/ui/empty-detail-hint';
import { ListFilterBar, type FilterDefinition } from '../components/ui/list-filter-bar';
import { SessionList } from '../components/sessions/SessionList';
import { SessionDetail } from '../components/sessions/SessionDetail';
import { useSymbionts } from '../hooks/use-symbionts';
import { useListFilters, FILTER_ALL } from '../hooks/use-list-filters';

const STATUS_FILTER: FilterDefinition = {
  key: 'status',
  label: 'Status',
  options: [
    { value: FILTER_ALL, label: 'All statuses' },
    { value: 'active', label: 'Active' },
    { value: 'completed', label: 'Completed' },
  ],
};

const PLAN_FILTER: FilterDefinition = {
  key: 'has_plan',
  label: 'Plans',
  options: [
    { value: FILTER_ALL, label: 'All sessions' },
    { value: 'true', label: 'With a plan' },
  ],
};

export default function Sessions() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Filter values are derived from URL query params on EVERY render —
  // not seeded once. That keeps the dropdown in sync when the user
  // deep-links to /sessions?agent=X from one chip, then clicks another
  // chip (e.g. switches to /sessions?agent=Y) while the page is still
  // mounted. Earlier useMemo([]) approach captured initialFilters once
  // and went stale on intra-mount URL changes.
  const urlFilters = useMemo(() => ({
    status: searchParams.get('status') ?? FILTER_ALL,
    agent: searchParams.get('agent') ?? FILTER_ALL,
    has_plan: searchParams.get('has_plan') === 'true' ? 'true' : FILTER_ALL,
  }), [searchParams]);

  const {
    searchInput,
    debouncedSearch,
    filterValues,
    offset,
    setOffset,
    handleSearchChange,
    handleFilterChange,
    activeFilter,
  } = useListFilters({ initialFilters: urlFilters });

  // Keep in-component filter state in sync when the URL changes.
  // Without this, useListFilters' local state diverges from the URL
  // after the first mount and same-route URL transitions.
  useEffect(() => {
    for (const [key, value] of Object.entries(urlFilters)) {
      if (filterValues[key] !== value) handleFilterChange(key, value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFilters]);

  const { data: symbiontsData } = useSymbionts();

  // Symbiont filter options are derived from whichever symbionts the project
  // has enabled. The filter key stays `agent` because the sessions backend
  // expects it, but the label + options reflect the project's actual config.
  const sessionFilters = useMemo<FilterDefinition[]>(() => {
    const enabledSymbionts = (symbiontsData?.symbionts ?? []).filter((s) => s.enabled);
    const symbiontFilter: FilterDefinition = {
      key: 'agent',
      label: 'Symbiont',
      options: [
        { value: FILTER_ALL, label: 'All symbionts' },
        ...enabledSymbionts.map((s) => ({ value: s.name, label: s.displayName })),
      ],
    };
    return [STATUS_FILTER, symbiontFilter, PLAN_FILTER];
  }, [symbiontsData]);

  const activeStatus = activeFilter('status');
  const activeAgent = activeFilter('agent');
  const activeHasPlan = activeFilter('has_plan') === 'true';

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      <ListFilterBar
        searchPlaceholder="Search sessions..."
        searchValue={searchInput}
        onSearchChange={handleSearchChange}
        filters={sessionFilters}
        filterValues={filterValues}
        onFilterChange={handleFilterChange}
        inputRef={filterInputRef}
      />
      <div className="flex-1 min-h-0">
        <MasterDetailSplit
          hasSelection={!!id}
          onCloseMobileDetail={() => navigate('..')}
          masterAriaLabel="Sessions"
          detailAriaLabel="Session details"
          master={
            <SessionList
              selectedId={id}
              search={debouncedSearch}
              statusFilter={activeStatus}
              agentFilter={activeAgent}
              hasPlanFilter={activeHasPlan}
              offset={offset}
              onOffsetChange={setOffset}
              filterInputRef={filterInputRef}
            />
          }
          detail={
            id ? (
              <SessionDetail id={id} />
            ) : (
              <EmptyDetailHint message="Select a session to see its details." />
            )
          }
        />
      </div>
    </div>
  );
}
