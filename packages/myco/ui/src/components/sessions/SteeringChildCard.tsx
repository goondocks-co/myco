import type { BatchRow } from '../../hooks/use-sessions';
import { ActivityList } from './ActivityList';
import { formatTimestamp } from './batch-timeline-helpers';

export interface SteeringChildCardProps {
  child: BatchRow;
}

/**
 * Renders a single steering or interrupt child batch nested beneath its parent
 * in the PromptBatchCard expanded body.
 */
export function SteeringChildCard({ child }: SteeringChildCardProps) {
  return (
    <div className="mt-3 border-l-2 border-primary/30 pl-4 pb-3 mx-4">
      <div className="font-sans text-[10px] font-medium uppercase tracking-widest text-primary/70 mb-1">
        {child.kind === 'interrupt' ? '⚠ interrupt' : '↳ steering'}
      </div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant shrink-0">
          Prompt
        </span>
        {child.started_at && (
          <span className="shrink-0 font-mono text-xs text-on-surface-variant">
            {formatTimestamp(child.started_at)}
          </span>
        )}
      </div>
      <p className="font-sans text-sm text-on-surface whitespace-pre-wrap">
        {child.user_prompt ?? '(no prompt)'}
      </p>
      {child.activity_count > 0 && (
        <ActivityList batchId={child.id} activityCount={child.activity_count} />
      )}
    </div>
  );
}
