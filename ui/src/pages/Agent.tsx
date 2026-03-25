import { useState } from 'react';
import { Play } from 'lucide-react';
import { Button } from '../components/ui/button';
import { RunList } from '../components/agent/RunList';
import { RunDetail } from '../components/agent/RunDetail';
import { TriggerRun } from '../components/agent/TriggerRun';
import { TaskList } from '../components/agent/TaskList';
import { TaskDetail } from '../components/agent/TaskDetail';

type AgentTab = 'runs' | 'tasks';

export default function Agent() {
  const [tab, setTab] = useState<AgentTab>('runs');
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [triggerOpen, setTriggerOpen] = useState(false);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agent</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Intelligence runs and task configuration
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Tab switcher */}
          <div className="flex gap-1 p-1 rounded-lg bg-muted">
            <button
              onClick={() => { setTab('runs'); setSelectedTaskId(undefined); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === 'runs' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Runs
            </button>
            <button
              onClick={() => { setTab('tasks'); setSelectedRunId(undefined); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === 'tasks' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Tasks
            </button>
          </div>

          {tab === 'runs' && (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setTriggerOpen(true)}>
              <Play className="h-3.5 w-3.5" />
              Run Now
            </Button>
          )}
        </div>
      </div>

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
          />
        ) : (
          <TaskList onSelect={setSelectedTaskId} />
        )
      )}

      <TriggerRun
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        onTriggered={() => setSelectedRunId(undefined)}
      />
    </div>
  );
}
