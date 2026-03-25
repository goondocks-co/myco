# Dashboard Task Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a task management interface to the Myco dashboard where users can view, create, edit, copy, and run intelligence tasks with full phase visualization.

**Architecture:** Extends the existing Agent page with a task-centric view. Tasks are fetched from the Plan 1 API routes (`GET/POST/DELETE /api/agent/tasks`). The UI shows built-in tasks as read-only references and user tasks as editable. Run detail view shows per-phase execution results from the phased executor.

**Tech Stack:** React 19, Tailwind CSS, TanStack Query, Radix UI, Vite

**Depends on:** Plan 1 (Agent Task System) — requires task CRUD API routes

**Reference:** Existing dashboard at `ui/src/` — Agent page (`pages/Agent.tsx`), agent hooks (`hooks/use-agent.ts`), agent components (`components/agent/`)

---

## Design Decisions

### Task management extends the Agent page, not a separate page

The Agent page already shows runs. We add a "Tasks" tab alongside the existing "Runs" view. This keeps agent configuration and execution in one place.

### Built-in tasks are read-only with a "Customize" action

Users can view built-in task definitions (phases, tools, prompts) but cannot edit them. A "Customize" button copies the built-in task to user tasks for editing. This matches OAK's copy-to-customize pattern.

### Phase visualization on run detail

When a run has `phases` in its result, the RunDetail component shows a phase timeline: each phase as a card with status badge, turn count, token usage, and summary. This replaces the flat turn list for phased runs.

### YAML editor for task prompts

Task editing uses a monospace textarea for prompt content and a structured form for metadata (name, model, turns, timeout). Phase editing is YAML-based — a code editor for the phases array. This avoids building a complex phase form builder.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `ui/src/components/agent/TaskList.tsx` | Table of all tasks (built-in + user) with actions |
| `ui/src/components/agent/TaskDetail.tsx` | Task detail view — config, phases, prompts |
| `ui/src/components/agent/TaskEditor.tsx` | Form for creating/editing user tasks |
| `ui/src/components/agent/PhaseTimeline.tsx` | Per-phase run visualization |
| `ui/src/components/agent/TaskActions.tsx` | Run, Copy, Delete action buttons |

### Modified Files

| File | Changes |
|------|---------|
| `ui/src/pages/Agent.tsx` | Add tabs: "Runs" / "Tasks", route to TaskList |
| `ui/src/hooks/use-agent.ts` | Add `useTask`, `useCreateTask`, `useCopyTask`, `useDeleteTask` hooks |
| `ui/src/components/agent/RunDetail.tsx` | Add PhaseTimeline when run has phases |
| `ui/src/components/agent/helpers.ts` | Add phase status colors, task source badge |

---

## Task 1: Agent Hook Extensions

**Files:**
- Modify: `ui/src/hooks/use-agent.ts`

- [ ] **Step 1: Add task detail hook**

```typescript
/** Fetch a single task definition by ID. */
export function useTask(taskId: string | undefined) {
  return useQuery({
    queryKey: ['agent-task', taskId],
    queryFn: () => api.get<{ task: TaskRow }>(`/agent/tasks/${taskId}`).then(r => r.task),
    enabled: !!taskId,
    staleTime: TASK_STALE_TIME,
  });
}
```

Add `TASK_STALE_TIME = 60_000` constant.

- [ ] **Step 2: Add task mutation hooks**

```typescript
/** Create a new user task. */
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (task: CreateTaskPayload) => api.post('/agent/tasks', task),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-tasks'] }),
  });
}

/** Copy a task to user tasks. */
export function useCopyTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, name }: { taskId: string; name?: string }) =>
      api.post(`/agent/tasks/${taskId}/copy`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-tasks'] }),
  });
}

/** Delete a user task. */
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.delete(`/agent/tasks/${taskId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-tasks'] }),
  });
}
```

- [ ] **Step 3: Add TypeScript types for new API shapes**

```typescript
export interface CreateTaskPayload {
  name: string;
  displayName: string;
  description: string;
  agent: string;
  prompt: string;
  isDefault: boolean;
  phases?: PhaseDefinition[];
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
}

