/**
 * EvaluationDetail renders a matrix-backed Comparison. The matrix metadata
 * (dimensions, notes) is an evaluation-specific overlay; everything below
 * it is a general comparison over the child runs, rendered by the shared
 * `<ComparisonView />`.
 *
 * The user-facing vocabulary for this tab is "Comparisons"; the internal
 * `agent_run_evaluations` table and API routes keep the "evaluation" name
 * for matrix-origin records (see the product pivot notes).
 */

import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { useAgentTasks, useEvaluation } from '../../hooks/use-agent';
import { formatEpochRelative } from '../../lib/format';
import { statusBadgeVariant } from './helpers';
import { ComparisonView } from './ComparisonView';

/* ---------- Types ---------- */

export interface EvaluationDetailProps {
  evaluationId: string;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}

/* ---------- Component ---------- */

/**
 * Build a compact human label for the matrix that serves as the
 * ComparisonView subtitle. Empty matrix collapses to the default cell
 * count.
 */
function matrixLabel(matrix: {
  runtimes?: string[] | null;
  reasoningLevels?: string[] | null;
  models?: string[] | null;
} | null | undefined): string {
  if (!matrix) return '';
  const parts: string[] = [];
  if (matrix.runtimes && matrix.runtimes.length > 0) {
    parts.push(`${matrix.runtimes.length} runtimes`);
  }
  if (matrix.reasoningLevels && matrix.reasoningLevels.length > 0) {
    parts.push(`${matrix.reasoningLevels.length} reasoning`);
  }
  if (matrix.models && matrix.models.length > 0) {
    parts.push(`${matrix.models.length} models`);
  }
  return parts.join(' × ');
}

export function EvaluationDetail({ evaluationId, onBack, onOpenRun }: EvaluationDetailProps) {
  const { data, isLoading, isError, error } = useEvaluation(evaluationId);
  const { data: tasksData } = useAgentTasks();

  const evaluation = data?.evaluation;
  const runs = data?.runs ?? [];
  const aggregate = data?.aggregate;
  const matrix = evaluation?.matrix ?? null;

  // Render the task display name when the registry knows it; fall back to the
  // raw id so evaluations from a task that has since been deleted still render
  // something meaningful.
  const taskDisplayName = evaluation
    ? (tasksData?.tasks ?? []).find((t) => t.name === evaluation.taskId)?.displayName
      ?? evaluation.taskId
    : '';

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-on-surface-variant">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="font-sans">Loading evaluation...</span>
      </div>
    );
  }

  if (isError || !evaluation) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          Comparisons
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Evaluation not found</span>
          {error && (
            <span className="font-sans text-xs text-on-surface-variant">
              {error instanceof Error ? error.message : 'Unknown error'}
            </span>
          )}
        </div>
      </div>
    );
  }

  const subtitle = matrixLabel(matrix) || `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`;

  const metadataSlot = (
    <Surface level="low" className="p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-serif text-lg text-on-surface">{taskDisplayName}</span>
        <Badge variant={statusBadgeVariant(evaluation.status)}>{evaluation.status}</Badge>
        {matrix?.dryRun && <Badge variant="warning">Dry run</Badge>}
      </div>
      <div className="flex flex-wrap gap-4 font-mono text-xs text-on-surface-variant">
        <span>id: <span className="text-on-surface">{evaluation.id.slice(0, 8)}</span></span>
        <span>created: <span className="text-on-surface">{formatEpochRelative(evaluation.createdAt)}</span></span>
        <span>completed: <span className="text-on-surface">{formatEpochRelative(evaluation.completedAt)}</span></span>
      </div>
      {matrix && (
        <div className="flex flex-wrap gap-4 font-mono text-xs text-on-surface-variant">
          {matrix.runtimes && <span>runtimes: {matrix.runtimes.join(', ')}</span>}
          {matrix.reasoningLevels && <span>reasoning: {matrix.reasoningLevels.join(', ')}</span>}
          {matrix.models && <span>models: {matrix.models.join(', ')}</span>}
        </div>
      )}
      {evaluation.notes && (
        <p className="font-sans text-sm text-on-surface-variant whitespace-pre-wrap">
          {evaluation.notes}
        </p>
      )}
    </Surface>
  );

  return (
    <ComparisonView
      runs={runs}
      aggregate={aggregate}
      onBack={onBack}
      onOpenRun={onOpenRun}
      title={`Evaluation ${evaluation.id.slice(0, 8)}`}
      subtitle={subtitle}
      metadataSlot={metadataSlot}
      backLabel="Comparisons"
    />
  );
}
