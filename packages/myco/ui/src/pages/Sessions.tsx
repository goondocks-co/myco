import { useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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

export default function Sessions() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const filterInputRef = useRef<HTMLInputElement>(null);

  const {
    searchInput,
    debouncedSearch,
    filterValues,
    offset,
    setOffset,
    handleSearchChange,
    handleFilterChange,
    activeFilter,
  } = useListFilters({
    initialFilters: { status: FILTER_ALL, agent: FILTER_ALL },
  });

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
    return [STATUS_FILTER, symbiontFilter];
  }, [symbiontsData]);

  const activeStatus = activeFilter('status');
  const activeAgent = activeFilter('agent');

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
