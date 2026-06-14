import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useSearchParams, useParams, useNavigate, useLocation } from 'react-router-dom';
import { Play } from 'lucide-react';
import { Button } from '../components/ui/button';
import { PageHeader } from '../components/ui/page-header';
import { Surface } from '../components/ui/surface';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { EmptyDetailHint } from '../components/ui/empty-detail-hint';
import { TileTabs } from '../components/ui/tile-tabs';
import { ListFilterBar, type FilterDefinition } from '../components/ui/list-filter-bar';
import { RunList } from '../components/agent/RunList';
import { RunDetail } from '../components/agent/RunDetail';
import { RunTaskDialog } from '../components/agent/RunTaskDialog';
import { TaskList } from '../components/agent/TaskList';
import { TaskDetail } from '../components/agent/TaskDetail';
import { AgentConfig } from '../components/agent/AgentConfig';
import { ComparisonView } from '../components/agent/ComparisonView';
import { useAgentTasks, useRunsByIds } from '../hooks/use-agent';
import { FILTER_ALL } from '../hooks/use-list-filters';
import { useUrlListState } from '../hooks/use-url-list-state';
import { pathnameWithSearchHash, updateQueryValues } from '../lib/url-state';

type AgentTab = 'runs' | 'tasks' | 'config' | 'comparisons';

/* ---------- URL state helpers ---------- */

/** URL search param keys for persistent navigation state. */
const PARAM_TAB = 'tab';
const PARAM_TASK = 'task';
const PARAM_RUNS = 'runs';

/** Valid tab values for URL parsing. */
const VALID_TABS = new Set<AgentTab>(['runs', 'tasks', 'config', 'comparisons']);

/**
 * Legacy tab ids that redirect to the current tab. Kept so bookmarked
 * `?tab=evaluations` URLs still land on the Comparisons tab after the
 * matrix-evaluation feature was retired.
 */
const TAB_REDIRECTS: Record<string, AgentTab> = {
  evaluations: 'comparisons',
};

interface UrlState {
  tab: AgentTab;
  taskId?: string;
  /** Ad-hoc comparison run ids (parsed from `runs=id1,id2,...`). */
  compareRunIds?: string[];
}

