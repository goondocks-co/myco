import { useState, useMemo } from 'react';
import { cn } from '../../lib/cn';
import { MarkdownContent } from '../ui/markdown-content';
import { useSessionPlans, SessionPlanRow } from '../../hooks/use-sessions';
import { formatEpochAgo, formatEpochAbsolute } from '../../lib/format';

/* ---------- Constants ---------- */

/** Unicode up-arrow for expanded card toggle. */
const ARROW_UP = '\u25B2';

/** Unicode down-arrow for collapsed card toggle. */
const ARROW_DOWN = '\u25BC';

/* ---------- Helpers ---------- */

interface ChecklistProgress {
  total: number;
  checked: number;
}

/** Parse `- [x]` and `- [ ]` checklist items from markdown content. */
function parseChecklist(content: string): ChecklistProgress {
  const checked = (content.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (content.match(/- \[ \]/g) ?? []).length;
  return { total: checked + unchecked, checked };
}

/* ---------- Sub-components ---------- */

const PLAN_STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-500/10 text-green-500',
  completed: 'bg-blue-500/10 text-blue-500',
};

const PLAN_STATUS_DEFAULT_STYLE = 'bg-muted text-muted-foreground';

function PlanStatusBadge({ status }: { status: string }) {
  const classes = cn(
    'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
    PLAN_STATUS_STYLES[status] ?? PLAN_STATUS_DEFAULT_STYLE,
  );
  return <span className={classes}>{status}</span>;
}

interface PlanCardProps {
  plan: SessionPlanRow;
}

function PlanCard({ plan }: PlanCardProps) {
  const [expanded, setExpanded] = useState(false);

  const checklist = useMemo(
    () => plan.content ? parseChecklist(plan.content) : null,
    [plan.content],
  );
  const hasChecklist = checklist !== null && checklist.total > 0;
  const progressPct = hasChecklist ? Math.round((checklist!.checked / checklist!.total) * 100) : 0;

  return (
    <div className="rounded-lg border border-border bg-muted/50 overflow-hidden">
      {/* Card header */}
      <div className="flex items-start gap-3 p-4">
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <PlanStatusBadge status={plan.status} />
            {plan.title && (
              <span className="font-sans text-sm font-medium text-on-surface truncate">
                {plan.title}
              </span>
            )}
          </div>

          {plan.source_path && (
            <p className="font-mono text-xs text-muted-foreground truncate" title={plan.source_path}>
              {plan.source_path}
            </p>
          )}

          <div className="flex gap-3 font-sans text-xs text-muted-foreground">
            <span>Created {formatEpochAgo(plan.created_at)}</span>
            {plan.updated_at && plan.updated_at !== plan.created_at && (
              <span title={formatEpochAbsolute(plan.updated_at)}>
                Updated {formatEpochAgo(plan.updated_at)}
              </span>
            )}
          </div>

          {/* Checklist progress bar */}
          {hasChecklist && (
            <div className="space-y-1 pt-0.5">
              <div className="flex items-center justify-between font-sans text-xs text-muted-foreground">
                <span>{checklist!.checked}/{checklist!.total} items</span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-border overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Expand toggle */}
        {plan.content && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="shrink-0 mt-0.5 text-xs text-muted-foreground hover:text-on-surface transition-colors cursor-pointer"
            aria-label={expanded ? 'Collapse plan' : 'Expand plan'}
          >
            {expanded ? ARROW_UP : ARROW_DOWN}
          </button>
        )}
      </div>

      {/* Expanded content */}
      {expanded && plan.content && (
        <div className="border-t border-border px-4 py-3">
          <MarkdownContent content={plan.content} className="text-sm" />
        </div>
      )}
    </div>
  );
}

/* ---------- Component ---------- */

export interface SessionPlansProps {
  sessionId: string;
}

export function SessionPlans({ sessionId }: SessionPlansProps) {
  const { data: plans, isLoading, isError } = useSessionPlans(sessionId);

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <span className="font-sans text-sm text-muted-foreground">Loading plans...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-32 items-center justify-center">
        <span className="font-sans text-sm text-muted-foreground">Failed to load plans.</span>
      </div>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-border bg-muted/30">
        <span className="font-sans text-sm text-muted-foreground">No plans captured for this session</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {plans.map(plan => (
        <PlanCard key={plan.id} plan={plan} />
      ))}
    </div>
  );
}
