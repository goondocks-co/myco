import { useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { EmptyDetailHint } from '../components/ui/empty-detail-hint';
import { ListFilterBar, type FilterDefinition } from '../components/ui/list-filter-bar';
import { SessionList } from '../components/sessions/SessionList';
import { SessionDetail } from '../components/sessions/SessionDetail';
import { useSymbionts } from '../hooks/use-symbionts';
import { FILTER_ALL } from '../hooks/use-list-filters';
import { useUrlListState } from '../hooks/use-url-list-state';
import { pathnameWithSearchHash } from '../lib/url-state';

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
  const location = useLocation();
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
  } = useUrlListState({
    filters: [
      { key: 'status', defaultValue: FILTER_ALL },
      { key: 'agent', defaultValue: FILTER_ALL },
      { key: 'has_plan', defaultValue: FILTER_ALL },
    ],
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
    return [STATUS_FILTER, symbiontFilter, PLAN_FILTER];
  }, [symbiontsData]);

  const activeStatus = activeFilter('status');
  const activeAgent = activeFilter('agent');
  const activeHasPlan = activeFilter('has_plan') === 'true';
  const sessionsBasePath = useMemo(() => {
    if (!id) return location.pathname;
    const suffix = `/${id}`;
    return location.pathname.endsWith(suffix) ? location.pathname.slice(0, -suffix.length) : location.pathname;
  }, [id, location.pathname]);

  const selectSession = useCallback((sessionId: string, options?: { replace?: boolean }) => {
    const params = new URLSearchParams(location.search);
    navigate(pathnameWithSearchHash(`${sessionsBasePath}/${sessionId}`, params, location.hash), options);
  }, [location.hash, location.search, navigate, sessionsBasePath]);

  const closeDetail = useCallback(() => {
    const params = new URLSearchParams(location.search);
    navigate(pathnameWithSearchHash(sessionsBasePath, params, location.hash));
  }, [location.hash, location.search, navigate, sessionsBasePath]);

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
          onCloseMobileDetail={closeDetail}
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
              onSelectSession={selectSession}
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
