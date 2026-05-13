import { forwardRef, memo, useCallback, useMemo, useRef, useState } from 'react';
import { Bot, AlertCircle, Play, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
import { CompareBar } from '../ui/compare-bar';
import { ListToolbar, type FilterDefinition } from '../ui/list-toolbar';
import { Pagination } from '../ui/pagination';
import { useAgentRuns, useAgentTasks, type RunRow } from '../../hooks/use-agent';
import { RunTaskDialog } from './RunTaskDialog';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { useListKeyboardNav } from '../../hooks/use-list-keyboard-nav';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import { cn } from '../../lib/cn';
import { formatEpochRelative, capitalize } from '../../lib/format';
import { statusBadgeVariant, formatCost, formatTokens, formatDuration, UNKNOWN_TASK_LABEL } from './helpers';

/* ---------- Constants ---------- */

const RUN_STATUS_OPTIONS = [
  { value: FILTER_ALL, label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

/* ---------- Sub-components ---------- */

function RunStatusBadge({ status }: { status: string }) {
  const variant = statusBadgeVariant(status);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold',
        variant === 'default' ? 'bg-primary-container/20 text-primary' :
        variant === 'destructive' ? 'bg-tertiary-container/20 text-tertiary' :
        variant === 'warning' ? 'bg-secondary-container/20 text-secondary' :
        'bg-surface-container-high text-on-surface-variant',
      )}
    >
      {capitalize(status)}
    </span>
  );
}

function SkeletonRailRow() {
  return (
    <div className="border-b border-outline-variant/20 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="h-4 w-4 animate-pulse rounded bg-surface-container shrink-0" />
        <div className="h-4 w-4 animate-pulse rounded bg-surface-container shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-surface-container" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-surface-container" />
        </div>
      </div>
    </div>
  );
}

interface RunRailRowProps {
  run: RunRow;
  /** Called with the run id so callers don't allocate a new closure per row. */
  onSelectRun: (id: string) => void;
  taskNameMap: Map<string, string>;
  selected: boolean;
  onToggleSelected: (id: string) => void;
  onRerun: (run: RunRow) => void;
  isActive: boolean;
  isCursor: boolean;
}

