import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Play, Layers } from 'lucide-react';
import { Button } from '../components/ui/button';
import { PageHeader } from '../components/ui/page-header';
import type { Tab } from '../components/ui/tab-switcher';
import { RunList } from '../components/agent/RunList';
import { RunDetail } from '../components/agent/RunDetail';
import { RunTaskDialog } from '../components/agent/RunTaskDialog';
import { TaskList } from '../components/agent/TaskList';
import { TaskDetail } from '../components/agent/TaskDetail';
import { AgentConfig } from '../components/agent/AgentConfig';
import { EvaluationList } from '../components/agent/EvaluationList';
import { EvaluationDetail } from '../components/agent/EvaluationDetail';
import { ComparisonView } from '../components/agent/ComparisonView';
import { MatrixRunDialog } from '../components/agent/MatrixRunDialog';
import { useRunsByIds } from '../hooks/use-agent';

type AgentTab = 'runs' | 'tasks' | 'config' | 'comparisons';

/* ---------- URL state helpers ---------- */

/** URL search param keys for persistent navigation state. */
const PARAM_TAB = 'tab';
const PARAM_RUN = 'run';
const PARAM_TASK = 'task';
const PARAM_EVAL = 'eval';
const PARAM_RUNS = 'runs';

/** Valid tab values for URL parsing. */
const VALID_TABS = new Set<AgentTab>(['runs', 'tasks', 'config', 'comparisons']);

/** Legacy tab ids that redirect to the current tab. */
const TAB_REDIRECTS: Record<string, AgentTab> = {
  evaluations: 'comparisons',
};

interface UrlState {
  tab: AgentTab;
  runId?: string;
  taskId?: string;
  evalId?: string;
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
    evalId: params.get(PARAM_EVAL) ?? undefined,
    compareRunIds: parseRunIds(params.get(PARAM_RUNS)),
  };
}

interface BuildUrlArgs {
  tab: AgentTab;
  runId?: string;
  taskId?: string;
  evalId?: string;
  compareRunIds?: string[];
}

function buildUrlState({ tab, runId, taskId, evalId, compareRunIds }: BuildUrlArgs): URLSearchParams {
  const params = new URLSearchParams();
  if (tab !== 'runs') params.set(PARAM_TAB, tab);
  if (runId) params.set(PARAM_RUN, runId);
  if (taskId) params.set(PARAM_TASK, taskId);
  if (evalId) params.set(PARAM_EVAL, evalId);
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
  const { tab, runId: selectedRunId, taskId: selectedTaskId, evalId: selectedEvalId, compareRunIds } = urlState;
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);

  // Clean-up legacy `?tab=evaluations` on mount (redirect-style — write the
  // canonical tab once so future navigation works, and so URL sharing uses
  // the new name).
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
    nextEvalId?: string,
    nextCompareRunIds?: string[],
  ) => {
    setSearchParams(buildUrlState({
      tab: nextTab,
      runId: nextRunId,
      taskId: nextTaskId,
      evalId: nextEvalId,
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
  } else if (tab === 'comparisons' && !selectedEvalId && !compareRunIds) {
    pageAction = (
      <Button variant="outline" size="sm" className="gap-2" onClick={() => setMatrixOpen(true)}>
        <Layers className="h-3.5 w-3.5" />
        Run matrix
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
              navigateState('comparisons', undefined, undefined, undefined, ids)
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

      {/* Comparisons tab — ad-hoc run set, matrix evaluation, or list view */}
      {tab === 'comparisons' && (() => {
        if (selectedEvalId) {
          return (
            <EvaluationDetail
              evaluationId={selectedEvalId}
              onBack={() => navigateState('comparisons')}
              onOpenRun={(runId) => navigateState('runs', runId)}
            />
          );
        }
        if (compareRunIds && compareRunIds.length > 0) {
          return (
            <AdHocComparison
              runIds={compareRunIds}
              onBack={() => navigateState('comparisons')}
              onOpenRun={(runId) => navigateState('runs', runId)}
            />
          );
        }
        return (
          <EvaluationList
            onSelect={(id) => navigateState('comparisons', undefined, undefined, id)}
          />
        );
      })()}

      {/* Config tab */}
      {tab === 'config' && <AgentConfig />}

      <RunTaskDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        onTriggered={(runId) => navigateState('runs', runId)}
      />

      <MatrixRunDialog
        open={matrixOpen}
        onOpenChange={setMatrixOpen}
        onEvaluationCreated={(evalId) =>
          navigateState('comparisons', undefined, undefined, evalId)
        }
      />
    </div>
  );
}
