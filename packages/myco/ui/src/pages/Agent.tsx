import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Play } from 'lucide-react';
import { Button } from '../components/ui/button';
import { PageHeader } from '../components/ui/page-header';
import { Surface } from '../components/ui/surface';
import type { Tab } from '../components/ui/tab-switcher';
import { RunList } from '../components/agent/RunList';
import { RunDetail } from '../components/agent/RunDetail';
import { RunTaskDialog } from '../components/agent/RunTaskDialog';
import { TaskList } from '../components/agent/TaskList';
import { TaskDetail } from '../components/agent/TaskDetail';
import { AgentConfig } from '../components/agent/AgentConfig';
import { ComparisonView } from '../components/agent/ComparisonView';
import { useRunsByIds } from '../hooks/use-agent';

type AgentTab = 'runs' | 'tasks' | 'config' | 'comparisons';

/* ---------- URL state helpers ---------- */

/** URL search param keys for persistent navigation state. */
const PARAM_TAB = 'tab';
const PARAM_RUN = 'run';
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
  runId?: string;
  taskId?: string;
  /** Ad-hoc comparison run ids (parsed from `runs=id1,id2,...`). */
  compareRunIds?: string[];
}

function parseRunIds(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

/** Read initial state from URL search params. */
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
    runId: params.get(PARAM_RUN) ?? undefined,
    taskId: params.get(PARAM_TASK) ?? undefined,
    compareRunIds: parseRunIds(params.get(PARAM_RUNS)),
  };
}

interface BuildUrlArgs {
  tab: AgentTab;
  runId?: string;
  taskId?: string;
  compareRunIds?: string[];
}

function buildUrlState({ tab, runId, taskId, compareRunIds }: BuildUrlArgs): URLSearchParams {
  const params = new URLSearchParams();
  if (tab !== 'runs') params.set(PARAM_TAB, tab);
  if (runId) params.set(PARAM_RUN, runId);
  if (taskId) params.set(PARAM_TASK, taskId);
  if (compareRunIds && compareRunIds.length > 0) {
    params.set(PARAM_RUNS, compareRunIds.join(','));
  }
  return params;
}

/* ---------- Tab definitions ---------- */

const TABS: Tab[] = [
  { id: 'runs', label: 'Runs' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'comparisons', label: 'Comparisons' },
  { id: 'config', label: 'Config' },
];

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
  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = useMemo(() => readUrlState(searchParams), [searchParams]);
  const { tab, runId: selectedRunId, taskId: selectedTaskId, compareRunIds } = urlState;
  const [triggerOpen, setTriggerOpen] = useState(false);

  // Canonicalize `?tab=evaluations` bookmarks on mount so future navigation
  // uses the new name.
  useEffect(() => {
    const rawTab = searchParams.get(PARAM_TAB);
    if (rawTab && TAB_REDIRECTS[rawTab]) {
      const nextTab = TAB_REDIRECTS[rawTab];
      const next = new URLSearchParams(searchParams);
      if (nextTab === 'runs') next.delete(PARAM_TAB);
      else next.set(PARAM_TAB, nextTab);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateState = useCallback((
    nextTab: AgentTab,
    nextRunId?: string,
    nextTaskId?: string,
    nextCompareRunIds?: string[],
  ) => {
    setSearchParams(buildUrlState({
      tab: nextTab,
      runId: nextRunId,
      taskId: nextTaskId,
      compareRunIds: nextCompareRunIds,
    }));
  }, [setSearchParams]);

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

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="Agent"
        subtitle="Intelligence runs, task configuration, and operational settings"
        tabs={TABS}
        activeTab={tab}
        onTabChange={switchTab}
        actions={pageAction}
      />

      {/* Runs tab */}
      {tab === 'runs' && (
        selectedRunId ? (
          <RunDetail runId={selectedRunId} onBack={() => navigateState('runs')} />
        ) : (
          <RunList
            onSelectRun={(id) => navigateState('runs', id)}
            onTriggerRun={() => setTriggerOpen(true)}
            onCompareRuns={(ids) =>
              navigateState('comparisons', undefined, undefined, ids)
            }
          />
        )
      )}

      {/* Tasks tab */}
      {tab === 'tasks' && (
        selectedTaskId ? (
          <TaskDetail
            taskId={selectedTaskId}
            onBack={() => navigateState('tasks')}
            onNavigate={(taskId) => navigateState('tasks', undefined, taskId)}
            onRunTriggered={(runId) => {
              navigateState('runs', runId);
            }}
          />
        ) : (
          <TaskList onSelect={(taskId) => navigateState('tasks', undefined, taskId)} />
        )
      )}

      {/* Comparisons tab — ad-hoc run comparison or empty-state prompt */}
      {tab === 'comparisons' && (
        compareRunIds && compareRunIds.length > 0 ? (
          <AdHocComparison
            runIds={compareRunIds}
            onBack={() => navigateState('comparisons')}
            onOpenRun={(runId) => navigateState('runs', runId)}
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
        )
      )}

      {/* Config tab */}
      {tab === 'config' && <AgentConfig />}

      <RunTaskDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        onTriggered={(runId) => navigateState('runs', runId)}
      />
    </div>
  );
}
