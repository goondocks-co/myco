import { Activity } from 'lucide-react';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import { formatTimeAgo } from '../../lib/format';
import {
  useProjectsActivity,
  type ProjectActivityRow,
} from '../../hooks/use-maintenance-summary';
import { OperationsCard, OperationsRow } from './OperationsCard';

function ProjectRow({ row }: { row: ProjectActivityRow }) {
  return (
    <OperationsRow
      primary={
        <>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-on-surface truncate">{row.project_name}</span>
            <Badge
              variant="outline"
              className={cn(
                'px-1.5 py-0 text-[10px] uppercase',
                row.is_active
                  ? 'border-primary text-primary'
                  : 'border-on-surface-variant text-on-surface-variant',
              )}
            >
              {row.is_active ? 'active' : 'cold'}
            </Badge>
          </div>
          <p className="font-sans text-xs text-on-surface-variant truncate" title={row.project_root}>
            {row.project_root}
          </p>
        </>
      }
      meta={
        <>
          <span className="text-on-surface-variant">
            last activity: {row.last_activity_at ? formatTimeAgo(row.last_activity_at) : 'never'}
          </span>
          <span className="text-on-surface-variant">
            {row.scheduled_runs_last_24h} run{row.scheduled_runs_last_24h === 1 ? '' : 's'} / 24h
          </span>
        </>
      }
    />
  );
}

export function ProjectsActivityCard() {
  const { data, isLoading, isError, error } = useProjectsActivity();
  const errorObj = isError ? (error instanceof Error ? error : new Error('unknown error')) : null;

  const activeCount = data?.projects.filter((p) => p.is_active).length ?? 0;
  const coldCount = (data?.projects.length ?? 0) - activeCount;

  return (
    <OperationsCard
      title="Project Activity"
      scope="all-groves"
      loading={isLoading}
      error={errorObj}
      empty={!!data && data.projects.length === 0}
      emptyText="No projects are registered yet."
      meta={
        data && (
          <div className="flex items-center gap-1.5 font-sans text-xs text-on-surface-variant">
            <Activity className="h-3.5 w-3.5" />
            window: {data.active_window_days}d
          </div>
        )
      }
    >
      {data && (
        <>
          <div className="flex flex-wrap gap-4 font-sans text-xs">
            <span className="flex items-center gap-1.5">
              <span className="text-on-surface-variant">Active</span>
              <span className="font-mono text-primary">{activeCount}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-on-surface-variant">Cold</span>
              <span className="font-mono text-on-surface-variant">{coldCount}</span>
            </span>
          </div>

          <div className="space-y-2">
            {data.projects.map((row) => (
              <ProjectRow key={`${row.grove_id}:${row.project_id}`} row={row} />
            ))}
          </div>

          <p className="font-sans text-xs text-on-surface-variant">
            Cold projects skip scheduled agent tasks. Configure the window in
            Settings under <span className="font-mono">agent.cold_project_threshold_days</span>.
          </p>
        </>
      )}
    </OperationsCard>
  );
}
