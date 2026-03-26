import { useState, useEffect, useCallback } from 'react';
import { Play } from 'lucide-react';
import { Button } from '../components/ui/button';
import { PageHeader } from '../components/ui/page-header';
import type { Tab } from '../components/ui/tab-switcher';
import { RunList } from '../components/agent/RunList';
import { RunDetail } from '../components/agent/RunDetail';
import { TriggerRun } from '../components/agent/TriggerRun';
import { TaskList } from '../components/agent/TaskList';
import { TaskDetail } from '../components/agent/TaskDetail';
import { AgentConfig } from '../components/agent/AgentConfig';

type AgentTab = 'runs' | 'tasks' | 'config';

/* ---------- URL state helpers ---------- */

/** URL search param keys for persistent navigation state. */
const PARAM_TAB = 'tab';
const PARAM_RUN = 'run';
const PARAM_TASK = 'task';

/** Valid tab values for URL parsing. */
const VALID_TABS = new Set<AgentTab>(['runs', 'tasks', 'config']);

/** Read initial state from URL search params. */
function readUrlState(): { tab: AgentTab; runId?: string; taskId?: string } {
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get(PARAM_TAB);
  const tab: AgentTab = rawTab && VALID_TABS.has(rawTab as AgentTab)
    ? (rawTab as AgentTab)
    : 'runs';
  return {
    tab,
    runId: params.get(PARAM_RUN) ?? undefined,
    taskId: params.get(PARAM_TASK) ?? undefined,
  };
}

/** Write navigation state to URL search params (replaceState, no history entry). */
function writeUrlState(tab: AgentTab, runId?: string, taskId?: string): void {
  const params = new URLSearchParams();
  if (tab !== 'runs') params.set(PARAM_TAB, tab);
  if (runId) params.set(PARAM_RUN, runId);
  if (taskId) params.set(PARAM_TASK, taskId);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, '', url);
}

/* ---------- Tab definitions ---------- */

const TABS: Tab[] = [
  { id: 'runs', label: 'Runs' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'config', label: 'Config' },
];

/* ---------- Component ---------- */

export default function Agent() {
  const initial = readUrlState();
  const [tab, setTab] = useState<AgentTab>(initial.tab);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(initial.runId);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(initial.taskId);
  const [triggerOpen, setTriggerOpen] = useState(false);

  // Sync URL whenever state changes
  useEffect(() => {
    writeUrlState(tab, selectedRunId, selectedTaskId);
  }, [tab, selectedRunId, selectedTaskId]);

  const switchTab = useCallback((id: string) => {
    const t = id as AgentTab;
    setTab(t);
    if (t !== 'runs') setSelectedRunId(undefined);
    if (t !== 'tasks') setSelectedTaskId(undefined);
  }, []);

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="Agent"
        subtitle="Intelligence runs, task configuration, and operational settings"
        tabs={TABS}
        activeTab={tab}
        onTabChange={switchTab}
        actions={
          tab === 'runs' ? (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setTriggerOpen(true)}>
              <Play className="h-3.5 w-3.5" />
              Run Now
            </Button>
          ) : undefined
        }
      />

      {/* Runs tab */}
      {tab === 'runs' && (
        selectedRunId ? (
          <RunDetail runId={selectedRunId} onBack={() => setSelectedRunId(undefined)} />
        ) : (
          <RunList onSelectRun={setSelectedRunId} onTriggerRun={() => setTriggerOpen(true)} />
        )
      )}

      {/* Tasks tab */}
      {tab === 'tasks' && (
        selectedTaskId ? (
          <TaskDetail
            taskId={selectedTaskId}
            onBack={() => setSelectedTaskId(undefined)}
            onNavigate={setSelectedTaskId}
            onRunTriggered={(runId) => {
              setSelectedTaskId(undefined);
              setTab('runs');
              if (runId) setSelectedRunId(runId);
            }}
          />
        ) : (
          <TaskList onSelect={setSelectedTaskId} />
        )
      )}

      {/* Config tab */}
      {tab === 'config' && <AgentConfig />}

      <TriggerRun
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        onTriggered={() => setSelectedRunId(undefined)}
      />
    </div>
  );
}
