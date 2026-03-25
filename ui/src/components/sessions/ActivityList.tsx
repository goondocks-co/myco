import { useState } from 'react';
import { CheckCircle2, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useBatchActivities, type ActivityRow } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';

/* ---------- Helpers ---------- */

import { formatDurationMs as formatDuration } from '../../lib/format';

/* ---------- Sub-components ---------- */

function ActivityItem({ activity }: { activity: ActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  const succeeded = activity.success === 1;

  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/40 transition-colors"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-xs font-medium text-foreground">
          {activity.tool_name}
        </span>
        {activity.file_path && (
          <span className="truncate text-xs text-muted-foreground flex-1">
            {activity.file_path}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground font-mono">
          {formatDuration(activity.duration_ms)}
        </span>
        {succeeded ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        )}
      </button>

      {expanded && (
        <div className="px-8 pb-3 space-y-2">
          {activity.tool_input && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Input</div>
              <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {activity.tool_input}
              </pre>
            </div>
          )}
          {activity.tool_output_summary && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Output</div>
              <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {activity.tool_output_summary}
              </pre>
            </div>
          )}
          {activity.error_message && (
            <div>
              <div className="text-xs font-medium text-destructive mb-1">Error</div>
              <pre className="text-xs bg-destructive/10 text-destructive rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
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
      <div className="px-3 py-2 text-xs text-muted-foreground">No tool calls recorded</div>
    );
  }

  if (!loaded) {
    return (
      <button
        type="button"
        className="w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors text-left"
        onClick={() => setLoaded(true)}
      >
        Load {activityCount} tool call{activityCount !== 1 ? 's' : ''}...
      </button>
    );
  }

  if (isLoading) {
    return (
      <div className="px-3 py-2 space-y-1">
        {Array.from({ length: Math.min(activityCount, 3) }).map((_, i) => (
          <div key={i} className="h-3 animate-pulse rounded bg-muted w-full" />
        ))}
      </div>
    );
  }

  const activities = data ?? [];

  return (
    <div className={cn('border-t border-border/60')}>
      {activities.map((activity) => (
        <ActivityItem key={activity.id} activity={activity} />
      ))}
    </div>
  );
}