export interface PhaseDefinition {
  name: string;
  prompt: string;
  tools: string[];
  maxTurns: number;
  model?: string;
  required: boolean;
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/hooks/use-agent.ts
git commit -m "feat(ui): add task CRUD hooks — useTask, useCreateTask, useCopyTask, useDeleteTask"
```

---

## Task 2: TaskList Component

**Files:**
- Create: `ui/src/components/agent/TaskList.tsx`
- Modify: `ui/src/components/agent/helpers.ts`

- [ ] **Step 1: Add task helper functions**

In `helpers.ts`:

```typescript
/** Badge classes for task source. */
export function taskSourceClass(source: string): string {
  return source === 'user'
    ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
    : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
}

/** Format phase count for display. */
export function formatPhaseCount(phases: unknown[] | null | undefined): string {
  if (!phases || phases.length === 0) return 'Single query';
  return `${phases.length} phases`;
}
```

- [ ] **Step 2: Create TaskList component**

```tsx
// ui/src/components/agent/TaskList.tsx
import { useAgentTasks } from '@/hooks/use-agent';
import { taskSourceClass, formatPhaseCount } from './helpers';

export function TaskList({ onSelect }: { onSelect: (taskId: string) => void }) {
  const { data: tasks, isLoading } = useAgentTasks();

  if (isLoading) return <TaskListSkeleton />;

  return (
    <div className="space-y-2">
      {tasks?.map(task => (
        <button
          key={task.id}
          onClick={() => onSelect(task.id)}
          className="w-full text-left p-4 rounded-lg border hover:bg-accent/50 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="font-medium">{task.display_name}</span>
              <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${taskSourceClass(task.source)}`}>
                {task.source}
              </span>
            </div>
            <span className="text-sm text-muted-foreground">
              {formatPhaseCount(task.config?.phases)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{task.description}</p>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/agent/TaskList.tsx ui/src/components/agent/helpers.ts
git commit -m "feat(ui): add TaskList component with source badges and phase counts"
```

---

## Task 3: TaskDetail Component

**Files:**
- Create: `ui/src/components/agent/TaskDetail.tsx`
- Create: `ui/src/components/agent/TaskActions.tsx`

- [ ] **Step 1: Create TaskActions component**

Action buttons: Run Now, Customize (copy), Delete (user tasks only).

```tsx
export function TaskActions({ task, onRun, onCopy, onDelete }: TaskActionsProps) {
  return (
    <div className="flex gap-2">
      <Button onClick={onRun} size="sm">Run Now</Button>
      {task.source === 'built-in' && (
        <Button onClick={onCopy} variant="outline" size="sm">Customize</Button>
      )}
      {task.source === 'user' && (
        <Button onClick={onDelete} variant="destructive" size="sm">Delete</Button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create TaskDetail component**

Shows task metadata, execution config, and phase definitions:

```tsx
export function TaskDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const { data: task, isLoading } = useTask(taskId);
  const triggerRun = useTriggerRun();
  const copyTask = useCopyTask();
  const deleteTask = useDeleteTask();

  if (isLoading || !task) return <Skeleton />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground">Back to tasks</button>
        <TaskActions
          task={task}
          onRun={() => triggerRun.mutate({ task: task.id })}
          onCopy={() => copyTask.mutate({ taskId: task.id })}
          onDelete={() => deleteTask.mutate(task.id)}
        />
      </div>

      <div>
        <h2 className="text-xl font-semibold">{task.display_name}</h2>
        <p className="text-muted-foreground">{task.description}</p>
      </div>

      {/* Execution Config */}
      <section>
        <h3 className="font-medium mb-2">Execution</h3>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div><dt className="text-muted-foreground">Model</dt><dd>{task.model ?? 'default'}</dd></div>
          <div><dt className="text-muted-foreground">Max Turns</dt><dd>{task.max_turns ?? 'default'}</dd></div>
          <div><dt className="text-muted-foreground">Timeout</dt><dd>{task.timeout_seconds ?? 'default'}s</dd></div>
        </dl>
      </section>

      {/* Phases */}
      {task.config?.phases && (
        <section>
          <h3 className="font-medium mb-2">Phases ({task.config.phases.length})</h3>
          <div className="space-y-2">
            {task.config.phases.map((phase, i) => (
              <div key={phase.name} className="p-3 rounded border text-sm">
                <div className="flex justify-between">
                  <span className="font-medium">{i + 1}. {phase.name}</span>
                  <span className="text-muted-foreground">
                    {phase.maxTurns} turns
                    {phase.required && ' (required)'}
                  </span>
                </div>
                <div className="text-muted-foreground mt-1">
                  Tools: {phase.tools.join(', ')}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Prompt */}
      <section>
        <h3 className="font-medium mb-2">Prompt</h3>
        <pre className="p-3 rounded border bg-muted text-sm whitespace-pre-wrap font-mono">
          {task.prompt}
        </pre>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/agent/TaskDetail.tsx ui/src/components/agent/TaskActions.tsx
git commit -m "feat(ui): add TaskDetail and TaskActions components"
```

---

## Task 4: PhaseTimeline Component

**Files:**
- Create: `ui/src/components/agent/PhaseTimeline.tsx`
- Modify: `ui/src/components/agent/RunDetail.tsx`

- [ ] **Step 1: Create PhaseTimeline component**

Visual timeline of phase execution results:

```tsx
export function PhaseTimeline({ phases }: { phases: PhaseResult[] }) {
  return (
    <div className="space-y-3">
      <h3 className="font-medium">Phase Execution</h3>
      {phases.map((phase, i) => (
        <div key={phase.name} className="flex items-start gap-3">
          {/* Step indicator */}
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
            ${phase.status === 'completed' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
              phase.status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' :
              'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'}`}>
            {i + 1}
          </div>

          {/* Phase details */}
          <div className="flex-1 p-3 rounded border">
            <div className="flex justify-between items-center">
              <span className="font-medium">{phase.name}</span>
              <div className="flex gap-3 text-sm text-muted-foreground">
                <span>{phase.turnsUsed} turns</span>
                <span>{formatTokens(phase.tokensUsed)} tokens</span>
                <span>{formatCost(phase.costUsd)}</span>
              </div>
            </div>
            {phase.summary && (
              <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{phase.summary}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Integrate PhaseTimeline into RunDetail**

In `RunDetail.tsx`, check if the run result has phases and render the timeline:

```tsx
// After the existing run metadata section:
{run.phases && run.phases.length > 0 && (
  <PhaseTimeline phases={run.phases} />
)}
```

Note: The `phases` data needs to be available on the run response. This requires the executor to store phase results. Currently `AgentRunResult.phases` exists in the type but isn't persisted to DB. Two options:
- Store `phases` JSON in `agent_runs.actions_taken` column (already exists, currently unused)
- Return phases from a new API endpoint

Use `actions_taken` column — it's the right place for structured run output.

- [ ] **Step 3: Update run API to persist and return phases**

In `executor.ts`, when a phased run completes, serialize `phaseResults` into `actions_taken`:

```typescript
await updateRunStatus(runId, STATUS_COMPLETED, {
  completed_at: completedAt,
  tokens_used: tokensUsed,
  cost_usd: costUsd,
  actions_taken: JSON.stringify({ phases: phaseResults }),
});
```

In `use-agent.ts`, parse `actions_taken` when available:

```typescript
export interface RunRow {
  // ... existing fields ...
  actions_taken: string | null;  // JSON with { phases: PhaseResult[] }
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/agent/PhaseTimeline.tsx ui/src/components/agent/RunDetail.tsx \
  ui/src/hooks/use-agent.ts src/agent/executor.ts
git commit -m "feat(ui): add PhaseTimeline component, persist phase results in run record"
```

---

## Task 5: Agent Page Tabs (Runs / Tasks)

**Files:**
- Modify: `ui/src/pages/Agent.tsx`

- [ ] **Step 1: Add tab navigation to Agent page**

Replace the current flat layout with a tabbed interface:

```tsx
export default function AgentPage() {
  const [tab, setTab] = useState<'runs' | 'tasks'>('runs');
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 p-1 rounded-lg bg-muted">
          <button
            onClick={() => { setTab('runs'); setSelectedTaskId(undefined); }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors
              ${tab === 'runs' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Runs
          </button>
          <button
            onClick={() => { setTab('tasks'); setSelectedRunId(undefined); }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors
              ${tab === 'tasks' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Tasks
          </button>
        </div>

        {tab === 'runs' && <TriggerRunButton />}
      </div>

      {tab === 'runs' && (
        selectedRunId
          ? <RunDetail runId={selectedRunId} onBack={() => setSelectedRunId(undefined)} />
          : <RunList onSelect={setSelectedRunId} />
      )}

      {tab === 'tasks' && (
        selectedTaskId
          ? <TaskDetail taskId={selectedTaskId} onBack={() => setSelectedTaskId(undefined)} />
          : <TaskList onSelect={setSelectedTaskId} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify in dev mode**

```bash
cd ui && MYCO_DAEMON_PORT=<port> npx vite dev
```

Navigate to the Agent page, verify tabs switch between Runs and Tasks views.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/Agent.tsx
git commit -m "feat(ui): add Runs/Tasks tabs to Agent page"
```

---

## Task 6: Build and Quality Gate

- [ ] **Step 1: Run `make check`**

Expected: All backend tests pass

- [ ] **Step 2: Run `make build`**

Expected: Both tsup (backend) and vite build (frontend) succeed

- [ ] **Step 3: Visual verification**

Start daemon, open dashboard, verify:
- Tasks tab shows all 7 built-in tasks
- Task detail shows phases, tools, prompt
- Run detail shows PhaseTimeline for phased runs
- "Customize" on built-in creates user copy
- "Delete" on user task removes it

- [ ] **Step 4: Commit any fixes**

---

## Summary

| Task | What it delivers | Depends on |
|------|-----------------|------------|
| 1. Agent Hooks | Task CRUD mutations + queries | Plan 1 API |
| 2. TaskList | Browseable task list with source badges | Task 1 |
| 3. TaskDetail + Actions | Task inspection, Run/Copy/Delete | Task 1 |
| 4. PhaseTimeline | Per-phase run visualization | — |
| 5. Agent Page Tabs | Runs/Tasks tab navigation | Tasks 2, 3, 4 |
| 6. Quality Gate | Build + visual verification | All |

**After this plan:** The dashboard provides full task management — users can browse built-in tasks, customize them, create new ones, and see per-phase execution results. Combined with Plans 1 and 2, this completes the agent orchestrator system.
