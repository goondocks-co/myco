import { useState } from 'react';
import { CheckCircle2, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useBatchActivities, type ActivityRow } from '../../hooks/use-sessions';
import { formatDurationMs as formatDuration } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Maximum skeleton rows shown during loading. */
const SKELETON_MAX_ROWS = 3;

/* ---------- Sub-components ---------- */

function ActivityItem({ activity }: { activity: ActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  const succeeded = activity.success === 1;
  const hasDetail = Boolean(activity.tool_input || activity.tool_output_summary || activity.error_message);

  return (
    <div className={cn(
      'border-l-2 transition-colors',
      expanded ? 'border-l-primary/30' : 'border-transparent hover:border-l-primary/20',
    )}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container/30 transition-all"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
        )}
        <span className="font-mono text-xs font-medium text-on-surface">
          {activity.tool_name}
        </span>
        {activity.file_path && (
          <span className="truncate font-sans text-xs text-on-surface-variant flex-1">
            {activity.file_path}
          </span>
        )}
        <span className="shrink-0 ml-auto" />
        <span className="shrink-0 font-mono text-xs text-on-surface-variant">
          {formatDuration(activity.duration_ms)}
        </span>
        {succeeded ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-tertiary" />
        )}
      </button>

      {/* Expandable detail — CSS grid for smooth animation */}
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="px-8 pb-3 space-y-2">
            {!hasDetail && (
              <p className="font-sans text-xs text-on-surface-variant/60 italic py-1">
                No input/output details captured
              </p>
            )}
            {activity.tool_input && (
              <div>
                <div className="font-sans text-xs font-medium text-on-surface-variant mb-1">Input</div>
                <pre className="font-mono text-xs bg-surface-container-lowest rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all text-on-surface">
                  {activity.tool_input}
                </pre>
              </div>
            )}
            {activity.tool_output_summary && (
              <div>
                <div className="font-sans text-xs font-medium text-on-surface-variant mb-1">Output</div>
                <pre className="font-mono text-xs bg-surface-container-lowest rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all text-on-surface">
                  {activity.tool_output_summary}
                </pre>
              </div>
            )}
            {activity.error_message && (
              <div>
                <div className="font-sans text-xs font-medium text-tertiary mb-1">Error</div>
                <pre className="font-mono text-xs bg-tertiary/10 text-tertiary rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all">
                  {activity.error_message}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Component ---------- */

export interface ActivityListProps {
  batchId: number;
  activityCount: number;
}

export function ActivityList({ batchId, activityCount }: ActivityListProps) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useBatchActivities(expanded ? batchId : undefined);

  if (activityCount === 0) {
    return null;
  }

  const activities = data ?? [];

  return (
    <div className="border-t border-[var(--ghost-border)]">
      {/* Clickable header — toggles expand/collapse */}
      <button
        type="button"
        className={cn(
          'w-full flex items-center gap-2 px-4 py-2 text-left transition-colors',
          'hover:bg-surface-container/30',
        )}
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
        )}
        <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
          Tool Calls
        </span>
        <span className="font-mono text-[10px] text-on-surface-variant/60">
          {activityCount}
        </span>
      </button>

      {/* Expandable body — CSS grid for smooth animation */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          {/* Loading skeleton */}
          {isLoading && (
            <div className="px-3 py-2 space-y-1">
              {Array.from({ length: Math.min(activityCount, SKELETON_MAX_ROWS) }).map((_, i) => (
                <div key={i} className="h-3 animate-pulse rounded bg-surface-container-high w-full" />
              ))}
            </div>
          )}

          {/* Activity items */}
          {!isLoading && activities.length > 0 && (
            <div className="space-y-0">
              {activities.map((activity) => (
                <ActivityItem key={activity.id} activity={activity} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