function parseRunIds(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

/** Read tab + non-run-id state from URL search params. The selected run id
 *  lives in the path (`/agent/:id`), not search params. */
function readUrlState(params: URLSearchParams): UrlState {
  const rawTab = params.get(PARAM_TAB);
  let tab: AgentTab = 'runs';
  if (rawTab) {
    if (VALID_TABS.has(rawTab as AgentTab)) {
      tab = rawTab as AgentTab;
    } else if (TAB_REDIRECTS[rawTab]) {
      tab = TAB_REDIRECTS[rawTab];
    }
  }
  return {
    tab,
    taskId: params.get(PARAM_TASK) ?? undefined,
    compareRunIds: parseRunIds(params.get(PARAM_RUNS)),
  };
}

interface BuildUrlArgs {
  tab: AgentTab;
  taskId?: string;
  compareRunIds?: string[];
}

function buildUrlState({ tab, taskId, compareRunIds }: BuildUrlArgs): URLSearchParams {
  const params = new URLSearchParams();
  if (tab !== 'runs') params.set(PARAM_TAB, tab);
  if (taskId) params.set(PARAM_TASK, taskId);
  if (compareRunIds && compareRunIds.length > 0) {
    params.set(PARAM_RUNS, compareRunIds.join(','));
  }
  return params;
}

/* ---------- Tab definitions ---------- */

const TABS = [
  { id: 'runs', label: 'Runs', description: 'execution log' },
  { id: 'tasks', label: 'Tasks', description: 'task library' },
  { id: 'comparisons', label: 'Comparisons', description: 'side-by-side' },
  { id: 'config', label: 'Config', description: 'agent settings' },
] as const;

const RUN_STATUS_FILTER: FilterDefinition = {
  key: 'status',
  label: 'Status',
  options: [
    { value: FILTER_ALL, label: 'All statuses' },
    { value: 'running', label: 'Running' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' },
  ],
};

/* ---------- Component ---------- */

/**
 * Thin wrapper around `<ComparisonView />` that does the `useRunsByIds`
 * fetch for an ad-hoc comparison. Kept inline (rather than as its own
 * file) because it's a 20-line glue component specific to this page.
 */
function AdHocComparison({
  runIds,
  onBack,
  onOpenRun,
}: {
  runIds: string[];
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const { runs, isLoading, isError, errors } = useRunsByIds(runIds);
  return (
    <ComparisonView
      runs={runs}
      isLoading={isLoading}
      isError={isError}
      errorMessage={errors[0]?.message}
      onBack={onBack}
      onOpenRun={onOpenRun}
      title="Comparison"
      subtitle={`${runIds.length} ${runIds.length === 1 ? 'run' : 'runs'}`}
      backLabel="Comparisons"
    />
  );
}

export default function Agent() {
  const { id: selectedRunId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const urlState = useMemo(() => readUrlState(searchParams), [searchParams]);
  // When a run is selected via the path (/agent/:id), force the Runs tab —
  // a path-selected run only makes sense in the Runs view. Tab in ?tab= is
  // ignored in that case.
  const tab: AgentTab = selectedRunId ? 'runs' : urlState.tab;
  const { taskId: selectedTaskId, compareRunIds } = urlState;
  const [triggerOpen, setTriggerOpen] = useState(false);
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
      { key: 'task', defaultValue: FILTER_ALL },
    ],
  });

  /** Base path of the Agent page (`/g/<grove>/p/<project>/agent`), with any
   *  trailing `/<runId>` stripped. Used to build sibling URLs for tab/comparison
   *  navigation that must drop the path-selected run. */
  const agentBasePath = useMemo(() => {
    if (selectedRunId) {
      const suffix = `/${selectedRunId}`;
      if (location.pathname.endsWith(suffix)) {
        return location.pathname.slice(0, -suffix.length);
      }
    }
    return location.pathname;
  }, [location.pathname, selectedRunId]);

  // Mount-only canonicalization for legacy tab ids. Old `?run=`/`?runId=`
  // agent-run links are handled by a DB migration, not runtime compatibility.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const rawTab = params.get(PARAM_TAB);
    const redirectedTab = rawTab ? TAB_REDIRECTS[rawTab] : undefined;

    let mutated = false;

    if (redirectedTab) {
      if (redirectedTab === 'runs') params.delete(PARAM_TAB);
      else params.set(PARAM_TAB, redirectedTab);
      mutated = true;
    }

    if (mutated) {
      const search = params.toString();
      navigate(`${location.pathname}${search ? `?${search}` : ''}${location.hash}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Navigate to the agent page with the given tab state, dropping any
   *  path-selected run id. */
  const navigateState = useCallback((
    nextTab: AgentTab,
    nextTaskId?: string,
    nextCompareRunIds?: string[],
  ) => {
    const params = buildUrlState({
      tab: nextTab,
      taskId: nextTaskId,
      compareRunIds: nextCompareRunIds,
    });
    navigate(pathnameWithSearchHash(agentBasePath, params, location.hash));
  }, [agentBasePath, location.hash, navigate]);

  /** Select a run by navigating to the path-based `/agent/<id>` URL. Runs-tab
   * list params survive; task/comparison detail params are dropped. */
  const selectRun = useCallback((runId: string, options?: { replace?: boolean }) => {
    const params = tab === 'runs'
      ? updateQueryValues(location.search, {
        [PARAM_TAB]: { value: undefined },
        [PARAM_RUNS]: { value: undefined },
      })
      : new URLSearchParams();
    navigate(pathnameWithSearchHash(`${agentBasePath}/${runId}`, params, location.hash), options);
  }, [agentBasePath, location.hash, location.search, navigate, tab]);

  const switchTab = useCallback((id: string) => {
    const t = id as AgentTab;
    navigateState(t);
  }, [navigateState]);

  // Resolve the primary action button for the current tab.
  let pageAction: React.ReactNode;
  if (tab === 'runs') {
    pageAction = (
      <Button variant="outline" size="sm" className="gap-2" onClick={() => setTriggerOpen(true)}>
        <Play className="h-3.5 w-3.5" />
        Run Now
      </Button>
    );
  }

  const { data: tasksData } = useAgentTasks();
  const runFilters = useMemo<FilterDefinition[]>(() => {
    const taskFilter: FilterDefinition = {
      key: 'task',
      label: 'Task',
      options: [
        { value: FILTER_ALL, label: 'All tasks' },
        ...(tasksData?.tasks ?? []).map((task) => ({
          value: task.name,
          label: task.displayName,
        })),
      ],
    };
    return [RUN_STATUS_FILTER, taskFilter];
  }, [tasksData]);

  const activeStatus = activeFilter('status');
  const activeTask = activeFilter('task');

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 p-6 pb-0 space-y-6">
        <PageHeader
          title="Agent"
          subtitle="Intelligence runs, task configuration, and operational settings"
          actions={pageAction}
        />
        <TileTabs
          tabs={TABS.map((t) => ({ id: t.id, label: t.label, description: t.description }))}
          activeTab={tab}
          onTabChange={switchTab}
          columns={4}
        />
        {tab === 'runs' && (
          <ListFilterBar
            searchPlaceholder="Search runs..."
            searchValue={searchInput}
            onSearchChange={handleSearchChange}
            filters={runFilters}
            filterValues={filterValues}
            onFilterChange={handleFilterChange}
            inputRef={filterInputRef}
          />
        )}
      </div>

      {/* Runs tab — master/detail split */}
      {tab === 'runs' && (
        <div className="flex-1 min-h-0 mt-4">
          <MasterDetailSplit
            hasSelection={!!selectedRunId}
            onCloseMobileDetail={() => {
              const params = new URLSearchParams(location.search);
              navigate(pathnameWithSearchHash(agentBasePath, params, location.hash));
            }}
            masterAriaLabel="Agent runs"
            detailAriaLabel="Run details"
            master={
              <RunList
                selectedId={selectedRunId}
                search={debouncedSearch}
                statusFilter={activeStatus}
                taskFilter={activeTask}
                offset={offset}
                onOffsetChange={setOffset}
                filterInputRef={filterInputRef}
                onSelectRun={selectRun}
                onTriggerRun={() => setTriggerOpen(true)}
                onCompareRuns={(ids) => navigateState('comparisons', undefined, ids)}
              />
            }
            detail={
              selectedRunId ? (
                <RunDetail runId={selectedRunId} onBack={() => {
                  const params = new URLSearchParams(location.search);
                  navigate(pathnameWithSearchHash(agentBasePath, params, location.hash));
                }} />
              ) : (
                <EmptyDetailHint message="Select a run to see its details." />
              )
            }
          />
        </div>
      )}

      {/* Tasks tab */}
      {tab === 'tasks' && (
        <div className="p-6 pt-4 space-y-4">
          {selectedTaskId ? (
            <TaskDetail
              taskId={selectedTaskId}
              onBack={() => navigateState('tasks')}
              onNavigate={(taskId) => navigateState('tasks', taskId)}
              onRunTriggered={(runId) => { if (runId) selectRun(runId); }}
            />
          ) : (
            <TaskList onSelect={(taskId) => navigateState('tasks', taskId)} />
          )}
        </div>
      )}

      {/* Comparisons tab — ad-hoc run comparison or empty-state prompt */}
      {tab === 'comparisons' && (
        <div className="p-6 pt-4 space-y-4">
          {compareRunIds && compareRunIds.length > 0 ? (
            <AdHocComparison
              runIds={compareRunIds}
              onBack={() => navigateState('comparisons')}
              onOpenRun={(runId) => selectRun(runId)}
            />
          ) : (
            <Surface level="low" className="p-8 text-center space-y-2">
              <h2 className="font-serif text-lg text-on-surface">Compare selected runs</h2>
              <p className="font-sans text-sm text-on-surface-variant">
                Select two or more runs in the Runs tab and use "Compare selected"
                to see them side by side here.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => navigateState('runs')}
              >
                Go to Runs
              </Button>
            </Surface>
          )}
        </div>
      )}

      {/* Config tab */}
      {tab === 'config' && (
        <div className="p-6 pt-4 space-y-4">
          <AgentConfig />
        </div>
      )}

      <RunTaskDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        onTriggered={(runId) => { if (runId) selectRun(runId); }}
      />
    </div>
  );
}
