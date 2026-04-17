import { AlertCircle, FlaskConical, Loader2 } from 'lucide-react';
import { Badge } from '../ui/badge';
import { useEvaluations } from '../../hooks/use-agent';
import { formatEpochRelative } from '../../lib/format';
import { statusBadgeVariant } from './helpers';
import { cn } from '../../lib/cn';

/* ---------- Helpers ---------- */

/** Compute the number of matrix cells (cartesian product of provided dims). */
function matrixCellCount(matrix: {
  runtimes?: string[];
  reasoningLevels?: string[];
  models?: string[];
} | null): number {
  if (!matrix) return 0;
  const r = matrix.runtimes?.length || 1;
  const l = matrix.reasoningLevels?.length || 1;
  const m = matrix.models?.length || 1;
  return r * l * m;
}

/* ---------- Component ---------- */

export interface EvaluationListProps {
  onSelect: (id: string) => void;
}

export function EvaluationList({ onSelect }: EvaluationListProps) {
  const { data, isLoading, isError, error } = useEvaluations();
  const evaluations = data?.evaluations ?? [];

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-on-surface-variant">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="font-sans">Loading evaluations...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
        <AlertCircle className="h-5 w-5" />
        <span className="font-sans text-sm">Failed to load evaluations</span>
        <span className="font-sans text-xs text-on-surface-variant">
          {error instanceof Error ? error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  if (evaluations.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-md bg-surface-container-low text-on-surface-variant">
        <FlaskConical className="h-10 w-10 opacity-30" />
        <div className="text-center font-sans">
          <p className="text-sm">No evaluations yet</p>
          <p className="text-xs mt-1">
            Create one via <span className="font-mono">myco agent eval</span>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md bg-surface-container-low overflow-hidden">
      <table className="w-full" aria-label="Agent evaluations">
        <thead>
          <tr className="border-b border-outline-variant/20 bg-surface-container/50">
            <th className="px-4 py-3 text-left text-xs font-medium text-on-surface-variant uppercase tracking-widest font-sans">Task</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-on-surface-variant uppercase tracking-widest font-sans">Status</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-on-surface-variant uppercase tracking-widest font-sans">Cells</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-on-surface-variant uppercase tracking-widest font-sans">Created</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-on-surface-variant uppercase tracking-widest font-sans">Completed</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-on-surface-variant uppercase tracking-widest font-sans">Id</th>
          </tr>
        </thead>
        <tbody>
          {evaluations.map((ev) => (
            <tr
              key={ev.id}
              className={cn(
                'border-b border-outline-variant/20 last:border-0',
                'hover:bg-surface-container-high/50 cursor-pointer transition-all duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
                'hover:shadow-[inset_3px_0_0_var(--primary)]',
              )}
              onClick={() => onSelect(ev.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(ev.id);
                }
              }}
              tabIndex={0}
              role="row"
              aria-label={`Evaluation: ${ev.taskId}, status ${ev.status}`}
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <FlaskConical className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
                  <span className="text-sm font-medium text-on-surface">{ev.taskId}</span>
                </div>
              </td>
              <td className="px-4 py-3">
                <Badge variant={statusBadgeVariant(ev.status)}>{ev.status}</Badge>
              </td>
              <td className="px-4 py-3 text-xs text-on-surface-variant font-mono">
                {matrixCellCount(ev.matrix)}
              </td>
              <td className="px-4 py-3 text-xs text-on-surface-variant font-mono">
                {formatEpochRelative(ev.createdAt)}
              </td>
              <td className="px-4 py-3 text-xs text-on-surface-variant font-mono">
                {formatEpochRelative(ev.completedAt)}
              </td>
              <td className="px-4 py-3 text-xs text-on-surface-variant font-mono">
                {ev.id.slice(0, 8)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
