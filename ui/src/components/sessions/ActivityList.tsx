import { useState } from 'react';
import { CheckCircle2, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useBatchActivities, type ActivityRow } from '../../hooks/use-sessions';
import { formatDurationMs as formatDuration } from '../../lib/format';

/* ---------- Constants ---------- */

/** Maximum skeleton rows shown during loading. */
const SKELETON_MAX_ROWS = 3;

/* ---------- Sub-components ---------- */

function ActivityItem({ activity }: { activity: ActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  const succeeded = activity.success === 1;

  return (
    <div>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:brightness-110 dark:hover:brightness-[1.04] transition-all"
        onClick={() => setExpanded((prev) => !prev)}
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
        <span className="shrink-0 font-mono text-xs text-on-surface-variant">
          {formatDuration(activity.duration_ms)}
        </span>
        {succeeded ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-tertiary" />
        )}
      </button>

      {expanded && (
        <div className="px-8 pb-3 space-y-2">
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
      )}
    </div>
  );
}

/* ---------- Component ---------- */

export interface ActivityListProps {
  batchId: number;
  activityCount: number;
}

export function ActivityList({ batchId, activityCount }: ActivityListProps) {
  const [loaded, setLoaded] = useState(false);
  const { data, isLoading } = useBatchActivities(loaded ? batchId : undefined);

  if (activityCount === 0) {
    return (
      <div className="px-3 py-2 font-sans text-xs text-on-surface-variant">No tool calls recorded</div>
    );
  }

  if (!loaded) {
    return (
      <button
        type="button"
        className="w-full px-3 py-2 font-sans text-xs text-on-surface-variant hover:text-on-surface hover:brightness-110 dark:hover:brightness-[1.04] transition-all text-left"
        onClick={() => setLoaded(true)}
      >
        Load {activityCount} tool call{activityCount !== 1 ? 's' : ''}...
      </button>
    );
  }

  if (isLoading) {
    return (
      <div className="px-3 py-2 space-y-1">
        {Array.from({ length: Math.min(activityCount, SKELETON_MAX_ROWS) }).map((_, i) => (
          <div key={i} className="h-3 animate-pulse rounded bg-surface-container-high w-full" />
        ))}
      </div>
    );
  }

  const activities = data ?? [];

  return (
    <div className="space-y-0.5">
      {activities.map((activity) => (
        <ActivityItem key={activity.id} activity={activity} />
      ))}
      {/* Collapse toggle */}
      <button
        type="button"
        className="w-full px-3 py-2 font-sans text-xs text-on-surface-variant hover:text-on-surface transition-colors text-left"
        onClick={() => setLoaded(false)}
      >
        Hide tool calls
      </button>
    </div>
  );
}
