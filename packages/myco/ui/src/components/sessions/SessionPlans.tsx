import { useState, useMemo, useCallback } from 'react';
import { Trash2, Copy, Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import { MarkdownContent } from '../ui/markdown-content';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useDeletePlan, useSessionPlans, SessionPlanRow } from '../../hooks/use-sessions';
import { formatEpochAgo, formatEpochAbsolute } from '../../lib/format';
import { truncatePlanId } from './plan-id';

/* ---------- Constants ---------- */

/** Unicode up-arrow for expanded card toggle. */
const ARROW_UP = '▲';

/** Unicode down-arrow for collapsed card toggle. */
const ARROW_DOWN = '▼';

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

/**
 * Copyable plan ID. Shows a truncated id; copies the full id (the shareable
 * handle a symbiont passes to `myco_plans` op:"get" to pick the plan up in a
 * new session). Stops click propagation so copying never toggles the card.
 */
function CopyablePlanId({ planId }: { planId: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(planId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [planId]);

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onCopy(); }}
      title={`Copy plan ID: ${planId}`}
      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary transition-colors"
    >
      <span>{truncatePlanId(planId)}</span>
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

interface PlanCardProps {
  plan: SessionPlanRow;
  initialExpanded?: boolean;
  isDeleting?: boolean;
  onDelete?: (planId: string) => void;
}

function PlanCard({ plan, initialExpanded = false, isDeleting = false, onDelete }: PlanCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);

  const checklist = useMemo(
    () => plan.content ? parseChecklist(plan.content) : null,
    [plan.content],
  );
  const hasChecklist = checklist !== null && checklist.total > 0;
  const progressPct = hasChecklist ? Math.round((checklist!.checked / checklist!.total) * 100) : 0;

  const canExpand = Boolean(plan.content);
  const toggleExpanded = () => {
    if (canExpand) setExpanded(v => !v);
  };

  return (
    <div className="rounded-lg border border-border bg-muted/50 overflow-hidden">
      {/* Card header — clicking anywhere toggles expansion */}
      <div
        className={cn(
          'flex items-start gap-3 p-4',
          canExpand && 'cursor-pointer hover:bg-muted/70 transition-colors',
        )}
        onClick={canExpand ? toggleExpanded : undefined}
        onKeyDown={canExpand ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpanded();
          }
        } : undefined}
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? expanded : undefined}
      >
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

          <div className="flex items-center gap-3 font-sans text-xs text-muted-foreground">
            <CopyablePlanId planId={plan.id} />
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

        {/* Action buttons — stopPropagation so they don't trigger header toggle */}
        {(canExpand || onDelete) && (
          <div className="flex shrink-0 items-center gap-2">
            {onDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(plan.id);
                }}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors cursor-pointer disabled:opacity-50"
                disabled={isDeleting}
                aria-label="Delete plan"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            )}
            {canExpand && (
              <span
                className="mt-0.5 text-xs text-muted-foreground"
                aria-hidden="true"
              >
                {expanded ? ARROW_UP : ARROW_DOWN}
              </span>
            )}
          </div>
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
  expandedPlanId?: string | null;
}

export function SessionPlans({ sessionId, expandedPlanId }: SessionPlansProps) {
  const { data: plans, isLoading, isError } = useSessionPlans(sessionId);
  const deletePlan = useDeletePlan(sessionId);
  const [pendingDeletePlan, setPendingDeletePlan] = useState<SessionPlanRow | null>(null);

  async function handleConfirmDelete(): Promise<void> {
    if (!pendingDeletePlan) return;
    try {
      await deletePlan.mutateAsync(pendingDeletePlan.id);
      setPendingDeletePlan(null);
    } catch {
      // Leave dialog open on error; the banner below shows the failure.
      setPendingDeletePlan(null);
    }
  }

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
      {deletePlan.isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 font-sans text-sm text-destructive">
          Failed to delete plan.
        </div>
      )}
      {plans.map(plan => (
        <PlanCard
          key={plan.id}
          plan={plan}
          initialExpanded={plan.status === 'in_progress' || String(plan.id) === expandedPlanId}
          isDeleting={deletePlan.isPending && pendingDeletePlan?.id === plan.id}
          onDelete={() => setPendingDeletePlan(plan)}
        />
      ))}

      <ConfirmDialog
        open={pendingDeletePlan !== null}
        onOpenChange={(open) => { if (!open) setPendingDeletePlan(null); }}
        title="Delete Plan"
        description="This will permanently remove this captured plan from the session."
        icon={<Trash2 className="h-4 w-4 text-tertiary" />}
        meta={pendingDeletePlan ? [
          { label: 'Status', value: pendingDeletePlan.status },
          {
            label: 'Title',
            value: pendingDeletePlan.title || pendingDeletePlan.source_path || pendingDeletePlan.id,
          },
        ] : []}
        confirmLabel="Delete Plan"
        variant="destructive"
        onConfirm={handleConfirmDelete}
        isPending={deletePlan.isPending}
      />
    </div>
  );
}