const RunRailRow = memo(forwardRef<HTMLDivElement, RunRailRowProps>(function RunRailRow({
  run,
  onSelectRun,
  taskNameMap,
  selected,
  onToggleSelected,
  onRerun,
  isActive,
  isCursor,
}, ref) {
  const onClick = useCallback(() => onSelectRun(run.id), [onSelectRun, run.id]);
  const taskLabel = run.task ? taskNameMap.get(run.task) ?? run.task : UNKNOWN_TASK_LABEL;

  return (
    <div
      ref={ref}
      data-selected={isActive || undefined}
      data-cursor={isCursor || undefined}
      className={cn(
        'group border-b border-outline-variant/20 last:border-0 px-4 py-3 cursor-pointer transition-all duration-150',
        'hover:bg-surface-container-high/50 hover:shadow-[inset_3px_0_0_var(--primary)]',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
        isActive && 'bg-surface-container-high shadow-[inset_3px_0_0_var(--primary)]',
        isCursor && !isActive && 'bg-surface-container/40 ring-2 ring-inset ring-primary/30',
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      role="row"
      aria-selected={isActive}
      aria-label={`Agent run: ${taskLabel}, status ${run.status}`}
    >
      <div className="flex items-start gap-3">
        {/* Compare checkbox */}
        <div
          className="pt-1 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            aria-label={`Select run ${run.id.slice(0, 8)}`}
            checked={selected}
            onChange={() => onToggleSelected(run.id)}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 rounded accent-primary cursor-pointer"
          />
        </div>

        <Bot className="h-4 w-4 shrink-0 text-on-surface-variant mt-0.5" />

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Top line: task label + flags */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-on-surface truncate">
              {taskLabel}
            </span>
            {run.dry_run && (
              <span
                className="inline-flex items-center rounded-xs bg-secondary/15 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide text-secondary shrink-0"
                title="Dry run — writes were intercepted, no vault mutations"
              >
                Dry
              </span>
            )}
          </div>

          {/* Status line */}
          <div className="flex items-center gap-2">
            <RunStatusBadge status={run.status} />
            {run.resumable && run.status === 'failed' && (
              <span className="font-sans text-[10px] uppercase tracking-wide text-secondary">resumable</span>
            )}
            {run.cost_source === 'estimated' && (
              <span className="font-sans text-[10px] uppercase tracking-wide text-secondary">est</span>
            )}
          </div>

          {/* Meta line: started · duration · tokens · cost */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant font-mono">
            <span>{formatEpochRelative(run.started_at)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDuration(run.started_at, run.completed_at)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatTokens(run.tokens_used)} tok</span>
            <span aria-hidden="true">·</span>
            <span>{formatCost(run.cost_usd, run.cost_source)}</span>
          </div>
        </div>

        {/* Rerun action */}
        <div
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-on-surface-variant hover:text-on-surface opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              onRerun(run);
            }}
            title="Rerun with same settings"
            aria-label={`Rerun ${run.id.slice(0, 8)} with same settings`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}));

/* ---------- Component ---------- */

export interface RunListProps {
  /** When set, the row with this run id renders as active. Also seeds the
   *  keyboard-nav cursor so j/k continues from the selection. */
  selectedId?: string;
  onSelectRun: (id: string) => void;
  onTriggerRun: () => void;
  /** Navigates to an ad-hoc comparison over the selected run ids. */
  onCompareRuns: (ids: string[]) => void;
}

export function RunList({ selectedId, onSelectRun, onTriggerRun, onCompareRuns }: RunListProps) {
  const filterInputRef = useRef<HTMLInputElement>(null);
  const { searchInput, debouncedSearch, filterValues, offset, setOffset, handleSearchChange, handleFilterChange, activeFilter } = useListFilters({
    initialFilters: { status: FILTER_ALL, task: FILTER_ALL },
  });

  // Run-selection state for multi-run compare. Selection is transient —
  // scoped to this mount of the RunList. Leaving the list (navigating to a
  // run detail, the comparison view, etc.) unmounts the component and wipes
  // selection, matching the plan's "selection clears when the user leaves"
  // behavior without any extra lifecycle wiring.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // "Rerun with same settings" state. When non-null, RunTaskDialog opens
  // pre-filled from this run so the operator can review and edit before
  // submitting a NEW run. The source run itself is never mutated.
  const [rerunSource, setRerunSource] = useState<RunRow | null>(null);

  const { data: tasksData } = useAgentTasks();
  const taskNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasksData?.tasks ?? []) {
      map.set(task.name, task.displayName);
    }
    return map;
  }, [tasksData]);

  const taskFilterOptions = useMemo(() => {
    const opts = [{ value: FILTER_ALL, label: 'All tasks' }];
    for (const task of tasksData?.tasks ?? []) {
      opts.push({ value: task.name, label: task.displayName });
    }
    return opts;
  }, [tasksData]);

  const filters: FilterDefinition[] = useMemo(() => [
    { key: 'status', label: 'Status', options: RUN_STATUS_OPTIONS },
    { key: 'task', label: 'Task', options: taskFilterOptions },
  ], [taskFilterOptions]);

  const activeStatus = activeFilter('status');
  const activeTask = activeFilter('task');

  const { data, isLoading, isError, error } = useAgentRuns({
    limit: DEFAULT_PAGE_SIZE,
    offset,
    search: debouncedSearch,
    status: activeStatus,
    task: activeTask,
  });

  const runs = data?.runs ?? [];
  const total = data?.total ?? 0;

  const nav = useListKeyboardNav({
    items: runs,
    getId: (r) => r.id,
    selectedId,
    onActivate: (id) => onSelectRun(id),
    filterInputRef,
  });

  const toolbar = (
    <ListToolbar
      searchPlaceholder="Search runs..."
      searchValue={searchInput}
      onSearchChange={handleSearchChange}
      filters={filters}
      filterValues={filterValues}
      onFilterChange={handleFilterChange}
      inputRef={filterInputRef}
    />
  );

  if (isError) {
    return (
      <div className="p-4 space-y-4">
        {toolbar}
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load runs</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {toolbar}

      {isLoading ? (
        <div className="rounded-md bg-surface-container-low overflow-hidden">
          {[1, 2, 3].map((i) => <SkeletonRailRow key={i} />)}
        </div>
      ) : runs.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-md bg-surface-container-low text-on-surface-variant">
          <Bot className="h-10 w-10 opacity-30" />
          <div className="text-center font-sans">
            <p className="text-sm">
              {total === 0 && !debouncedSearch && !activeStatus && !activeTask
                ? 'No agent runs yet'
                : 'No matching runs'}
            </p>
            {total === 0 && !debouncedSearch && !activeStatus && !activeTask && (
              <p className="text-xs mt-1">Trigger the first run to see the agent at work</p>
            )}
          </div>
          {total === 0 && !debouncedSearch && !activeStatus && !activeTask && (
            <Button variant="outline" size="sm" className="gap-2 mt-2" onClick={onTriggerRun}>
              <Play className="h-3.5 w-3.5" />
              Run Now
            </Button>
          )}
        </div>
      ) : (
        <div
          {...nav.containerProps}
          role="group"
          aria-label="Agent run list keyboard navigation"
          className="rounded-md bg-surface-container-low overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
        >
          {runs.map((run, idx) => (
            <RunRailRow
              key={run.id}
              ref={nav.setRowRef(idx)}
              run={run}
              taskNameMap={taskNameMap}
              selected={selected.has(run.id)}
              onToggleSelected={toggleSelected}
              onSelectRun={onSelectRun}
              onRerun={setRerunSource}
              isActive={selectedId === run.id}
              isCursor={nav.cursorIndex === idx}
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

      <CompareBar
        selectedCount={selected.size}
        onClear={clearSelection}
        onCompare={() => onCompareRuns([...selected])}
      />

      {/* "Rerun with same settings" dialog — opens pre-filled from rerunSource.
          Conditionally mounted so the dialog's hook subscriptions
          (useAgentTasks, useProviders, useScopedConfig, etc.) only run when
          the operator actually triggers a rerun. */}
      {rerunSource !== null && (
        <RunTaskDialog
          open
          onOpenChange={(next) => { if (!next) setRerunSource(null); }}
          sourceRun={rerunSource}
        />
      )}
    </div>
  );
}
